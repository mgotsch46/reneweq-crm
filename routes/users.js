/**
 * routes/users.js — admin-only user management.
 * Mounted behind requireAuth + requireAdmin in server.js.
 */
'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { db, uid, now } = require('../db');

const router = express.Router();

/** GET /api/users — all users with contact & open-task counts (no hashes). */
router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT u.id, u.name, u.email, u.role, u.business_number, u.active, u.created_at,
           (SELECT COUNT(*) FROM contacts c WHERE c.owner_id = u.id)            AS contact_count,
           (SELECT COUNT(*) FROM tasks t WHERE t.owner_id = u.id AND t.done = 0) AS open_task_count
    FROM users u
    ORDER BY u.created_at ASC
  `).all();
  res.json(rows);
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
    role: role || 'user',
    business_number: (req.body || {}).business_number || null,
    active: 1,
    created_at: now(),
  };
  db.prepare(`
    INSERT INTO users (id, name, email, password_hash, role, business_number, active, created_at)
    VALUES (@id, @name, @email, @password_hash, @role, @business_number, @active, @created_at)
  `).run(user);

  const { password_hash, ...pub } = user; // never return the hash
  res.status(201).json(pub);
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

module.exports = router;
