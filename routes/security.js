/**
 * routes/security.js — per-user account security (mounted at /api, requireAuth).
 *
 *   Self-service password change:   POST /api/account/password
 *   Two-factor (TOTP) enrollment:   POST /api/account/2fa/setup
 *                                   POST /api/account/2fa/enable
 *                                   POST /api/account/2fa/disable
 *                                   GET  /api/account/2fa/status
 *
 * 2FA policy: REQUIRED for admins (status.required = true), OPTIONAL for users.
 * The bcrypt password_hash is what logins verify; we additionally keep an
 * AES-encrypted password_enc so an admin can reveal it (per product decision).
 */
'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const speakeasy = require('speakeasy');
const qrcode = require('qrcode');
const { db, now, encryptSecret } = require('../db');

const router = express.Router();

const ISSUER = 'Deal Flow Pro';

/** Load the full user row (with hashes/secrets) for the authenticated user. */
function fullUser(req) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
}

// ---------------------------------------------------------------------------
// Self-service password change
// ---------------------------------------------------------------------------

/** POST /api/account/password {currentPassword, newPassword} */
router.post('/account/password', (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'currentPassword and newPassword are required' });
  }
  if (String(newPassword).length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }
  const u = fullUser(req);
  if (!u || !bcrypt.compareSync(String(currentPassword), u.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  db.prepare('UPDATE users SET password_hash = ?, password_enc = ? WHERE id = ?')
    .run(bcrypt.hashSync(String(newPassword), 10), encryptSecret(String(newPassword)), u.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Two-factor authentication (TOTP)
// ---------------------------------------------------------------------------

/** GET /api/account/2fa/status → {enabled, required}. */
router.get('/account/2fa/status', (req, res) => {
  const u = fullUser(req);
  res.json({
    enabled: !!(u && u.totp_enabled),
    required: !!(u && u.role === 'admin'),
  });
});

/**
 * POST /api/account/2fa/setup → generate a fresh secret + QR code.
 * Stores the secret with totp_enabled=0 (unconfirmed) until /enable verifies it.
 */
router.post('/account/2fa/setup', async (req, res) => {
  const u = fullUser(req);
  if (!u) return res.status(404).json({ error: 'User not found' });
  const secret = speakeasy.generateSecret({
    name: `${ISSUER} (${u.email})`,
    issuer: ISSUER,
    length: 20,
  });
  db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?')
    .run(secret.base32, u.id);
  let qrDataUrl = null;
  try { qrDataUrl = await qrcode.toDataURL(secret.otpauth_url); } catch (e) { /* fall back to manual entry */ }
  res.json({ secret: secret.base32, otpauth: secret.otpauth_url, qr: qrDataUrl });
});

/** POST /api/account/2fa/enable {code} → verify a code and turn 2FA on. */
router.post('/account/2fa/enable', (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: 'code is required' });
  const u = fullUser(req);
  if (!u || !u.totp_secret) {
    return res.status(400).json({ error: 'Start setup first' });
  }
  const ok = speakeasy.totp.verify({
    secret: u.totp_secret, encoding: 'base32', token: String(code).replace(/\s+/g, ''), window: 1,
  });
  if (!ok) return res.status(400).json({ error: 'That code is not valid. Check the app and try again.' });
  db.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').run(u.id);
  res.json({ ok: true, enabled: true });
});

/**
 * POST /api/account/2fa/disable {code|password} → turn 2FA off.
 * Admins may disable (e.g. to switch devices) but they'll be prompted to
 * re-enroll, since 2FA is required for their role.
 */
router.post('/account/2fa/disable', (req, res) => {
  const { code, password } = req.body || {};
  const u = fullUser(req);
  if (!u) return res.status(404).json({ error: 'User not found' });
  if (!u.totp_enabled) return res.json({ ok: true, enabled: false });

  let verified = false;
  if (code && u.totp_secret) {
    verified = speakeasy.totp.verify({
      secret: u.totp_secret, encoding: 'base32', token: String(code).replace(/\s+/g, ''), window: 1,
    });
  }
  if (!verified && password) {
    verified = bcrypt.compareSync(String(password), u.password_hash);
  }
  if (!verified) {
    return res.status(400).json({ error: 'Enter a valid 2FA code or your password to turn it off' });
  }
  db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?').run(u.id);
  res.json({ ok: true, enabled: false });
});

module.exports = router;
