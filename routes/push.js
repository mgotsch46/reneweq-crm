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

// ---------------------------------------------------------------------------
// Native push (Android/iOS) via Firebase Cloud Messaging.
// Activates only when FIREBASE_SERVICE_ACCOUNT (the Firebase Admin service
// account JSON) is present as an env var. Safe no-op otherwise.
// ---------------------------------------------------------------------------
let admin = null;
let fcmReady = false;
try { admin = require('firebase-admin'); } catch (e) { /* dep not installed yet */ }

if (admin && process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    const svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    if (!admin.apps.length) {
      admin.initializeApp({ credential: admin.credential.cert(svc) });
    }
    fcmReady = true;
    console.log('[push] Firebase native push: live');
  } catch (e) {
    console.error('[push] Firebase init failed:', e.message);
  }
} else {
  console.log('[push] Firebase native push: not configured (set FIREBASE_SERVICE_ACCOUNT to enable)');
}

function fcmConfigured() { return fcmReady; }

/**
 * Deliver a push to every native (Android/iOS) device a user has registered.
 *
 * Optional payload keys for a DISTINCT notification sound (used by inbound
 * texts): `sound` — base file name without extension. iOS plays
 * "<sound>.caf" bundled in the app; Android plays res/raw/<sound> via the
 * notification channel named by `channelId` (the channel's sound wins on
 * Android 8+, but we set both for older devices). Omit both keys for the
 * default system sound — exactly the old behavior.
 */
async function sendFcmToUser(userId, payload, badge) {
  if (!fcmReady) return;
  let rows;
  try { rows = db.prepare('SELECT * FROM native_push_tokens WHERE user_id = ?').all(userId); }
  catch (e) { return; }
  if (!rows || !rows.length) return;
  const sound = (payload && payload.sound) ? String(payload.sound) : '';
  const androidNotif = { notificationCount: badge || 0 };
  if (sound) {
    androidNotif.sound = sound; // res/raw/<sound> (pre-Android 8 fallback)
    androidNotif.channelId = (payload && payload.channelId) || 'crm_texts';
  } else {
    androidNotif.defaultSound = true;
  }
  for (const row of rows) {
    const msg = {
      token: row.token,
      notification: { title: payload.title || 'RenewEQ CRM', body: payload.body || '' },
      data: {
        url: String((payload && payload.url) || '/'),
        badge: String(badge || 0),
      },
      android: {
        priority: 'high',
        notification: androidNotif,
      },
      apns: { payload: { aps: { badge: badge || 0, sound: sound ? sound + '.caf' : 'default' } } },
    };
    try {
      await admin.messaging().send(msg);
    } catch (err) {
      const code = err && (err.errorInfo && err.errorInfo.code || err.code) || '';
      // Drop tokens that Firebase reports as permanently invalid.
      if (String(code).includes('registration-token-not-registered') ||
          String(code).includes('invalid-registration-token') ||
          String(code).includes('invalid-argument')) {
        try { db.prepare('DELETE FROM native_push_tokens WHERE id = ?').run(row.id); } catch (e) {}
      } else {
        console.error('[push] FCM send failed:', err && err.message);
      }
    }
  }
}

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

// Register / drop a native (Android/iOS) FCM device token.
router.post('/native-register', requireAuth, (req, res) => {
  const token = req.body && (req.body.token || req.body.value);
  const platform = (req.body && req.body.platform) || 'android';
  if (!token) return res.status(400).json({ error: 'token required' });
  const existing = db.prepare('SELECT id FROM native_push_tokens WHERE token = ?').get(token);
  if (existing) {
    db.prepare('UPDATE native_push_tokens SET user_id = ?, platform = ?, created_at = ? WHERE token = ?')
      .run(req.user.id, platform, now(), token);
  } else {
    db.prepare('INSERT INTO native_push_tokens (id, user_id, token, platform, created_at) VALUES (?,?,?,?,?)')
      .run(uid(), req.user.id, token, platform, now());
  }
  res.status(201).json({ ok: true });
});

router.post('/native-unregister', requireAuth, (req, res) => {
  const token = req.body && req.body.token;
  if (token) db.prepare('DELETE FROM native_push_tokens WHERE token = ?').run(token);
  res.json({ ok: true });
});

/** Deliver a push to every device a user has registered. Never throws. */
async function sendPushToUser(userId, payload) {
  const badge = unreadInboxCount(userId);
  // Web push (PWA / desktop browsers) via VAPID.
  if (configured) {
    let subs;
    try { subs = db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId); }
    catch (e) { subs = null; }
    if (subs && subs.length) {
      const body = JSON.stringify(Object.assign({ badge }, payload || {}));
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
  }
  // Native push (Android/iOS) via Firebase Cloud Messaging.
  try { await sendFcmToUser(userId, payload || {}, badge); } catch (e) {}
}

module.exports = router;
module.exports.sendPushToUser = sendPushToUser;
module.exports.pushConfigured = pushConfigured;
module.exports.fcmConfigured = fcmConfigured;
module.exports.unreadInboxCount = unreadInboxCount;
