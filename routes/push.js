/**
 * routes/push.js — Web Push (PWA notifications) via VAPID.
 *
 *   GET  /api/push/key         → VAPID public key (or null if unconfigured)
 *   POST /api/push/subscribe   → save this device's push subscription
 *   POST /api/push/unsubscribe → drop a subscription by endpoint
 *
 * sendPushToUser(userId, payload) delivers a push to all of a user's devices;
 * stale subscriptions (404/410) are pruned automatically. Requires env vars
 * VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY (generate with `web-push generate-vapid-keys`).
 */
'use strict';

const express = require('express');
const webpush = require('web-push');
const { db, uid, now } = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:support@reneweqllc.com';

let configured = false;
if (VAPID_PUBLIC && VAPID_PRIVATE) {
  try { webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE); configured = true; }
  catch (e) { console.error('[push] VAPID setup failed:', e.message); }
}

function pushConfigured() { return configured; }

/** Count a user's unread inbound activity (texts + voicemails + calls). */
function unreadInboxCount(userId) {
  try {
    const r = db.prepare(
      "SELECT COUNT(*) AS n FROM activities WHERE owner_id = ? AND direction = 'inbound' AND type IN ('sms','rvm','call') AND read_at IS NULL"
    ).get(userId);
    return r ? r.n : 0;
  } catch (e) { return 0; }
}

router.get('/key', requireAuth, (req, res) => res.json({ key: configured ? VAPID_PUBLIC : null }));

router.post('/subscribe', requireAuth, (req, res) => {
  const sub = (req.body && req.body.subscription) ? req.body.subscription : req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: 'subscription required' });
  const existing = db.prepare('SELECT id FROM push_subscriptions WHERE endpoint = ?').get(sub.endpoint);
  if (existing) {
    db.prepare('UPDATE push_subscriptions SET user_id = ?, sub = ?, created_at = ? WHERE endpoint = ?')
      .run(req.user.id, JSON.stringify(sub), now(), sub.endpoint);
  } else {
    db.prepare('INSERT INTO push_subscriptions (id, user_id, endpoint, sub, created_at) VALUES (?,?,?,?,?)')
      .run(uid(), req.user.id, sub.endpoint, JSON.stringify(sub), now());
  }
  res.status(201).json({ ok: true });
});

router.post('/unsubscribe', requireAuth, (req, res) => {
  const ep = req.body && req.body.endpoint;
  if (ep) db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(ep);
  res.json({ ok: true });
});

/** Deliver a push to every device a user has registered. Never throws. */
async function sendPushToUser(userId, payload) {
  if (!configured) return;
  let subs;
  try { subs = db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId); }
  catch (e) { return; }
  if (!subs || !subs.length) return;
  // Attach the current unread count so the service worker can set the app badge.
  const body = JSON.stringify(Object.assign({ badge: unreadInboxCount(userId) }, payload || {}));
  for (const row of subs) {
    let sub;
    try { sub = JSON.parse(row.sub); } catch (e) { continue; }
    try { await webpush.sendNotification(sub, body); }
    catch (err) {
      const code = err && err.statusCode;
      if (code === 404 || code === 410) { try { db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(row.id); } catch (e) {} }
      else console.error('[push] send failed:', err && err.message);
    }
  }
}

module.exports = router;
module.exports.sendPushToUser = sendPushToUser;
module.exports.pushConfigured = pushConfigured;
module.exports.unreadInboxCount = unreadInboxCount;
