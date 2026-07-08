/**
 * routes/microsoft.js — Microsoft To Do + Outlook Calendar integration (OAuth 2.0
 * via Microsoft Graph). Mirrors routes/google.js so each user can connect
 * Google and/or Microsoft independently.
 *
 * Uses ONLY the built-in global fetch (Node 22) — no SDK dependency.
 * If MS_CLIENT_ID is unset the feature reports "not configured" and the rest of
 * the app keeps working normally (tasks stay local-only for that provider).
 *
 * Mounted at /api/microsoft in server.js WITHOUT a router-level requireAuth:
 * the OAuth callback is hit by a plain browser redirect from Microsoft (no
 * Bearer token), so auth is applied per-route below. The callback proves
 * identity with a short-lived state JWT signed by us in GET /auth.
 */
'use strict';

const express = require('express');
const jwt = require('jsonwebtoken');
const { db, now } = require('../db');
const { requireAuth, JWT_SECRET } = require('../auth');

const router = express.Router();

// Tenant: "common" allows both personal Microsoft accounts and work/school.
const TENANT = process.env.MS_TENANT || 'common';
const MS_AUTH_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`;
const MS_TOKEN_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`;
const GRAPH = 'https://graph.microsoft.com/v1.0';
const GRAPH_ME = `${GRAPH}/me`;
const GRAPH_TODO_LISTS = `${GRAPH}/me/todo/lists`;
const GRAPH_EVENTS = `${GRAPH}/me/events`;

// Wall-clock time zone for timed events (same setting the Google side uses).
const CAL_TZ = process.env.CRM_TIMEZONE || 'America/Denver';

// OIDC + Graph delegated scopes. offline_access → refresh tokens.
const SCOPES = 'openid email offline_access User.Read Tasks.ReadWrite Calendars.ReadWrite';

const clientId = () => process.env.MS_CLIENT_ID || '';
const clientSecret = () => process.env.MS_CLIENT_SECRET || '';
const redirectUri = () =>
  process.env.MS_REDIRECT_URI ||
  'https://reneweq-crm-production.up.railway.app/api/microsoft/callback';

/** True when the server has Microsoft OAuth credentials configured. */
function isConfigured() {
  return Boolean(clientId());
}

/** The stored microsoft_accounts row for a user, or null. */
function getAccount(uid) {
  return db.prepare('SELECT * FROM microsoft_accounts WHERE user_id = ?').get(uid) || null;
}

/** Store/refresh an account row (keeps the old refresh_token if MS omits it). */
function upsertAccount(uid, { email, accessToken, refreshToken, expiresIn }) {
  const expiry = new Date(Date.now() + (Number(expiresIn || 3600) - 60) * 1000).toISOString();
  db.prepare(`
    INSERT INTO microsoft_accounts (user_id, email, access_token, refresh_token, token_expiry, connected_at)
    VALUES (@user_id, @email, @access_token, @refresh_token, @token_expiry, @connected_at)
    ON CONFLICT(user_id) DO UPDATE SET
      email         = COALESCE(excluded.email, microsoft_accounts.email),
      access_token  = excluded.access_token,
      refresh_token = COALESCE(excluded.refresh_token, microsoft_accounts.refresh_token),
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

/** POST to Microsoft's token endpoint; returns the parsed JSON or null. */
async function tokenRequest(params) {
  const res = await fetch(MS_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || !data.access_token) {
    console.error('[microsoft] token request failed:',
      (data && (data.error_description || data.error)) || `HTTP ${res.status}`);
    return null;
  }
  return data;
}

/**
 * getAccessToken(uid) — a valid access token for the user, refreshing via
 * refresh_token when the stored one has expired. Returns null when the feature
 * is unconfigured, the user isn't connected, or refresh fails. Never throws.
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
      scope: SCOPES,
    });
    if (!tok) return null;

    upsertAccount(uid, {
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token, // MS usually returns a rotated one; COALESCE keeps old if absent
      expiresIn: tok.expires_in,
    });
    return tok.access_token;
  } catch (e) {
    console.error('[microsoft] getAccessToken error:', e.message);
    return null;
  }
}

/** Extract a readable error from a Graph JSON error body. */
function apiError(data, status) {
  return (data && data.error && (data.error.message || data.error)) || `Graph API HTTP ${status}`;
}

/** id of the user's default To Do list ("Tasks"), or null. */
async function defaultTodoListId(headers) {
  try {
    const res = await fetch(GRAPH_TODO_LISTS, { headers });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || !Array.isArray(data.value)) return null;
    const def = data.value.find((l) => l.wellknownListName === 'defaultList');
    return (def || data.value[0] || {}).id || null;
  } catch {
    return null;
  }
}

/** "YYYY-MM-DD" one day after the given date string. */
function nextDay(dateStr) {
  const [Y, Mo, D] = dateStr.split('-').map((n) => parseInt(n, 10));
  const d = new Date(Date.UTC(Y, Mo - 1, D + 1));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/**
 * pushTaskToMicrosoft(uid, task) — create the task in Microsoft To Do (default
 * list) and, when it has a due_date, an Outlook Calendar event (timed when a
 * start time is set, else all-day). Best-effort: never throws;
 * returns {todoId, eventId, error?}.
 */
async function pushTaskToMicrosoft(uid, task) {
  const out = { todoId: null, eventId: null };
  try {
    const token = await getAccessToken(uid);
    if (!token) {
      out.error = isConfigured() ? 'Microsoft account not connected' : 'Microsoft integration not configured';
      return out;
    }
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const dueDate = task.due_date ? String(task.due_date).slice(0, 10) : null;
    const title = task.title || 'CRM task';

    // --- Microsoft To Do ---------------------------------------------------
    try {
      const listId = await defaultTodoListId(headers);
      if (listId) {
        const body = { title };
        if (dueDate) {
          body.dueDateTime = { dateTime: `${dueDate}T00:00:00.0000000`, timeZone: 'UTC' };
        }
        const res = await fetch(`${GRAPH_TODO_LISTS}/${encodeURIComponent(listId)}/tasks`,
          { method: 'POST', headers, body: JSON.stringify(body) });
        const data = await res.json().catch(() => null);
        if (res.ok && data && data.id) out.todoId = data.id;
        else out.error = apiError(data, res.status);
      } else {
        out.error = 'No Microsoft To Do list found';
      }
    } catch (e) {
      out.error = e.message;
    }

    // --- Outlook Calendar --------------------------------------------------
    if (dueDate) {
      try {
        const tm = task.due_time ? String(task.due_time).match(/^(\d{1,2}):(\d{2})/) : null;
        let event;
        if (tm) {
          const hh = String(Math.min(23, parseInt(tm[1], 10))).padStart(2, '0');
          const mm = String(Math.min(59, parseInt(tm[2], 10))).padStart(2, '0');
          const dur = (Number.isFinite(task.duration_min) && task.duration_min > 0)
            ? task.duration_min : 30;
          const [Y, Mo, D] = dueDate.split('-').map((n) => parseInt(n, 10));
          const startMs = Date.UTC(Y, Mo - 1, D, parseInt(hh, 10), parseInt(mm, 10), 0);
          const e = new Date(startMs + dur * 60000); // read back as UTC wall clock
          const pad = (n) => String(n).padStart(2, '0');
          const endLocal = `${e.getUTCFullYear()}-${pad(e.getUTCMonth() + 1)}-${pad(e.getUTCDate())}` +
            `T${pad(e.getUTCHours())}:${pad(e.getUTCMinutes())}:00`;
          event = {
            subject: title,
            body: { contentType: 'text', content: 'From Wholesale REI CRM' },
            start: { dateTime: `${dueDate}T${hh}:${mm}:00`, timeZone: CAL_TZ },
            end: { dateTime: endLocal, timeZone: CAL_TZ },
            isReminderOn: true,
          };
        } else {
          event = {
            subject: title,
            body: { contentType: 'text', content: 'From Wholesale REI CRM' },
            isAllDay: true,
            start: { dateTime: `${dueDate}T00:00:00`, timeZone: CAL_TZ },
            end: { dateTime: `${nextDay(dueDate)}T00:00:00`, timeZone: CAL_TZ },
          };
        }
        const res = await fetch(GRAPH_EVENTS, { method: 'POST', headers, body: JSON.stringify(event) });
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

/** Mark the synced To Do task completed. Best-effort; never throws. */
async function completeTaskMicrosoft(uid, task) {
  try {
    if (!task || !task.ms_todo_id) return;
    const token = await getAccessToken(uid);
    if (!token) return;
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const listId = await defaultTodoListId(headers);
    if (!listId) return;
    await fetch(`${GRAPH_TODO_LISTS}/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(task.ms_todo_id)}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ status: 'completed' }),
    });
  } catch (e) {
    console.error('[microsoft] completeTaskMicrosoft error:', e.message);
  }
}

/** Delete the synced To Do task + Outlook event. Best-effort; never throws. */
async function deleteTaskMicrosoft(uid, task) {
  try {
    if (!task || (!task.ms_todo_id && !task.ms_event_id)) return;
    const token = await getAccessToken(uid);
    if (!token) return;
    const headers = { Authorization: `Bearer ${token}` };
    if (task.ms_todo_id) {
      const listId = await defaultTodoListId({ ...headers, 'Content-Type': 'application/json' });
      if (listId) {
        await fetch(`${GRAPH_TODO_LISTS}/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(task.ms_todo_id)}`,
          { method: 'DELETE', headers }).catch(() => {});
      }
    }
    if (task.ms_event_id) {
      await fetch(`${GRAPH_EVENTS}/${encodeURIComponent(task.ms_event_id)}`,
        { method: 'DELETE', headers }).catch(() => {});
    }
  } catch (e) {
    console.error('[microsoft] deleteTaskMicrosoft error:', e.message);
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** GET /api/microsoft/auth — build the consent URL for the signed-in user. */
router.get('/auth', requireAuth, (req, res) => {
  if (!isConfigured()) {
    return res.status(400).json({ error: 'Microsoft integration not configured on this server' });
  }
  const state = jwt.sign({ uid: req.user.id, g: 'msoauth' }, JWT_SECRET, { expiresIn: '10m' });
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri(),
    response_type: 'code',
    response_mode: 'query',
    scope: SCOPES,
    state,
  });
  res.json({ url: `${MS_AUTH_URL}?${params.toString()}` });
});

/**
 * GET /api/microsoft/callback — Microsoft redirects the browser here.
 * NO requireAuth; the state JWT is the auth. Always ends in a 302 into the SPA.
 */
router.get('/callback', async (req, res) => {
  const fail = () => res.redirect('/?microsoft=error');
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
      scope: SCOPES,
    });
    if (!tok) return fail();

    let email = null;
    try {
      const uRes = await fetch(GRAPH_ME, { headers: { Authorization: `Bearer ${tok.access_token}` } });
      if (uRes.ok) {
        const info = await uRes.json().catch(() => null);
        email = (info && (info.mail || info.userPrincipalName)) || null;
      }
    } catch { /* email is cosmetic — connection still succeeds */ }

    upsertAccount(uid, {
      email,
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token,
      expiresIn: tok.expires_in,
    });
    res.redirect('/?microsoft=connected');
  } catch (e) {
    console.error('[microsoft] callback error:', e.message);
    fail();
  }
});

/** GET /api/microsoft/status — {configured, connected, email}. */
router.get('/status', requireAuth, (req, res) => {
  const acct = isConfigured() ? getAccount(req.user.id) : null;
  res.json({
    configured: isConfigured(),
    connected: Boolean(acct),
    email: acct ? acct.email : null,
  });
});

/** POST /api/microsoft/disconnect — forget the stored tokens for this user. */
router.post('/disconnect', requireAuth, (req, res) => {
  db.prepare('DELETE FROM microsoft_accounts WHERE user_id = ?').run(req.user.id);
  res.json({ ok: true });
});

module.exports = {
  router,
  isConfigured,
  getAccessToken,
  pushTaskToMicrosoft,
  completeTaskMicrosoft,
  deleteTaskMicrosoft,
};
