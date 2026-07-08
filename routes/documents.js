/**
 * routes/documents.js — per-contact document uploads.
 *
 * Files are stored on the persistent volume under
 *   <CRM_DATA_DIR>/uploads/<contactId>/<docId>__<safeName>
 * and tracked in the `documents` table. Upload is a base64 JSON POST (so no
 * multipart dependency is needed); the global express.json limit is raised in
 * server.js to allow ~25 MB files.
 *
 *   POST   /api/contacts/:id/documents   {filename, mime, dataBase64}  → upload
 *   GET    /api/contacts/:id/documents                                  → list
 *   GET    /api/documents/:docId/download                               → download
 *   DELETE /api/documents/:docId                                        → delete
 *
 * Isolation: a user may only touch documents on contacts they own; an admin
 * may touch any. Every route applies requireAuth itself.
 */
'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { db, uid, now, DATA_DIR } = require('../db');
const { requireAuth } = require('../auth');
const { isAdmin } = require('./helpers');

const router = express.Router();

const UPLOAD_ROOT = path.join(DATA_DIR, 'uploads');
try { fs.mkdirSync(UPLOAD_ROOT, { recursive: true }); } catch (e) { /* created lazily on upload */ }

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB per file

/** Load a contact if the requester may access it (owner or admin), else null. */
function contactFor(id, user) {
  const c = db.prepare('SELECT id, owner_id FROM contacts WHERE id = ?').get(id);
  if (!c) return null;
  if (!isAdmin(user) && String(c.owner_id) !== String(user.id)) return null;
  return c;
}

/** Load a document row if the requester may access it, else null. */
function docFor(docId, user) {
  const d = db.prepare('SELECT * FROM documents WHERE id = ?').get(docId);
  if (!d) return null;
  if (!isAdmin(user) && String(d.owner_id) !== String(user.id)) return null;
  return d;
}

/** Sanitize an uploaded filename for safe storage + display. */
function safeName(name) {
  const s = String(name || 'file')
    .replace(/[^\w.\-() ]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
  return s || 'file';
}

/** Public shape returned to the client (never exposes the on-disk path). */
function docPublic(row) {
  return {
    id: row.id,
    contact_id: row.contact_id,
    filename: row.filename,
    mime: row.mime,
    size: row.size,
    uploaded_by: row.uploaded_by,
    created_at: row.created_at,
  };
}

/** POST /api/contacts/:id/documents — upload a file (base64 JSON). */
router.post('/contacts/:id/documents', requireAuth, (req, res) => {
  const contact = contactFor(req.params.id, req.user);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });

  const { filename, mime, dataBase64 } = req.body || {};
  if (!dataBase64) return res.status(400).json({ error: 'dataBase64 is required' });

  const b64 = String(dataBase64).replace(/^data:[^;]*;base64,/, '');
  let buf;
  try { buf = Buffer.from(b64, 'base64'); }
  catch (e) { return res.status(400).json({ error: 'Invalid file data' }); }
  if (!buf.length) return res.status(400).json({ error: 'Empty file' });
  if (buf.length > MAX_BYTES) return res.status(413).json({ error: 'File too large (max 25 MB)' });

  const id = uid();
  const dir = path.join(UPLOAD_ROOT, contact.id);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
  const stored = id + '__' + safeName(filename);
  try {
    fs.writeFileSync(path.join(dir, stored), buf);
  } catch (e) {
    console.error('[documents] write failed:', e.message);
    return res.status(500).json({ error: 'Could not save file on the server' });
  }

  const row = {
    id,
    contact_id: contact.id,
    owner_id: contact.owner_id,
    filename: safeName(filename),
    stored,
    mime: mime ? String(mime).slice(0, 120) : null,
    size: buf.length,
    uploaded_by: req.user.id,
    created_at: now(),
  };
  db.prepare(`
    INSERT INTO documents (id, contact_id, owner_id, filename, stored, mime, size, uploaded_by, created_at)
    VALUES (@id, @contact_id, @owner_id, @filename, @stored, @mime, @size, @uploaded_by, @created_at)
  `).run(row);

  res.status(201).json(docPublic(row));
});

/** GET /api/contacts/:id/documents — list a contact's documents (newest first). */
router.get('/contacts/:id/documents', requireAuth, (req, res) => {
  const contact = contactFor(req.params.id, req.user);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });
  const rows = db.prepare(
    'SELECT * FROM documents WHERE contact_id = ? ORDER BY created_at DESC'
  ).all(contact.id);
  res.json(rows.map(docPublic));
});

/** GET /api/documents/:docId/download — stream the file as an attachment. */
router.get('/documents/:docId/download', requireAuth, (req, res) => {
  const d = docFor(req.params.docId, req.user);
  if (!d) return res.status(404).json({ error: 'Document not found' });
  const file = path.join(UPLOAD_ROOT, d.contact_id, d.stored);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'File is missing on the server' });
  res.setHeader('Content-Type', d.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', 'attachment; filename="' + String(d.filename).replace(/"/g, '') + '"');
  fs.createReadStream(file).on('error', function () {
    if (!res.headersSent) res.status(500).end();
  }).pipe(res);
});

/** DELETE /api/documents/:docId — remove the file + row. */
router.delete('/documents/:docId', requireAuth, (req, res) => {
  const d = docFor(req.params.docId, req.user);
  if (!d) return res.status(404).json({ error: 'Document not found' });
  try { fs.unlinkSync(path.join(UPLOAD_ROOT, d.contact_id, d.stored)); } catch (e) { /* file already gone */ }
  db.prepare('DELETE FROM documents WHERE id = ?').run(d.id);
  res.json({ ok: true, deleted: d.id });
});

module.exports = router;
