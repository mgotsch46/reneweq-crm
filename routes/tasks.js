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
const google = require('./google'); // Google Tasks/Calendar sync (best-effort)

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

/**
 * GET /api/tasks/assignees — active users (id + name) that a task can be
 * assigned to. Available to ANY authenticated user (unlike GET /api/users,
 * which is admin-only), so everyone can assign tasks to themselves or teammates.
 */
router.get('/assignees', (req, res) => {
  const rows = db.prepare(
    'SELECT id, name, active FROM users WHERE active = 1 ORDER BY name COLLATE NOCASE'
  ).all();
  res.json(rows);
});

/**
 * Push a task to Google (Tasks + Calendar) and persist the returned ids.
 * Best-effort: returns the push result; never throws into the request.
 */
async function syncTaskToGoogle(ownerId, task) {
  const g = await google.pushTaskToGoogle(ownerId, task);
  if (g && (g.taskId || g.eventId)) {
    db.prepare(`
      UPDATE tasks SET
        google_task_id  = COALESCE(@gt, google_task_id),
        google_event_id = COALESCE(@ge, google_event_id)
      WHERE id = @id
    `).run({ gt: g.taskId, ge: g.eventId, id: task.id });
  }
  return g || { taskId: null, eventId: null, error: 'push failed' };
}

/** POST /api/tasks {title, due_date?, contact_id?, external_ref?} */
router.post('/', async (req, res) => {
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

  // Best-effort Google sync — a failure never blocks the 201 for the saved task.
  task.google_task_id = null;
  task.google_event_id = null;
  try {
    const g = await syncTaskToGoogle(task.owner_id, task);
    task.google_task_id = g.taskId || null;
    task.google_event_id = g.eventId || null;
  } catch (e) {
    console.error('[google] task sync failed:', e.message);
  }
  res.status(201).json(task);
});

/**
 * POST /api/tasks/:id/push-google — manually push/re-push a task to Google
 * Tasks + Calendar. Owner-scoped. Returns the updated task on success.
 */
router.post('/:id/push-google', async (req, res) => {
  const task = getOwnedTask(req.params.id, req.user); // isolation check
  if (!task) return res.status(404).json({ error: 'Task not found' });

  let g;
  try {
    g = await syncTaskToGoogle(task.owner_id, task); // owner's Google account
  } catch (e) {
    console.error('[google] push-google failed:', e.message);
    return res.status(502).json({ error: 'Could not reach Google' });
  }
  if (!g.taskId && !g.eventId) {
    return res.status(400).json({ error: g.error || 'Could not push task to Google' });
  }
  res.json(db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id));
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
  // Reassign the task to another user (yourself or any ACTIVE user). owner_id is
  // the tenant key, so this moves the task into the assignee's task list.
  if ('owner_id' in body) {
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(body.owner_id);
    if (!target) return res.status(400).json({ error: 'Assignee not found' });
    if (!target.active) return res.status(400).json({ error: 'Cannot assign to an inactive user' });
    sets.push('owner_id = @owner_id');
    params.owner_id = target.id;
  }
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
  const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id);

  // Best-effort: mark the synced Google Task completed (fire-and-forget).
  if ('done' in body && body.done && updated.google_task_id) {
    google.completeTaskGoogle(updated.owner_id, updated).catch(() => {});
  }
  res.json(updated);
});

/** DELETE /api/tasks/:id */
router.delete('/:id', (req, res) => {
  const task = getOwnedTask(req.params.id, req.user); // isolation check
  if (!task) return res.status(404).json({ error: 'Task not found' });
  db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
  // Best-effort: remove the synced Google Task/event too (fire-and-forget).
  google.deleteTaskGoogle(task.owner_id, task).catch(() => {});
  res.json({ ok: true, deleted: task.id });
});

// ---------------------------------------------------------------------------
// iCalendar export -- VTODO entries for the REQUESTER'S open tasks.
// ---------------------------------------------------------------------------

/** Escape text per RFC 5545. */
function icsEscape(s) {
  return String(s || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** Return YYYYMMDD for a date string (or today if invalid), plus the next day. */
function icsDateParts(dueDate) {
  let base = new Date();
  if (dueDate) {
    const parsed = new Date(dueDate.length <= 10 ? dueDate + 'T00:00:00' : dueDate);
    if (!isNaN(parsed.getTime())) base = parsed;
  }
  const y = base.getFullYear();
  const m = base.getMonth();
  const d = base.getDate();
  const fmt = (yy, mm, dd) =>
    String(yy) + String(mm + 1).padStart(2, '0') + String(dd).padStart(2, '0');
  const start = fmt(y, m, d);
  const nextDay = new Date(y, m, d + 1); // all-day DTEND is exclusive (start + 1 day)
  const end = fmt(nextDay.getFullYear(), nextDay.getMonth(), nextDay.getDate());
  return { start, end };
}

/**
 * GET /api/tasks/export.ics
 * Emits VEVENT (all-day) entries — VTODO is ignored by Google Calendar, so we
 * export each task as a calendar event whose title is the task name. Tasks with
 * no due date are placed on today so they still import with their name visible.
 */
router.get('/export.ics', (req, res) => {
  // Always the requester's own open tasks (even for admin). Join the linked
  // contact so its name can be shown alongside the task in the calendar.
  const rows = db.prepare(`
    SELECT t.*, c.name AS contact_name
    FROM tasks t
    LEFT JOIN contacts c ON c.id = t.contact_id
    WHERE t.owner_id = ? AND t.done = 0
    ORDER BY t.due_date IS NULL, t.due_date ASC
  `).all(req.user.id);

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Wholesale CRM//Tasks//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Wholesale CRM Tasks',
  ];

  for (const t of rows) {
    const { start, end } = icsDateParts(t.due_date);
    // Task name is the event title; append the linked contact if present.
    const summary = t.contact_name
      ? `${t.title} — ${t.contact_name}`
      : String(t.title || 'CRM task');
    const descBits = ['Wholesale CRM task'];
    if (t.contact_name) descBits.push(`Contact: ${t.contact_name}`);
    if (!t.due_date) descBits.push('(no due date set — placed on today)');

    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${t.id}@wholesale-crm`);
    lines.push(`DTSTAMP:${stamp}`);
    lines.push(`DTSTART;VALUE=DATE:${start}`);
    lines.push(`DTEND;VALUE=DATE:${end}`);
    lines.push(`SUMMARY:${icsEscape(summary)}`);
    lines.push(`DESCRIPTION:${icsEscape(descBits.join(' — '))}`);
    lines.push('TRANSP:TRANSPARENT'); // all-day, doesn't block time
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');

  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="crm-tasks.ics"');
  res.send(lines.join('\r\n') + '\r\n');
});

module.exports = router;
