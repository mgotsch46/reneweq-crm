/**
 * routes/twilio.js — in-browser softphone (Twilio Voice) + SMS.
 *
 * Uses ONLY built-in fetch + jsonwebtoken (no twilio SDK dependency).
 *  - GET  /api/twilio/token          (auth)   → Voice Access Token for the browser client
 *  - POST /api/twilio/voice          (webhook)→ TwiML for OUTBOUND browser→PSTN calls (TwiML App URL)
 *  - POST /api/twilio/voice-inbound  (webhook)→ TwiML for INBOUND PSTN→browser calls (number's Voice URL)
 *  - POST /api/twilio/sms            (auth)   → send an SMS and log it to the contact
 *  - POST /api/twilio/sms-inbound    (webhook)→ log an inbound SMS to the matching contact
 *  - GET  /api/twilio/status         (auth)   → {voiceConfigured, smsConfigured, from}
 *
 * Webhook routes carry no Bearer token (Twilio calls them directly), so they
 * are mounted WITHOUT requireAuth in server.js; the token/sms routes apply
 * requireAuth themselves below.
 */
'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const { db, uid, now, DATA_DIR, getSetting } = require('../db');
const { requireAuth } = require('../auth');
const { sendSms } = require('../integrations');

const router = express.Router();

const VM_DIR = path.join(DATA_DIR, 'uploads', 'rvm'); // shared with routes/rvm.js audio store

// Web push (optional) — defensive so a push/module issue never breaks webhooks.
let sendPushToUser = function () {};
try { sendPushToUser = require('./push').sendPushToUser; } catch (e) { /* push not available */ }

const ACCOUNT_SID = () => process.env.TWILIO_ACCOUNT_SID || '';
const API_KEY_SID = () => process.env.TWILIO_API_KEY_SID || '';
const API_KEY_SECRET = () => process.env.TWILIO_API_KEY_SECRET || '';
const TWIML_APP_SID = () => process.env.TWILIO_TWIML_APP_SID || '';
const FROM_NUMBER = () => process.env.TWILIO_FROM || process.env.TWILIO_FROM_NUMBER || '';

/** Voice (softphone) is usable only with an API key + TwiML app. */
function voiceConfigured() {
  return Boolean(ACCOUNT_SID() && API_KEY_SID() && API_KEY_SECRET() && TWIML_APP_SID());
}
/**
 * SMS send is usable with the account auth token + SOME from number — either the
 * shared TWILIO_FROM or (for a specific user) their own assigned sending_number.
 */
function smsConfigured(userId) {
  if (!(ACCOUNT_SID() && process.env.TWILIO_AUTH_TOKEN)) return false;
  if (FROM_NUMBER()) return true;
  if (userId) {
    try {
      const u = db.prepare('SELECT sending_number FROM users WHERE id = ?').get(userId);
      if (u && u.sending_number) return true;
    } catch (e) {}
  }
  // Configured if ANY user has their own number (so the feature shows as available).
  try {
    const n = db.prepare("SELECT COUNT(*) AS c FROM users WHERE sending_number IS NOT NULL AND sending_number != ''").get();
    return !!(n && n.c > 0);
  } catch (e) {}
  return false;
}

/** Client identity for a CRM user (safe chars only). */
function identityFor(userId) {
  return 'crm_' + String(userId).replace(/[^a-zA-Z0-9_]/g, '');
}

/** Build a Twilio Voice Access Token (JWT) — same shape the Twilio SDK emits. */
function buildVoiceToken(identity) {
  const nowSec = Math.floor(Date.now() / 1000);
  const payload = {
    jti: `${API_KEY_SID()}-${nowSec}`,
    iss: API_KEY_SID(),
    sub: ACCOUNT_SID(),
    nbf: nowSec,
    exp: nowSec + 3600, // 1 hour
    grants: {
      identity,
      voice: {
        incoming: { allow: true },
        outgoing: { application_sid: TWIML_APP_SID() },
      },
    },
  };
  return jwt.sign(payload, API_KEY_SECRET(), {
    algorithm: 'HS256',
    header: { cty: 'twilio-fpa;v=1', typ: 'JWT' },
  });
}

/** Escape XML text for TwiML. */
function xmlEscape(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** Normalize a phone number to E.164-ish (keep leading +, strip other non-digits). */
function normPhone(p) {
  const s = String(p || '').trim();
  if (!s) return '';
  const plus = s.startsWith('+');
  const digits = s.replace(/[^0-9]/g, '');
  if (!digits) return '';
  if (plus) return '+' + digits;
  if (digits.length === 10) return '+1' + digits; // assume US 10-digit
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  return '+' + digits;
}

/** The base URL of this app (for webhook config). */
function appBaseUrl() {
  return (process.env.APP_BASE_URL || 'https://www.dealflowpro.net').replace(/\/+$/, '');
}

/** The Twilio number a given user sends from — their own, else the shared one. */
function userNumber(userId) {
  try {
    const u = userId ? db.prepare('SELECT sending_number FROM users WHERE id = ?').get(userId) : null;
    if (u && u.sending_number) return u.sending_number;
  } catch (e) {}
  return FROM_NUMBER();
}

/**
 * Extract a CRM user id from a Twilio Voice `Caller` like "client:crm_<identity>".
 * The client identity strips non-alphanumerics from the user id (identityFor),
 * so we can't reverse it directly — instead we match each user's identityFor(id)
 * against the caller's identity to recover the real (dashed) user id.
 */
function userIdFromCaller(caller) {
  const m = String(caller || '').match(/client:(.+)$/);
  if (!m) return null;
  const ident = m[1];
  try {
    const rows = db.prepare('SELECT id FROM users').all();
    for (const r of rows) {
      if (identityFor(r.id) === ident) return r.id;
    }
  } catch (e) {}
  return null;
}

/** Find the user who owns a given CRM number (matches trailing 10 digits). */
function userByNumber(num) {
  const digits = String(num || '').replace(/[^0-9]/g, '');
  if (digits.length < 7) return null;
  const last10 = digits.slice(-10);
  try {
    const full = db.prepare("SELECT id, name, sending_number FROM users WHERE sending_number IS NOT NULL AND sending_number != '' AND active = 1").all();
    for (const r of full) {
      if (String(r.sending_number).replace(/[^0-9]/g, '').slice(-10) === last10) return r;
    }
  } catch (e) {}
  return null;
}

/** Twilio REST helper (Basic auth with the account SID + auth token). */
async function twilioRest(method, urlPath, form) {
  const sid = ACCOUNT_SID();
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) throw new Error('Twilio account is not configured');
  const auth = Buffer.from(`${sid}:${token}`).toString('base64');
  const opts = { method, headers: { Authorization: `Basic ${auth}` } };
  if (form) {
    opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    opts.body = new URLSearchParams(form).toString();
  }
  const r = await fetch('https://api.twilio.com/2010-04-01/Accounts/' + sid + urlPath, opts);
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch (e) {}
  if (!r.ok) throw new Error((json && json.message) || ('Twilio API error ' + r.status));
  return json;
}

/** List every phone number owned by the Twilio account. */
async function listAccountNumbers() {
  const out = [];
  let pageUrl = '/IncomingPhoneNumbers.json?PageSize=100';
  for (let i = 0; i < 10 && pageUrl; i++) {
    const j = await twilioRest('GET', pageUrl);
    (j.incoming_phone_numbers || []).forEach(function (n) {
      out.push({ sid: n.sid, phoneNumber: n.phone_number, friendlyName: n.friendly_name });
    });
    pageUrl = j.next_page_uri ? j.next_page_uri.replace('/2010-04-01/Accounts/' + ACCOUNT_SID(), '') : null;
  }
  return out;
}

/** Point a number's SMS + Voice webhooks at this CRM (so replies route in). */
async function configureNumberWebhooks(numberSid) {
  const base = appBaseUrl();
  return twilioRest('POST', '/IncomingPhoneNumbers/' + numberSid + '.json', {
    SmsUrl: base + '/api/twilio/sms-inbound', SmsMethod: 'POST',
    VoiceUrl: base + '/api/twilio/voice-inbound', VoiceMethod: 'POST',
  });
}

/** Find a contact whose phone matches the given number (by trailing 10 digits). */
function findContactByPhone(num) {
  const digits = String(num || '').replace(/[^0-9]/g, '');
  if (digits.length < 7) return null;
  const last10 = digits.slice(-10);
  // SQLite: compare the numeric tail of the stored phone.
  const rows = db.prepare("SELECT id, owner_id, phone FROM contacts WHERE phone IS NOT NULL AND phone != ''").all();
  for (const r of rows) {
    const rd = String(r.phone).replace(/[^0-9]/g, '');
    if (rd.slice(-10) === last10) return r;
  }
  return null;
}

/** Log an activity row directly (used by inbound webhooks). */
function logActivity({ contactId, ownerId, type, direction, body, status, providerId, createdBy }) {
  db.prepare(`
    INSERT INTO activities (id, contact_id, owner_id, type, mode, direction, body, status, provider_id, created_by, created_at)
    VALUES (@id, @contact_id, @owner_id, @type, 'automated', @direction, @body, @status, @provider_id, @created_by, @created_at)
  `).run({
    id: uid(),
    contact_id: contactId,
    owner_id: ownerId,
    type,
    direction,
    body: body || null,
    status: status || null,
    provider_id: providerId || null,
    created_by: createdBy || ownerId,
    created_at: now(),
  });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** GET /api/twilio/status — what's configured (for the frontend). */
router.get('/status', requireAuth, (req, res) => {
  let mine = null;
  try {
    const u = db.prepare('SELECT sending_number FROM users WHERE id = ?').get(req.user.id);
    mine = (u && u.sending_number) || null;
  } catch (e) {}
  res.json({
    voiceConfigured: voiceConfigured(),
    smsConfigured: smsConfigured(req.user.id),
    from: mine || FROM_NUMBER() || null,
    myNumber: mine,
    sharedNumber: FROM_NUMBER() || null,
    poolAvailable: Boolean(ACCOUNT_SID() && process.env.TWILIO_AUTH_TOKEN),
  });
});

// ---------------------------------------------------------------------------
// Per-user number pool: admin pre-buys numbers in Twilio; each user self-claims
// one here. Claiming assigns it and auto-points its webhooks back at this CRM.
// ---------------------------------------------------------------------------

/** GET /api/twilio/numbers — the account's numbers with who has claimed each. */
router.get('/numbers', requireAuth, async (req, res) => {
  if (!(ACCOUNT_SID() && process.env.TWILIO_AUTH_TOKEN)) {
    return res.status(400).json({ error: 'Twilio account is not configured on this server' });
  }
  try {
    const nums = await listAccountNumbers();
    const claims = db.prepare("SELECT id, name, sending_number FROM users WHERE sending_number IS NOT NULL AND sending_number != ''").all();
    const byTail = {};
    claims.forEach(function (u) { byTail[String(u.sending_number).replace(/[^0-9]/g, '').slice(-10)] = u; });
    const out = nums.map(function (n) {
      const owner = byTail[String(n.phoneNumber).replace(/[^0-9]/g, '').slice(-10)] || null;
      return {
        sid: n.sid, phoneNumber: n.phoneNumber, friendlyName: n.friendlyName,
        claimedBy: owner ? { id: owner.id, name: owner.name } : null,
        mine: !!(owner && owner.id === req.user.id),
      };
    });
    let myNumber = null;
    try { const u = db.prepare('SELECT sending_number FROM users WHERE id = ?').get(req.user.id); myNumber = (u && u.sending_number) || null; } catch (e) {}
    res.json({ numbers: out, myNumber });
  } catch (e) {
    res.status(502).json({ error: 'Could not reach Twilio: ' + (e.message || 'unknown error') });
  }
});

/** POST /api/twilio/numbers/claim {phoneNumber} — take an unclaimed number. */
router.post('/numbers/claim', requireAuth, async (req, res) => {
  const wanted = normPhone((req.body || {}).phoneNumber || '');
  if (!wanted) return res.status(400).json({ error: 'phoneNumber is required' });
  const tail = wanted.replace(/[^0-9]/g, '').slice(-10);
  try {
    // Must be a number the account actually owns.
    const nums = await listAccountNumbers();
    const match = nums.find(function (n) { return String(n.phoneNumber).replace(/[^0-9]/g, '').slice(-10) === tail; });
    if (!match) return res.status(404).json({ error: 'That number is not in your Twilio account' });
    // Must not already belong to another user.
    const owner = userByNumber(match.phoneNumber);
    if (owner && owner.id !== req.user.id) {
      return res.status(409).json({ error: 'That number is already assigned to ' + (owner.name || 'another user') });
    }
    // Point the number's SMS + Voice webhooks at this CRM, then assign it.
    await configureNumberWebhooks(match.sid);
    db.prepare('UPDATE users SET sending_number = ? WHERE id = ?').run(match.phoneNumber, req.user.id);
    res.json({ ok: true, phoneNumber: match.phoneNumber });
  } catch (e) {
    res.status(502).json({ error: 'Could not claim number: ' + (e.message || 'unknown error') });
  }
});

/** POST /api/twilio/numbers/release {userId?} — give up a number (admin may release others'). */
router.post('/numbers/release', requireAuth, (req, res) => {
  let targetId = req.user.id;
  const asked = (req.body || {}).userId;
  if (asked && asked !== req.user.id) {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only an admin can release another user’s number' });
    targetId = asked;
  }
  db.prepare('UPDATE users SET sending_number = NULL WHERE id = ?').run(targetId);
  res.json({ ok: true });
});

/** POST /api/twilio/numbers/assign {userId, phoneNumber} — admin assigns a number to a user. */
router.post('/numbers/assign', requireAuth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admins only' });
  const { userId } = req.body || {};
  const wanted = normPhone((req.body || {}).phoneNumber || '');
  if (!userId || !wanted) return res.status(400).json({ error: 'userId and phoneNumber are required' });
  const tail = wanted.replace(/[^0-9]/g, '').slice(-10);
  try {
    const nums = await listAccountNumbers();
    const match = nums.find(function (n) { return String(n.phoneNumber).replace(/[^0-9]/g, '').slice(-10) === tail; });
    if (!match) return res.status(404).json({ error: 'That number is not in your Twilio account' });
    // Clear it from anyone else first.
    db.prepare("SELECT id, sending_number FROM users WHERE sending_number IS NOT NULL AND sending_number != ''").all()
      .forEach(function (u) { if (String(u.sending_number).replace(/[^0-9]/g, '').slice(-10) === tail) db.prepare('UPDATE users SET sending_number = NULL WHERE id = ?').run(u.id); });
    await configureNumberWebhooks(match.sid);
    db.prepare('UPDATE users SET sending_number = ? WHERE id = ?').run(match.phoneNumber, userId);
    res.json({ ok: true, phoneNumber: match.phoneNumber });
  } catch (e) {
    res.status(502).json({ error: 'Could not assign number: ' + (e.message || 'unknown error') });
  }
});

/** GET /api/twilio/token — Voice Access Token for this user's browser client. */
router.get('/token', requireAuth, (req, res) => {
  if (!voiceConfigured()) {
    return res.status(400).json({ error: 'Twilio Voice is not configured on this server' });
  }
  const identity = identityFor(req.user.id);
  try {
    res.json({ token: buildVoiceToken(identity), identity });
  } catch (e) {
    console.error('[twilio] token error:', e.message);
    res.status(500).json({ error: 'Could not create voice token' });
  }
});

/**
 * POST /api/twilio/voice — TwiML App voice URL. Twilio hits this when the
 * browser client places an OUTBOUND call (Device.connect({ To })).
 * Dials the requested PSTN number with the CRM's Twilio number as caller ID.
 */
router.post('/voice', (req, res) => {
  const to = normPhone((req.body && req.body.To) || (req.query && req.query.To) || '');
  res.set('Content-Type', 'text/xml');
  if (!to) {
    return res.send('<?xml version="1.0" encoding="UTF-8"?><Response><Say>No destination number.</Say></Response>');
  }
  // Use the CALLING user's own number as caller ID (falls back to the shared one).
  const callerUserId = userIdFromCaller((req.body && req.body.Caller) || (req.query && req.query.Caller) || '');
  const from = xmlEscape(userNumber(callerUserId) || FROM_NUMBER());
  res.send(
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<Response><Dial callerId="${from}" answerOnBridge="true"><Number>${xmlEscape(to)}</Number></Dial></Response>`
  );
});

/**
 * POST /api/twilio/voice-inbound — the Twilio NUMBER's "A call comes in" URL.
 * Routes an inbound PSTN call to the browser client(s). Optionally targets a
 * specific identity via TWILIO_INBOUND_IDENTITY (a CRM user id); otherwise it
 * dials the first admin's client.
 */
router.post('/voice-inbound', (req, res) => {
  res.set('Content-Type', 'text/xml');
  // Route to whoever owns the number that was called (the "To").
  let targetUserId = null;
  const dialed = (req.body && (req.body.To || req.body.Called)) || '';
  const owner = userByNumber(dialed);
  if (owner) targetUserId = owner.id;
  if (!targetUserId) targetUserId = process.env.TWILIO_INBOUND_IDENTITY || null;
  if (!targetUserId) {
    const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' AND active = 1 ORDER BY created_at ASC LIMIT 1").get();
    targetUserId = admin ? admin.id : null;
  }
  if (!targetUserId) {
    // No agent to ring → go straight to voicemail.
    return res.send(voicemailTwiml(null));
  }
  const identity = xmlEscape(identityFor(targetUserId));
  // Ring the browser client; if it isn't answered, `action` drops to voicemail.
  // Pass the rung user's id so the fallback plays THAT user's greeting.
  const fbAction = '/api/twilio/voice-inbound-fallback?u=' + encodeURIComponent(targetUserId);
  res.send(
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<Response><Dial answerOnBridge="true" timeout="25" action="${xmlEscape(fbAction)}" method="POST"><Client>${identity}</Client></Dial></Response>`
  );
});

/**
 * TwiML that greets the caller (custom recording or text) and records a
 * voicemail. Uses the greeting belonging to `userId` (the user the call routed
 * to); falls back to a generic message if that user hasn't set one.
 */
function voicemailTwiml(userId) {
  let greeting;
  const u = userId
    ? db.prepare('SELECT vm_greeting_text, vm_greeting_recording_id FROM users WHERE id = ?').get(userId)
    : null;
  const recId = u && u.vm_greeting_recording_id;
  if (recId) {
    const base = (process.env.APP_BASE_URL || 'https://reneweq-crm-production.up.railway.app').replace(/\/+$/, '');
    greeting = '<Play>' + xmlEscape(base + '/api/rvm/recordings/' + recId + '/public') + '</Play>';
  } else {
    const text = (u && u.vm_greeting_text) ||
      "You've reached Deal Flow Pro. Please leave a message after the tone, then hang up.";
    greeting = '<Say voice="alice">' + xmlEscape(text) + '</Say>';
  }
  return '<?xml version="1.0" encoding="UTF-8"?><Response>' +
    greeting +
    '<Record maxLength="120" playBeep="true" trim="trim-silence" ' +
    'action="/api/twilio/voicemail" method="POST" ' +
    'transcribe="true" transcribeCallback="/api/twilio/voicemail-transcribe"/>' +
    '<Say voice="alice">We did not receive a recording. Goodbye.</Say>' +
    '</Response>';
}

/**
 * POST /api/twilio/voice-inbound-fallback — Twilio calls this after the Dial
 * finishes. If the browser client didn't answer, record a voicemail.
 */
router.post('/voice-inbound-fallback', (req, res) => {
  res.set('Content-Type', 'text/xml');
  const status = (req.body && req.body.DialCallStatus) || '';
  if (status === 'completed') {
    // Call was answered — nothing more to do.
    return res.send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  }
  const uid = (req.query && req.query.u) || (req.body && req.body.u) || null;
  res.send(voicemailTwiml(uid));
});

/**
 * POST /api/twilio/voicemail — the <Record> action. Downloads the recording
 * from Twilio, stores it on the volume, and logs it to the matching contact's
 * Activity Log as an unread inbound voicemail.
 */
router.post('/voicemail', async (req, res) => {
  res.set('Content-Type', 'text/xml');
  try {
    const b = req.body || {};
    const from = b.From || b.Caller || '';
    const recUrl = b.RecordingUrl || '';
    const recSid = b.RecordingSid || null;
    const dur = parseInt(b.RecordingDuration, 10) || null;
    const contact = findContactByPhone(from);
    if (recUrl && contact) {
      // Download the audio from Twilio (Basic auth) and store on the volume.
      let stored = null;
      try {
        const sid = ACCOUNT_SID();
        const auth = Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
        const r = await fetch(recUrl + '.mp3', { headers: { Authorization: `Basic ${auth}` } });
        if (r.ok) {
          const buf = Buffer.from(await r.arrayBuffer());
          try { fs.mkdirSync(VM_DIR, { recursive: true }); } catch (e) {}
          stored = (recSid || uid()) + '.mp3';
          fs.writeFileSync(path.join(VM_DIR, stored), buf);
        }
      } catch (e) { console.error('[twilio] voicemail download failed:', e.message); }

      const recId = uid();
      if (stored) {
        db.prepare(`INSERT INTO rvm_recordings (id, owner_id, contact_id, label, stored, mime, size, duration_ms, direction, twilio_sid, created_by, created_at)
          VALUES (@id,@owner_id,@contact_id,@label,@stored,'audio/mpeg',@size,@dur,'inbound',@sid,@owner_id,@created_at)`).run({
          id: recId, owner_id: contact.owner_id, contact_id: contact.id,
          label: 'Voicemail from ' + (from || 'caller'), stored,
          size: null, dur: dur ? dur * 1000 : null, sid: recSid, created_at: now(),
        });
      }
      // Log the inbound voicemail to the contact's Activity Log (unread).
      db.prepare(`INSERT INTO activities (id, contact_id, owner_id, type, mode, direction, body, status, provider_id, created_by, created_at)
        VALUES (@id,@contact_id,@owner_id,'rvm','automated','inbound',@body,'received',@provider_id,@owner_id,@created_at)`).run({
        id: uid(), contact_id: contact.id, owner_id: contact.owner_id,
        body: 'Voicemail from ' + (from || 'caller') + (dur ? ' (' + dur + 's)' : ''),
        provider_id: stored ? recId : recSid, created_at: now(),
      });
      try { db.prepare('UPDATE contacts SET updated_at = ? WHERE id = ?').run(now(), contact.id); } catch (e) {}
      try {
        const label = db.prepare('SELECT name FROM contacts WHERE id = ?').get(contact.id);
        sendPushToUser(contact.owner_id, {
          title: 'New voicemail' + (label && label.name ? ' from ' + label.name : ''),
          body: 'Missed call — tap to listen', url: '/', tag: 'vm-' + contact.id,
        });
      } catch (e) {}
    } else if (recUrl && !contact) {
      console.log('[twilio] voicemail from unknown number:', from);
    }
  } catch (e) {
    console.error('[twilio] voicemail handler error:', e.message);
  }
  res.send('<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="alice">Thank you. Goodbye.</Say><Hangup/></Response>');
});

/**
 * POST /api/twilio/voicemail-transcribe — async transcription callback.
 * Appends the transcribed text to the matching voicemail activity.
 */
router.post('/voicemail-transcribe', (req, res) => {
  try {
    const b = req.body || {};
    const text = b.TranscriptionText || '';
    const recSid = b.RecordingSid || null;
    if (text && recSid) {
      const rec = db.prepare('SELECT id FROM rvm_recordings WHERE twilio_sid = ?').get(recSid);
      const providerId = rec ? rec.id : recSid;
      const act = db.prepare("SELECT id, body FROM activities WHERE provider_id = ? AND type = 'rvm' AND direction = 'inbound' ORDER BY created_at DESC LIMIT 1").get(providerId);
      if (act) {
        db.prepare('UPDATE activities SET body = ? WHERE id = ?').run((act.body || '') + ' — "' + text + '"', act.id);
      }
    }
  } catch (e) { console.error('[twilio] transcribe callback error:', e.message); }
  res.set('Content-Type', 'text/xml');
  res.send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
});

/**
 * POST /api/twilio/sms {contactId?, to, body} — send an SMS and log it.
 * Auth required; the sender is the requesting user.
 */
router.post('/sms', requireAuth, async (req, res) => {
  const { contactId, to, body } = req.body || {};
  if (!to || !body) return res.status(400).json({ error: 'to and body are required' });
  if (!smsConfigured(req.user.id)) return res.status(400).json({ error: 'Twilio SMS is not configured on this server' });

  // Send from THIS user's own number if they have one; else the shared number.
  const fromNum = userNumber(req.user.id);
  if (!fromNum) return res.status(400).json({ error: 'No sending number is assigned to your account. Set one in Settings.' });
  const result = await sendSms({ to: normPhone(to), body: String(body), from: fromNum });

  // Log the outbound text against the contact (if we know it).
  let contact = null;
  if (contactId) contact = db.prepare('SELECT id, owner_id FROM contacts WHERE id = ?').get(contactId);
  if (!contact) contact = findContactByPhone(to);
  if (contact) {
    logActivity({
      contactId: contact.id, ownerId: contact.owner_id, type: 'sms', direction: 'outbound',
      body: String(body), status: result.status, providerId: result.sid, createdBy: req.user.id,
    });
    try {
      db.prepare('UPDATE contacts SET updated_at = ? WHERE id = ?').run(now(), contact.id);
    } catch (e) { /* non-fatal */ }
  }
  res.json({ ok: !!result.sid, sid: result.sid, status: result.status, logged: !!contact });
});

/**
 * POST /api/twilio/sms-inbound — the Twilio NUMBER's "A message comes in" URL.
 * Logs the inbound text against the matching contact. Returns empty TwiML.
 */
router.post('/sms-inbound', (req, res) => {
  try {
    const from = (req.body && (req.body.From || req.body.from)) || '';
    const toNum = (req.body && (req.body.To || req.body.to)) || '';
    const bodyText = (req.body && (req.body.Body || req.body.body)) || '';
    const sid = (req.body && (req.body.MessageSid || req.body.SmsSid)) || null;
    const contact = findContactByPhone(from);
    // Who owns the CRM number that was texted?
    const numberOwner = userByNumber(toNum);
    if (contact) {
      logActivity({
        contactId: contact.id, ownerId: contact.owner_id, type: 'sms', direction: 'inbound',
        body: String(bodyText), status: 'received', providerId: sid, createdBy: contact.owner_id,
      });
      try { db.prepare('UPDATE contacts SET updated_at = ? WHERE id = ?').run(now(), contact.id); } catch (e) {}
      // Push alert to the contact's owner, and to the number's owner (if different).
      try {
        const label = db.prepare('SELECT name FROM contacts WHERE id = ?').get(contact.id);
        const payload = {
          title: 'New text' + (label && label.name ? ' from ' + label.name : ''),
          body: String(bodyText).slice(0, 140), url: '/', tag: 'sms-' + contact.id,
        };
        sendPushToUser(contact.owner_id, payload);
        if (numberOwner && numberOwner.id !== contact.owner_id) sendPushToUser(numberOwner.id, payload);
      } catch (e) {}
    } else {
      console.log('[twilio] inbound SMS from unknown number:', from);
    }
  } catch (e) {
    console.error('[twilio] sms-inbound error:', e.message);
  }
  res.set('Content-Type', 'text/xml');
  res.send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
});

module.exports = { router, voiceConfigured, smsConfigured };
