/**
 * scheduler.js — daily Lead Engine auto-import (node-cron).
 *
 * Reads settings:
 *   leadengine_csv_url    — the USER-SAVED CSV / Google Sheet URL (never scraped;
 *                           the only network call is fetching this URL)
 *   leadengine_cron       — cron spec, default '0 6 * * *' (6am daily)
 *   leadengine_autoimport — 'on' | 'off' (default 'off')
 *   import_owner_id       — owner for imported leads (falls back to first admin)
 *
 * reschedule() is called at boot (server.js) and whenever the admin saves
 * Lead Engine settings, so cron changes apply live. Everything is wrapped in
 * try/catch — a bad fetch or bad cron spec must never crash the server.
 */
'use strict';

const cron = require('node-cron');
const { db, getSetting, uid, now } = require('./db');

const DEFAULT_CRON = '0 6 * * *'; // 6am daily

let job = null;
let rvmJob = null;
let workflowJob = null;

/** Current wall-clock parts in a given IANA time zone. */
function tzParts(tz) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date());
  const g = {}; p.forEach(function (x) { g[x.type] = x.value; });
  let hh = parseInt(g.hour, 10); if (hh === 24) hh = 0;
  const mm = parseInt(g.minute, 10);
  return { hh: hh, mm: mm, minutes: hh * 60 + mm, dateStr: g.year + '-' + g.month + '-' + g.day, weekday: g.weekday };
}

/**
 * Once-a-minute worker: (a) push reminders for tasks/appointments whose time
 * has arrived, and (b) create the 4pm end-of-day review task (per user, in the
 * user's own time zone) if any tasks remain open.
 */
function runWorkflowTick() {
  let sendPushToUser = function () {};
  try { sendPushToUser = require('./routes/push').sendPushToUser; } catch (e) {}
  let users = [];
  try { users = db.prepare("SELECT id, name, timezone FROM users WHERE active = 1").all(); } catch (e) { return; }
  const ts = now();
  for (const u of users) {
    const tz = u.timezone || 'America/New_York';
    let t;
    try { t = tzParts(tz); } catch (e) { continue; }

    // (a) Timed task / appointment reminders — fire once when the time arrives.
    try {
      const due = db.prepare(
        "SELECT id, title, due_time FROM tasks WHERE owner_id = ? AND done = 0 AND reminded = 0 AND due_time IS NOT NULL AND due_time != '' AND substr(due_date,1,10) = ?"
      ).all(u.id, t.dateStr);
      for (const task of due) {
        const parts = String(task.due_time).split(':');
        const dueMin = (parseInt(parts[0], 10) || 0) * 60 + (parseInt(parts[1], 10) || 0);
        if (t.minutes >= dueMin) {
          db.prepare('UPDATE tasks SET reminded = 1 WHERE id = ?').run(task.id);
          try { sendPushToUser(u.id, { title: 'Task due now', body: task.title || 'You have a task due', url: '/' }); } catch (e) {}
        }
      }
    } catch (e) {}

    // (b) 4pm weekday review — create once/day if any tasks remain open.
    try {
      if (['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].indexOf(t.weekday) !== -1 && t.hh >= 16) {
        const already = db.prepare(
          "SELECT id FROM tasks WHERE owner_id = ? AND substr(due_date,1,10) = ? AND title LIKE 'Review today%'"
        ).get(u.id, t.dateStr);
        if (!already) {
          const incomplete = db.prepare(
            "SELECT COUNT(*) AS n FROM tasks WHERE owner_id = ? AND done = 0 AND due_date IS NOT NULL AND substr(due_date,1,10) <= ? AND title NOT LIKE 'Review today%'"
          ).get(u.id, t.dateStr).n;
          if (incomplete > 0) {
            db.prepare('INSERT INTO tasks (id, owner_id, title, due_date, done, reminded, created_at) VALUES (?,?,?,?,0,1,?)')
              .run(uid(), u.id, "Review today's tasks — reschedule, eliminate, or delegate (" + incomplete + " open)", t.dateStr, ts);
            try { sendPushToUser(u.id, { title: 'End-of-day review', body: 'You have ' + incomplete + " open task(s). Reschedule, eliminate, or delegate.", url: '/' }); } catch (e) {}
          }
        }
      }
    } catch (e) {}
  }
}

/** Start the once-a-minute workflow ticker (task reminders + 4pm review). */
function startWorkflowTicker() {
  if (workflowJob) return;
  try {
    workflowJob = cron.schedule('* * * * *', function () {
      try { runWorkflowTick(); } catch (e) { console.error('[workflow] tick error:', e && e.message ? e.message : e); }
    });
    console.log('[workflow] scheduled task-reminder + 4pm review ticker (every minute)');
  } catch (e) { console.error('[workflow] failed to start ticker:', e && e.message ? e.message : e); }
}

/** Start the once-a-minute ticker that sends any due scheduled RVMs. */
function startRvmTicker() {
  if (rvmJob) return;
  try {
    const { processDueRvms } = require('./routes/rvm');
    rvmJob = cron.schedule('* * * * *', () => {
      Promise.resolve(processDueRvms()).catch((e) => console.error('[rvm:sched] error:', e && e.message ? e.message : e));
    });
    console.log('[rvm:sched] scheduled RVM ticker (every minute)');
  } catch (e) {
    console.error('[rvm:sched] failed to start ticker:', e && e.message ? e.message : e);
  }
}

function stop() {
  if (job) {
    try { job.stop(); } catch (e) { /* ignore */ }
    job = null;
  }
}

/**
 * Resolve which user owns auto-imported leads. POLICY: the daily auto-import
 * only ever feeds an ADMIN pool — regular reps get their leads by uploading
 * their own CSV. A configured import_owner_id is honored only if that user is
 * an active admin; otherwise we fall back to the first admin.
 */
function resolveImportOwner() {
  const configured = getSetting('import_owner_id');
  if (configured) {
    const u = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'admin' AND active = 1").get(configured);
    if (u) return u.id;
  }
  const admin = db
    .prepare("SELECT id FROM users WHERE role = 'admin' AND active = 1 ORDER BY created_at ASC")
    .get();
  return admin ? admin.id : null;
}

/** Run one auto-import now (used by the cron job). Never throws. */
async function runNow() {
  try {
    const url = getSetting('leadengine_csv_url');
    if (!url) {
      console.log('[leadengine:auto] no saved CSV URL — skipping run');
      return null;
    }
    const ownerId = resolveImportOwner();
    if (!ownerId) {
      console.log('[leadengine:auto] no import owner available — skipping run');
      return null;
    }
    // Lazy require to avoid a circular dependency at module load time.
    const { syncFromCsv } = require('./routes/leadengine');
    const out = await syncFromCsv({ csvUrl: url, ownerId });
    console.log(
      '[leadengine:auto] import done: ' +
      out.inserted + ' new, ' + out.updated + ' updated, ' +
      out.unchanged + ' unchanged, ' + out.queued + ' moved to IN QUEUE' +
      (out.errors && out.errors.length ? ', ' + out.errors.length + ' row error(s)' : '')
    );
    return out;
  } catch (e) {
    console.error('[leadengine:auto] import failed:', e && e.message ? e.message : e);
    return null;
  }
}

/** (Re)schedule the daily auto-import from current settings. Never throws. */
function reschedule() {
  startRvmTicker(); // always run the RVM ticker (independent of Lead Engine)
  startWorkflowTicker(); // task reminders + 4pm review (always on)
  try {
    stop();
    const autoimport = (getSetting('leadengine_autoimport') || 'off') === 'on';
    const url = getSetting('leadengine_csv_url');
    const spec = getSetting('leadengine_cron') || DEFAULT_CRON;

    if (!autoimport || !url) {
      console.log('[leadengine:auto] auto-import is off' + (autoimport && !url ? ' (no CSV URL saved)' : ''));
      return;
    }
    if (!cron.validate(spec)) {
      console.error('[leadengine:auto] invalid cron spec "' + spec + '" — auto-import not scheduled');
      return;
    }
    job = cron.schedule(spec, () => {
      runNow().catch((e) => console.error('[leadengine:auto] unexpected error:', e));
    });
    console.log('[leadengine:auto] scheduled auto-import (cron "' + spec + '")');
  } catch (e) {
    console.error('[leadengine:auto] scheduling error:', e && e.message ? e.message : e);
  }
}

module.exports = { reschedule, runNow, start: reschedule, DEFAULT_CRON };
