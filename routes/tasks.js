/**
 * routes/tasks.js — tasks CRUD + iCalendar (VTODO) export.
 * All routes run behind requireAuth (mounted in server.js).
 *
 * TENANT ISOLATION: every query scopes by owner (see routes/helpers.js).
 */
'use strict';

const express = require('express');
const { db, uid, now } = require('../db');
const { ownerScope, canTouch } = require('./helpers');

const router = express.Router();

function getOwnedTask(id, user) {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  return canTouch(user, row) ? row : null; // isolation check
}

/** GET /api/tasks — own tasks; admin sees all. */
router.get('/', (req, res) => {
  const s = ownerScope(req.user, 't'); // ISOLATION: owner filter
  const rows = db.prepare(`
    SELECT t.*, u.name AS ownerName, c.name AS contact_name
    FROM tasks t
    JOIN users u ON u.id = t.owner_id
    LEFT JOIN contacts c ON c.id = t.contact_id
    ${s.where}
    ORDER BY t.done ASC, t.due_date IS NULL, t.due_date ASC, t.created_at ASC
  `).all(...s.params);
  res.json(rows);
});

/** POST /api/tasks {title, due_date?, contact_id?, external_ref?} */
router.post('/', (req, res) => {
  const { title, due_date, contact_id, external_ref } = req.body || {};
  if (!title) return res.status(400).json({ error: 'title is required' });

  // If linking to a contact, the contact must be touchable by the requester.
  if (contact_id) {
    const c = db.prepare('SELECT * FROM contacts WHERE id = ?').get(contact_id);
    if (!canTouch(req.user, c)) {
      return res.status(400).json({ error: 'contact_id not found' }); // isolation check
    }
  }

  const task = {
    id: uid(),
    owner_id: req.user.id, // ISOLATION: owner is always the requester
    title: String(title),
    due_date: due_date || null,
    done: 0,
    contact_id: contact_id || null,
    external_ref: external_ref || null,
    created_at: now(),
  };
  db.prepare(`
    INSERT INTO tasks (id, owner_id, title, due_date, done, contact_id, external_ref, created_at)
    VALUES (@id, @owner_id, @title, @due_date, @done, @contact_id, @external_ref, @created_at)
  `).run(task);
  res.status(201).json(task);
});

/** PATCH /api/tasks/:id {title?, due_date?, done?, contact_id?, external_ref?} */
router.patch('/:id', (req, res) => {
  const task = getOwnedTask(req.params.id, req.user); // isolation check
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const body = req.body || {};
  const sets = [];
  const params = { id: task.id };

  if ('title' in body) { sets.push('title = @title'); params.title = String(body.title); }
  if ('due_date' in body) { sets.push('due_date = @due_date'); params.due_date = body.due_date || null; }
  if ('done' in body) { sets.push('done = @done'); params.done = body.done ? 1 : 0; }
  if ('external_ref' in body) { sets.push('external_ref = @external_ref'); params.external_ref = body.external_ref || null; }
  if ('contact_id' in body) {
    if (body.contact_id) {
      const c = db.prepare('SELECT * FROM contacts WHERE id = ?').get(body.contact_id);
      if (!canTouch(req.user, c)) return res.status(400).json({ error: 'contact_id not found' });
    }
    sets.push('contact_id = @contact_id');
    params.contact_id = body.contact_id || null;
  }
  if (sets.length === 0) return res.status(400).json({ error: 'No updatable fields supplied' });

  db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = @id`).run(params);
  res.json(db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id));
});

/** DELETE /api/tasks/:id */
router.delete('/:id', (req, res) => {
  const task = getOwnedTask(req.params.id, req.user); // isolation check
  if (!task) return res.status(404).json({ error: 'Task not found' });
  db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
  res.json({ ok: true, deleted: task.id });
});

// ---------------------------------------------------------------------------
// iCalendar export — VTODO entries for the REQUESTER'S open tasks.
// ---------------------------------------------------------------------------

/** Escape text per RFC 5545. */
function icsEscape(s) {
  return String(s || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** GET /api/tasks/export.ics */
router.get('/export.ics', (req, res) => {
  // Always the requester's own open tasks (even for admin).
  const rows = db.prepare(
    'SELECT * FROM tasks WHERE owner_id = ? AND done = 0 ORDER BY due_date ASC'
  ).all(req.user.id);

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Wholesale CRM//Tasks//EN',
    'CALSCALE:GREGORIAN',
  ];

  for (const t of rows) {
    lines.push('BEGIN:VTODO');
    lines.push(`UID:${t.id}@wholesale-crm`);
    lines.push(`DTSTAMP:${stamp}`);
    lines.push(`SUMMARY:${icsEscape(t.title)}`);
    if (t.due_date) {
      // Accept YYYY-MM-DD or full ISO strings.
      const d = t.due_date.replace(/-/g, '').slice(0, 8);
      if (/^\d{8}$/.test(d)) lines.push(`DUE;VALUE=DATE:${d}`);
    }
    lines.push('STATUS:NEEDS-ACTION');
    lines.push('END:VTODO');
  }
  lines.push('END:VCALENDAR');

  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="crm-tasks.ics"');
  res.send(lines.join('\r\n') + '\r\n');
});

module.exports = router;
