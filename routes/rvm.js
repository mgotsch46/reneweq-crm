/**
 * routes/rvm.js — ringless voicemail: record, store, send now / schedule.
 *
 * Audio clips are recorded in the browser and stored on the volume under
 *   <CRM_DATA_DIR>/uploads/rvm/<recId>.<ext>
 * The actual "drop" goes through a provider (Slybroadcast / Drop Cowboy) via
 * integrations.sendRvm — which fetches the clip from the PUBLIC audio URL
 * exposed here. Sends are gated on per-contact RVM consent + DNC (TCPA).
 *
 *   POST   /api/contacts/:id/rvm/recordings   {label, mime, dataBase64}  → save clip
 *   GET    /api/contacts/:id/rvm/recordings                              → list clips
 *   GET    /api/rvm/recordings/:recId/audio                    (auth)    → preview stream
 *   GET    /api/rvm/recordings/:recId/public                   (NO auth) → provider fetch
 *   DELETE /api/rvm/recordings/:recId                          (auth)    → delete clip
 *   POST   /api/contacts/:id/rvm/send   {recordingId?, script?, sendAt?} → send / schedule
 *   GET    /api/contacts/:id/rvm/scheduled                               → list queued
 *   DELETE /api/rvm/scheduled/:schedId                                   → cancel queued
 */
'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { db, uid, now, DATA_DIR, DEFAULT_RVM } = require('../db');
const { requireAuth } = require('../auth');
const { isAdmin, renderTemplate } = require('./helpers');
const { sendRvm, rvmMode, rvmProvider } = require('../integrations');

const router = express.Router();

const RVM_DIR = path.join(DATA_DIR, 'uploads', 'rvm');
try { fs.mkdirSync(RVM_DIR, { recursive: true }); } catch (e) { /* created lazily */ }

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB per clip

/** Absolute base URL for building provider-fetchable audio links. */
function appBaseUrl(req) {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL.replace(/\/+$/, '');
  const host = req && req.get && req.get('host');
  return host ? 'https://' + host : 'https://reneweq-crm-production.up.railway.app';
}
/** Base URL usable outside a request (scheduler). */
function baseUrlNoReq() {
  return (process.env.APP_BASE_URL || 'https://reneweq-crm-production.up.railway.app').replace(/\/+$/, '');
}

function extFor(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('wav')) return 'wav';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return 'm4a';
  if (m.includes('ogg')) return 'ogg';
  if (m.includes('webm')) return 'webm';
  return 'audio';
}

function contactFor(id, user) {
  const c = db.prepare('SELECT * FROM contacts WHERE id = ?').get(id);
  if (!c) return null;
  if (!isAdmin(user) && String(c.owner_id) !== String(user.id)) return null;
  return c;
}
function recFor(recId, user) {
  const r = db.prepare('SELECT * FROM rvm_recordings WHERE id = ?').get(recId);
  if (!r) return null;
  if (user && !isAdmin(user) && String(r.owner_id) !== String(user.id)) return null;
  return r;
}
function recPublic(r) {
  return { id: r.id, label: r.label, mime: r.mime, size: r.size, duration_ms: r.duration_ms, created_at: r.created_at };
}
function truthy(v) { return v === 1 || v === true || v === '1' || v === 'true'; }

/** GET /api/rvm/status — is RVM delivery live, and via which provider? */
router.get('/rvm/status', requireAuth, (req, res) => {
  res.json({ mode: rvmMode(), provider: rvmProvider(), baseUrl: appBaseUrl(req) });
});

// ---------------------------------------------------------------------------
// Recordings
// ---------------------------------------------------------------------------

/** POST /api/contacts/:id/rvm/recordings — save a recorded clip (base64). */
router.post('/contacts/:id/rvm/recordings', requireAuth, (req, res) => {
  const contact = contactFor(req.params.id, req.user);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });
  const { label, mime, dataBase64, duration_ms } = req.body || {};
  if (!dataBase64) return res.status(400).json({ error: 'dataBase64 is required' });
  const b64 = String(dataBase64).replace(/^data:[^;]*;base64,/, '');
  let buf;
  try { buf = Buffer.from(b64, 'base64'); } catch (e) { return res.status(400).json({ error: 'Invalid audio data' }); }
  if (!buf.length) return res.status(400).json({ error: 'Empty recording' });
  if (buf.length > MAX_BYTES) return res.status(413).json({ error: 'Recording too large (max 10 MB)' });

  const id = uid();
  const stored = id + '.' + extFor(mime);
  try { fs.writeFileSync(path.join(RVM_DIR, stored), buf); }
  catch (e) { console.error('[rvm] write failed:', e.message); return res.status(500).json({ error: 'Could not save recording' }); }

  const row = {
    id, owner_id: contact.owner_id, contact_id: contact.id,
    label: label ? String(label).slice(0, 120) : ('Recording ' + new Date().toLocaleString()),
    stored, mime: mime ? String(mime).slice(0, 80) : 'audio/webm',
    size: buf.length, duration_ms: Number(duration_ms) || null,
    created_by: req.user.id, created_at: now(),
  };
  db.prepare(`INSERT INTO rvm_recordings (id, owner_id, contact_id, label, stored, mime, size, duration_ms, created_by, created_at)
    VALUES (@id,@owner_id,@contact_id,@label,@stored,@mime,@size,@duration_ms,@created_by,@created_at)`).run(row);
  res.status(201).json(recPublic(row));
});

/** GET /api/contacts/:id/rvm/recordings — clips for this contact (newest first). */
router.get('/contacts/:id/rvm/recordings', requireAuth, (req, res) => {
  const contact = contactFor(req.params.id, req.user);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });
  const rows = db.prepare('SELECT * FROM rvm_recordings WHERE contact_id = ? ORDER BY created_at DESC').all(contact.id);
  res.json(rows.map(recPublic));
});

function streamRec(r, res) {
  const file = path.join(RVM_DIR, r.stored);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Audio missing on server' });
  res.setHeader('Content-Type', r.mime || 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store');
  fs.createReadStream(file).on('error', () => { if (!res.headersSent) res.status(500).end(); }).pipe(res);
}

/** GET /api/rvm/recordings/:recId/audio — in-app preview (auth). */
router.get('/rvm/recordings/:recId/audio', requireAuth, (req, res) => {
  const r = recFor(req.params.recId, req.user);
  if (!r) return res.status(404).json({ error: 'Recording not found' });
  streamRec(r, res);
});

/** GET /api/rvm/recordings/:recId/public — provider fetch (NO auth; random id). */
router.get('/rvm/recordings/:recId/public', (req, res) => {
  const r = recFor(req.params.recId, null);
  if (!r) return res.status(404).json({ error: 'Recording not found' });
  streamRec(r, res);
});

/** DELETE /api/rvm/recordings/:recId — remove clip + row. */
router.delete('/rvm/recordings/:recId', requireAuth, (req, res) => {
  const r = recFor(req.params.recId, req.user);
  if (!r) return res.status(404).json({ error: 'Recording not found' });
  try { fs.unlinkSync(path.join(RVM_DIR, r.stored)); } catch (e) {}
  db.prepare('DELETE FROM rvm_recordings WHERE id = ?').run(r.id);
  res.json({ ok: true, deleted: r.id });
});

// ---------------------------------------------------------------------------
// Send / schedule
// ---------------------------------------------------------------------------

function logRvmActivity(contact, user, body, status, providerId) {
  const id = uid();
  db.prepare(`INSERT INTO activities (id, contact_id, owner_id, type, mode, direction, body, status, provider_id, created_by, created_at)
    VALUES (@id,@contact_id,@owner_id,'rvm','automated','outbound',@body,@status,@provider_id,@created_by,@created_at)`).run({
    id, contact_id: contact.id, owner_id: contact.owner_id, body: body || null,
    status: status || null, provider_id: providerId || null, created_by: user ? user.id : contact.owner_id, created_at: now(),
  });
}

/** POST /api/contacts/:id/rvm/send {recordingId?, script?, sendAt?} */
router.post('/contacts/:id/rvm/send', requireAuth, async (req, res) => {
  const contact = contactFor(req.params.id, req.user);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });
  if (!contact.phone) return res.status(400).json({ error: 'Contact has no phone number' });
  if (truthy(contact.dnc)) return res.status(400).json({ error: 'Contact is on the Do-Not-Contact list' });
  if (!truthy(contact.consent_sms) && !truthy(contact.consent_rvm)) {
    return res.status(400).json({ error: 'RVM consent is not granted for this contact' });
  }

  const { recordingId, script, sendAt } = req.body || {};
  let rec = null;
  if (recordingId) {
    rec = recFor(recordingId, req.user);
    if (!rec) return res.status(400).json({ error: 'Recording not found' });
  }
  const bodyScript = renderTemplate(script || contact.rvm || DEFAULT_RVM, contact, req.user.name);

  // Scheduled for the future → queue it; the scheduler tick will send it.
  const when = sendAt ? new Date(sendAt) : null;
  if (when && !isNaN(when.getTime()) && when.getTime() > Date.now() + 5000) {
    const id = uid();
    db.prepare(`INSERT INTO scheduled_rvms (id, contact_id, owner_id, recording_id, phone, script, send_at, status, created_by, created_at)
      VALUES (@id,@contact_id,@owner_id,@recording_id,@phone,@script,@send_at,'scheduled',@created_by,@created_at)`).run({
      id, contact_id: contact.id, owner_id: contact.owner_id, recording_id: rec ? rec.id : null,
      phone: contact.phone, script: bodyScript, send_at: when.toISOString(), created_by: req.user.id, created_at: now(),
    });
    logRvmActivity(contact, req.user, 'RVM scheduled for ' + when.toLocaleString() + (rec ? ' (recording)' : ' (script)'), 'scheduled', id);
    return res.status(201).json({ ok: true, scheduled: true, id, send_at: when.toISOString() });
  }

  // Send now.
  const audioUrl = rec ? (appBaseUrl(req) + '/api/rvm/recordings/' + rec.id + '/public') : null;
  const result = await sendRvm({
    to: contact.phone, body: bodyScript, audioUrl,
    from: req.user.business_number || process.env.TWILIO_FROM,
  });
  db.prepare('UPDATE contacts SET rvmStatus = 1, updated_at = ? WHERE id = ?').run(now(), contact.id);
  logRvmActivity(contact, req.user, rec ? ('Ringless voicemail (recording)') : ('Ringless voicemail: ' + bodyScript), result.status, result.sid);
  res.json({ ok: !!result.sid, sent: true, result });
});

/** GET /api/contacts/:id/rvm/scheduled — queued RVMs for this contact. */
router.get('/contacts/:id/rvm/scheduled', requireAuth, (req, res) => {
  const contact = contactFor(req.params.id, req.user);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });
  const rows = db.prepare("SELECT * FROM scheduled_rvms WHERE contact_id = ? AND status = 'scheduled' ORDER BY send_at ASC").all(contact.id);
  res.json(rows.map((r) => ({ id: r.id, send_at: r.send_at, recording_id: r.recording_id, script: r.script, status: r.status })));
});

/** DELETE /api/rvm/scheduled/:schedId — cancel a queued RVM. */
router.delete('/rvm/scheduled/:schedId', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM scheduled_rvms WHERE id = ?').get(req.params.schedId);
  if (!row) return res.status(404).json({ error: 'Scheduled RVM not found' });
  if (!isAdmin(req.user) && String(row.owner_id) !== String(req.user.id)) return res.status(404).json({ error: 'Scheduled RVM not found' });
  db.prepare("UPDATE scheduled_rvms SET status = 'canceled' WHERE id = ?").run(row.id);
  res.json({ ok: true, canceled: row.id });
});

// ---------------------------------------------------------------------------
// Scheduler hook — process any due RVMs (called from scheduler.js).
// ---------------------------------------------------------------------------

async function processDueRvms() {
  let due;
  try {
    due = db.prepare("SELECT * FROM scheduled_rvms WHERE status = 'scheduled' AND send_at <= ? ORDER BY send_at ASC LIMIT 25")
      .all(new Date().toISOString());
  } catch (e) { return; }
  for (const row of due) {
    try {
      const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(row.contact_id);
      if (!contact) { db.prepare("UPDATE scheduled_rvms SET status='failed', error='contact gone' WHERE id=?").run(row.id); continue; }
      if (truthy(contact.dnc)) { db.prepare("UPDATE scheduled_rvms SET status='canceled', error='DNC' WHERE id=?").run(row.id); continue; }
      const audioUrl = row.recording_id ? (baseUrlNoReq() + '/api/rvm/recordings/' + row.recording_id + '/public') : null;
      const result = await sendRvm({ to: row.phone, body: row.script, audioUrl, from: process.env.TWILIO_FROM });
      db.prepare("UPDATE scheduled_rvms SET status=?, provider_ref=?, error=?, sent_at=? WHERE id=?")
        .run(result.sid ? 'sent' : 'failed', result.sid || null, result.sid ? null : (result.status || 'failed'), now(), row.id);
      db.prepare('UPDATE contacts SET rvmStatus = 1, updated_at = ? WHERE id = ?').run(now(), contact.id);
      logRvmActivity(contact, null, row.recording_id ? 'Scheduled ringless voicemail (recording)' : ('Scheduled ringless voicemail: ' + (row.script || '')), result.status, result.sid);
    } catch (e) {
      try { db.prepare("UPDATE scheduled_rvms SET status='failed', error=? WHERE id=?").run(String(e.message).slice(0, 200), row.id); } catch (e2) {}
    }
  }
}

module.exports = router;
module.exports.processDueRvms = processDueRvms;
