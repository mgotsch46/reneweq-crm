/**
 * auth.js — JWT sign/verify middleware.
 *
 * Tokens carry { id, role }. requireAuth re-loads the user from the DB on
 * every request so deactivated users / role changes take effect immediately.
 */
'use strict';

const jwt = require('jsonwebtoken');
const { db } = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'change-me';

/** Sign a JWT for a user row. Payload contains only { id, role }. */
function signToken(user) {
  return jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
}

/** Strip sensitive fields before sending a user object to the client. */
function publicUser(user) {
  if (!user) return null;
  const { password_hash, ...rest } = user; // never return password_hash
  return rest;
}

/**
 * requireAuth — verifies the Bearer token and sets req.user (fresh from DB).
 */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing Bearer token' });

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.id);
  if (!user || !user.active) {
    return res.status(401).json({ error: 'User not found or deactivated' });
  }

  req.user = publicUser(user); // { id, name, email, role, ... } — no hash
  next();
}

/** requireAdmin — must run after requireAuth. */
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

module.exports = { signToken, requireAuth, requireAdmin, publicUser, JWT_SECRET };
