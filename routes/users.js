/**
 * routes/users.js — admin-only user management.
 * Mounted behind requireAuth + requireAdmin in server.js.
 */
'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { db, uid, now, encryptSecret, decryptSecret } = require('../db');

const router = express.Router();

/**
 * GET /api/users — all users with contact & open-task counts.
 * Admin-only route (see server.js), so it also returns each user's
 * decrypted password (per product decision) and 2FA state. Passwords set
 * before this feature shipped are unrecoverable (only the bcrypt hash exists);
 * those show as null and can be reset by the admin to become viewable.
 */
router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT u.id, u.name, u.email, u.role, u.business_number, u.active, u.created_at,
           u.password_enc, u.totp_enabled,
           (SELECT COUNT(*) FROM contacts c WHERE c.owner_id = u.id)            AS contact_count,
           (SELECT COUNT(*) FROM tasks t WHERE t.owner_id = u.id AND t.done = 0) AS open_task_count
    FROM users u
    ORDER BY u.created_at ASC
  `).all();
  res.json(rows.map((r) => {
    const { password_enc, ...rest } = r;
    return {
      ...rest,
      totp_enabled: r.totp_enabled ? 1 : 0,
      password: decryptSecret(password_enc), // null if unknown/legacy
    };
  }));
});

/** POST /api/users {name,email,password,role} */
router.post('/', (req, res) => {
  const { name, email, password, role } = req.body || {};
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'name, email and password are required' });
  }
  if (role && !['user', 'admin'].includes(role)) {
    return res.status(400).json({ error: "role must be 'user' or 'admin'" });
  }
  const normEmail = String(email).trim().toLowerCase();
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(normEmail)) {
    return res.status(409).json({ error: 'Email already registered' });
  }

  const user = {
    id: uid(),
    name: String(name).trim(),
    email: normEmail,
    password_hash: bcrypt.hashSync(String(password), 10),
    password_enc: encryptSecret(String(password)),
    role: role || 'user',
    business_number: (req.body || {}).business_number || null,
    active: 1,
    created_at: now(),
  };
  db.prepare(`
    INSERT INTO users (id, name, email, password_hash, password_enc, role, business_number, active, created_at)
    VALUES (@id, @name, @email, @password_hash, @password_enc, @role, @business_number, @active, @created_at)
  `).run(user);

  const { password_hash, password_enc, ...pub } = user; // never return the hash
  res.status(201).json({ ...pub, password: String(password) });
});

/** PATCH /api/users/:id {role?, active?, name?, business_number?} */
router.patch('/:id', (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });

  const body = req.body || {};
  const sets = [];
  const params = { id: target.id };

  if ('role' in body) {
    if (!['user', 'admin'].includes(body.role)) {
      return res.status(400).json({ error: "role must be 'user' or 'admin'" });
    }
    sets.push('role = @role');
    params.role = body.role;
  }
  if ('active' in body) { sets.push('active = @active'); params.active = body.active ? 1 : 0; }
  if ('name' in body) { sets.push('name = @name'); params.name = String(body.name); }
  if ('email' in body) {
    const normEmail = String(body.email || '').trim().toLowerCase();
    if (!normEmail) return res.status(400).json({ error: 'Email cannot be empty' });
    const clash = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(normEmail, target.id);
    if (clash) return res.status(409).json({ error: 'Email already in use by another user' });
    sets.push('email = @email'); params.email = normEmail;
  }
  if ('password' in body && body.password) {
    sets.push('password_hash = @password_hash');
    params.password_hash = bcrypt.hashSync(String(body.password), 10);
    sets.push('password_enc = @password_enc');
    params.password_enc = encryptSecret(String(body.password));
  }
  if ('business_number' in body) {
    sets.push('business_number = @business_number');
    params.business_number = body.business_number || null;
  }
  if (sets.length === 0) return res.status(400).json({ error: 'No updatable fields supplied' });

  // Safety: don't let an admin deactivate or demote themselves.
  if (target.id === req.user.id && (('active' in body && !body.active) || ('role' in body && body.role !== 'admin'))) {
    return res.status(400).json({ error: 'Cannot demote or deactivate your own account' });
  }

  db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = @id`).run(params);
  const updated = db.prepare(
    'SELECT id, name, email, role, business_number, active, created_at FROM users WHERE id = ?'
  ).get(target.id);
  res.json(updated);
});

/**
 * POST /api/users/:id/2fa-reset — clear a user's 2FA (e.g. they lost their
 * phone). They'll be able to log in with just their password, and (if admin)
 * will be prompted to re-enroll.
 */
router.post('/:id/2fa-reset', (req, res) => {
  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?').run(target.id);
  res.json({ ok: true, id: target.id, totp_enabled: 0 });
});

/**
 * DELETE /api/users/:id — permanently remove a user. To avoid losing data, the
 * user's contacts, tasks and activity are reassigned to the requesting admin,
 * and their Google/Microsoft tokens are cleared, before the row is deleted.
 * Guards: cannot delete your own account or the only remaining admin.
 */
router.delete('/:id', (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.id === req.user.id) {
    return res.status(400).json({ error: 'Cannot delete your own account' });
  }
  if (target.role === 'admin') {
    const admins = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n;
    if (admins <= 1) return res.status(400).json({ error: 'Cannot delete the only admin account' });
  }

  const newOwner = req.user.id; // reassign everything the user owns to the requester
  try {
    db.prepare('UPDATE contacts   SET owner_id = ? WHERE owner_id = ?').run(newOwner, target.id);
    db.prepare('UPDATE tasks      SET owner_id = ? WHERE owner_id = ?').run(newOwner, target.id);
    db.prepare('UPDATE activities SET owner_id = ? WHERE owner_id = ?').run(newOwner, target.id);
    db.prepare('DELETE FROM google_accounts    WHERE user_id = ?').run(target.id);
    db.prepare('DELETE FROM microsoft_accounts WHERE user_id = ?').run(target.id);
    db.prepare('UPDATE settings SET value = NULL WHERE value = ?').run(target.id); // e.g. lead auto-assign
    db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
  } catch (e) {
    return res.status(500).json({ error: 'Could not delete user: ' + e.message });
  }
  res.json({ ok: true, deleted: target.id, reassignedTo: newOwner });
});

module.exports = router;
