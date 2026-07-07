/**
 * routes/auth.js — register / login (public endpoints).
 */
'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { db, uid, now } = require('../db');
const { signToken, publicUser } = require('../auth');

const router = express.Router();

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
    role: 'user', // registrations are always plain users
    business_number: null,
    active: 1,
    created_at: now(),
  };
  db.prepare(`
    INSERT INTO users (id, name, email, password_hash, role, business_number, active, created_at)
    VALUES (@id, @name, @email, @password_hash, @role, @business_number, @active, @created_at)
  `).run(user);

  res.status(201).json({ token: signToken(user), user: publicUser(user) });
});

/** POST /api/auth/login {email,password} → {token,user} */
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

  res.json({ token: signToken(user), user: publicUser(user) });
});

module.exports = router;
