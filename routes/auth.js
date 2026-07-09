/**
 * routes/auth.js — register / login (public endpoints), with optional 2FA.
 */
'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const speakeasy = require('speakeasy');
const { db, uid, now, encryptSecret } = require('../db');
const { signToken, publicUser, JWT_SECRET } = require('../auth');

const router = express.Router();

/** Build the standard success payload, flagging admins who still owe 2FA setup. */
function loginSuccess(user) {
  return {
    token: signToken(user),
    user: publicUser(user),
    // Admins are REQUIRED to use 2FA — the frontend forces enrollment when true.
    require2faSetup: user.role === 'admin' && !user.totp_enabled,
  };
}

/** POST /api/auth/register {name,email,password} → {token,user} */
router.post('/register', (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'name, email and password are required' });
  }
  const normEmail = String(email).trim().toLowerCase();
  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(normEmail);
  if (exists) return res.status(409).json({ error: 'Email already registered' });

  const user = {
    id: uid(),
    name: String(name).trim(),
    email: normEmail,
    password_hash: bcrypt.hashSync(String(password), 10),
    password_enc: encryptSecret(String(password)),
    role: 'user', // registrations are always plain users
    business_number: null,
    active: 1,
    created_at: now(),
  };
  db.prepare(`
    INSERT INTO users (id, name, email, password_hash, password_enc, role, business_number, active, created_at)
    VALUES (@id, @name, @email, @password_hash, @password_enc, @role, @business_number, @active, @created_at)
  `).run(user);

  res.status(201).json(loginSuccess(user));
});

/**
 * POST /api/auth/login {email,password}
 *   → {token,user,require2faSetup}                 when 2FA is not enabled
 *   → {twofaRequired:true, ticket}                 when the user has 2FA on
 */
router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }
  const user = db
    .prepare('SELECT * FROM users WHERE email = ?')
    .get(String(email).trim().toLowerCase());

  if (!user || !bcrypt.compareSync(String(password), user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  if (!user.active) return res.status(403).json({ error: 'Account deactivated' });

  // 2FA gate: password was right, but a code is still required.
  if (user.totp_enabled) {
    const ticket = jwt.sign({ id: user.id, stage: '2fa' }, JWT_SECRET, { expiresIn: '5m' });
    return res.json({ twofaRequired: true, ticket });
  }

  res.json(loginSuccess(user));
});

/** POST /api/auth/login/2fa {ticket, code} → {token,user} */
router.post('/login/2fa', (req, res) => {
  const { ticket, code } = req.body || {};
  if (!ticket || !code) return res.status(400).json({ error: 'ticket and code are required' });

  let payload;
  try { payload = jwt.verify(ticket, JWT_SECRET); }
  catch (e) { return res.status(401).json({ error: 'Your login session expired — sign in again' }); }
  if (!payload || payload.stage !== '2fa') {
    return res.status(400).json({ error: 'Invalid login ticket' });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.id);
  if (!user || !user.active) return res.status(401).json({ error: 'Account unavailable' });
  if (!user.totp_enabled || !user.totp_secret) {
    // 2FA was turned off in the meantime — just log them in.
    return res.json(loginSuccess(user));
  }

  const ok = speakeasy.totp.verify({
    secret: user.totp_secret, encoding: 'base32', token: String(code).replace(/\s+/g, ''), window: 1,
  });
  if (!ok) return res.status(401).json({ error: 'That 2FA code is not valid' });

  res.json(loginSuccess(user));
});

module.exports = router;
