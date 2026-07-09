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
const { db, getSetting } = require('./db');

const DEFAULT_CRON = '0 6 * * *'; // 6am daily

let job = null;
let rvmJob = null;

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
