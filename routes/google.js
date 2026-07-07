/**
 * routes/google.js — Google Tasks + Calendar integration (OAuth 2.0).
 *
 * Uses ONLY the built-in global fetch (Node 22) — no googleapis dependency.
 * If GOOGLE_CLIENT_ID is unset the feature reports "not configured" and the
 * rest of the app keeps working normally (tasks stay local-only).
 *
 * Mounted at /api/google in server.js WITHOUT a router-level requireAuth:
 * the OAuth callback is hit by a plain browser redirect from Google (no
 * Bearer token), so auth is applied per-route below. The callback proves
 * identity with a short-lived state JWT signed by us in GET /auth.
 */
'use strict';

const express = require('express');
const jwt = require('jsonwebtoken');
const { db, now } = require('../db');
const { requireAuth, JWT_SECRET } = require('../auth');

const router = express.Router();

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';
const GOOGLE_TASKS_URL = 'https://tasks.googleapis.com/tasks/v1/lists/@default/tasks';
const GOOGLE_CAL_EVENTS_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

const SCOPES = 'openid email https://www.googleapis.com/auth/tasks https://www.googleapis.com/auth/calendar.events';

const clientId = () => process.env.GOOGLE_CLIENT_ID || '';
const clientSecret = () => process.env.GOOGLE_CLIENT_SECRET || '';
const redirectUri = () =>
  process.env.GOOGLE_REDIRECT_URI ||
  'https://reneweq-crm-production.up.railway.app/api/google/callback';

/** True when the server has Google OAuth credentials configured. */
function isConfigured() {
  return Boolean(clientId());
}

/** The stored google_accounts row for a user, or null. */
function getAccount(uid) {
  return db.prepare('SELECT * FROM google_accounts WHERE user_id = ?').get(uid) || null;
}

/** Store/refresh an account row (keeps the old refresh_token if Google omits it). */
function upsertAccount(uid, { email, accessToken, refreshToken, expiresIn }) {
  const expiry = new Date(Date.now() + (Number(expiresIn || 3600) - 60) * 1000).toISOString();
  db.prepare(`
    INSERT INTO google_accounts (user_id, email, access_token, refresh_token, token_expiry, connected_at)
    VALUES (@user_id, @email, @access_token, @refresh_token, @token_expiry, @connected_at)
    ON CONFLICT(user_id) DO UPDATE SET
      email         = COALESCE(excluded.email, google_accounts.email),
      access_token  = excluded.access_token,
      refresh_token = COALESCE(excluded.refresh_token, google_accounts.refresh_token),
      token_expiry  = excluded.token_expiry,
      connected_at  = excluded.connected_at
  `).run({
    user_id: uid,
    email: email || null,
    access_token: accessToken,
    refresh_token: refreshToken || null,
    token_expiry: expiry,
    connected_at: now(),
  });
}

/** POST to Google's token endpoint; returns the parsed JSON or null. */
async function tokenRequest(params) {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || !data.access_token) {
    console.error('[google] token request failed:',
      (data && (data.error_description || data.error)) || `HTTP ${res.status}`);
    return null;
  }
  return data;
}

/**
 * getAccessToken(uid) — a valid access token for the user, refreshing via
 * refresh_token when the stored one has expired. Returns null when the
 * feature is unconfigured, the user isn't connected, or refresh fails.
 * Never throws.
 */
async function getAccessToken(uid) {
  try {
    if (!isConfigured()) return null;
    const acct = getAccount(uid);
    if (!acct) return null;

    const fresh = acct.access_token && acct.token_expiry &&
      new Date(acct.token_expiry).getTime() > Date.now();
    if (fresh) return acct.access_token;

    if (!acct.refresh_token) return null;
    const tok = await tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: acct.refresh_token,
      client_id: clientId(),
      client_secret: clientSecret(),
    });
    if (!tok) return null;

    upsertAccount(uid, {
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token, // usually absent on refresh; COALESCE keeps the old one
      expiresIn: tok.expires_in,
    });
    return tok.access_token;
  } catch (e) {
    console.error('[google] getAccessToken error:', e.message);
    return null;
  }
}

/** Extract a readable error message from a Google API JSON error body. */
function apiError(data, status) {
  return (data && data.error && (data.error.message || data.error)) || `Google API HTTP ${status}`;
}

/**
 * pushTaskToGoogle(uid, task) — create the task in Google Tasks (@default
 * list) and, when it has a due_date, an all-day event on the primary
 * calendar. Best-effort: never throws; returns {taskId, eventId, error?}.
 */
async function pushTaskToGoogle(uid, task) {
  const out = { taskId: null, eventId: null };
  try {
    const token = await getAccessToken(uid);
    if (!token) {
      out.error = isConfigured() ? 'Google account not connected' : 'Google integration not configured';
      return out;
    }
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const dueDate = task.due_date ? String(task.due_date).slice(0, 10) : null;

    // --- Google Tasks ------------------------------------------------------
    try {
      const body = { title: task.title || 'CRM task', notes: 'From Wholesale REI CRM' };
      if (dueDate) body.due = `${dueDate}T00:00:00.000Z`; // RFC3339 (date part is honored)
      const res = await fetch(GOOGLE_TASKS_URL, { method: 'POST', headers, body: JSON.stringify(body) });
      const data = await res.json().catch(() => null);
      if (res.ok && data && data.id) out.taskId = data.id;
      else out.error = apiError(data, res.status);
    } catch (e) {
      out.error = e.message;
    }

    // --- Google Calendar (all-day event, only when there is a due date) -----
    if (dueDate) {
      try {
        const event = {
          summary: task.title || 'CRM task',
          description: 'From Wholesale REI CRM',
          start: { date: dueDate },
          end: { date: dueDate },
          reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 0 }] },
        };
        const res = await fetch(GOOGLE_CAL_EVENTS_URL, { method: 'POST', headers, body: JSON.stringify(event) });
        const data = await res.json().catch(() => null);
        if (res.ok && data && data.id) out.eventId = data.id;
        else out.error = out.error || apiError(data, res.status);
      } catch (e) {
        out.error = out.error || e.message;
      }
    }
  } catch (e) {
    out.error = e.message;
  }
  return out;
}

/** Mark the synced Google Task completed. Best-effort; never throws. */
async function completeTaskGoogle(uid, task) {
  try {
    if (!task || !task.google_task_id) return;
    const token = await getAccessToken(uid);
    if (!token) return;
    await fetch(`${GOOGLE_TASKS_URL}/${encodeURIComponent(task.google_task_id)}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'completed' }),
    });
  } catch (e) {
    console.error('[google] completeTaskGoogle error:', e.message);
  }
}

/** Delete the synced Google Task + Calendar event. Best-effort; never throws. */
async function deleteTaskGoogle(uid, task) {
  try {
    if (!task || (!task.google_task_id && !task.google_event_id)) return;
    const token = await getAccessToken(uid);
    if (!token) return;
    const headers = { Authorization: `Bearer ${token}` };
    if (task.google_task_id) {
      await fetch(`${GOOGLE_TASKS_URL}/${encodeURIComponent(task.google_task_id)}`,
        { method: 'DELETE', headers }).catch(() => {});
    }
    if (task.google_event_id) {
      await fetch(`${GOOGLE_CAL_EVENTS_URL}/${encodeURIComponent(task.google_event_id)}`,
        { method: 'DELETE', headers }).catch(() => {});
    }
  } catch (e) {
    console.error('[google] deleteTaskGoogle error:', e.message);
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** GET /api/google/auth — build the consent URL for the signed-in user. */
router.get('/auth', requireAuth, (req, res) => {
  if (!isConfigured()) {
    return res.status(400).json({ error: 'Google integration not configured on this server' });
  }
  // Short-lived state JWT ties the browser redirect back to this CRM user.
  const state = jwt.sign({ uid: req.user.id, g: 'oauth' }, JWT_SECRET, { expiresIn: '10m' });
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri(),
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    state,
  });
  res.json({ url: `${GOOGLE_AUTH_URL}?${params.toString()}` });
});

/**
 * GET /api/google/callback — Google redirects the browser here.
 * NO requireAuth (no Bearer token on a redirect); the state JWT is the auth.
 * Always ends in a 302 back into the SPA.
 */
router.get('/callback', async (req, res) => {
  const fail = () => res.redirect('/?google=error');
  try {
    const { code, state } = req.query;
    if (!isConfigured() || !code || !state) return fail();

    let payload;
    try {
      payload = jwt.verify(String(state), JWT_SECRET);
    } catch {
      return fail();
    }
    const uid = payload && payload.uid;
    if (!uid || !db.prepare('SELECT id FROM users WHERE id = ?').get(uid)) return fail();

    const tok = await tokenRequest({
      grant_type: 'authorization_code',
      code: String(code),
      client_id: clientId(),
      client_secret: clientSecret(),
      redirect_uri: redirectUri(),
    });
    if (!tok) return fail();

    let email = null;
    try {
      const uRes = await fetch(GOOGLE_USERINFO_URL, {
        headers: { Authorization: `Bearer ${tok.access_token}` },
      });
      if (uRes.ok) {
        const info = await uRes.json().catch(() => null);
        email = (info && info.email) || null;
      }
    } catch { /* email is cosmetic — connection still succeeds */ }

    upsertAccount(uid, {
      email,
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token,
      expiresIn: tok.expires_in,
    });
    res.redirect('/?google=connected');
  } catch (e) {
    console.error('[google] callback error:', e.message);
    fail();
  }
});

/** GET /api/google/status — {configured, connected, email}. */
router.get('/status', requireAuth, (req, res) => {
  const acct = isConfigured() ? getAccount(req.user.id) : null;
  res.json({
    configured: isConfigured(),
    connected: Boolean(acct),
    email: acct ? acct.email : null,
  });
});

/** POST /api/google/disconnect — forget the stored tokens for this user. */
router.post('/disconnect', requireAuth, (req, res) => {
  db.prepare('DELETE FROM google_accounts WHERE user_id = ?').run(req.user.id);
  res.json({ ok: true });
});

module.exports = {
  router,
  isConfigured,
  getAccessToken,
  pushTaskToGoogle,
  completeTaskGoogle,
  deleteTaskGoogle,
};
