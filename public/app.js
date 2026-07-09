/* ============================================================
   Wholesale REI CRM — frontend (vanilla JS, no dependencies)
   Talks to REST API at /api (same origin), JWT bearer auth.
   ============================================================ */
'use strict';

/* ------------------------------ Constants ------------------------------ */

const STAGES = [
  'Prospect', 'Offer Delivered', 'Offer Accepted', 'Property Analyzer Run',
  'BOG Walk Through', 'EMD Sent', 'Dispo', 'Assigned', 'Closed'
];

const TOKEN_KEY = 'crm_token';

/* ------------------------------ State ------------------------------ */

const state = {
  token: localStorage.getItem(TOKEN_KEY) || null,
  user: null,
  config: { messagingMode: 'stub' },
  contacts: [],
  tasks: [],
  users: [],
  assignees: [], // active users for task assignment (all roles can load this)
  google: null, // {configured, connected, email} from /api/google/status
  microsoft: null, // {configured, connected, email} from /api/microsoft/status
  twilio: { status: null, device: null, call: null, incoming: null, muted: false, seconds: 0, timer: null, contactId: null, contactName: '', number: '', direction: 'outbound', note: '' },
  pipelineSearch: '', // live filter on the Pipeline board (name/phone/email/address)
  tab: 'pipeline',
  contactSearch: '',
  contactList: null, // server-filtered list for the Contacts view
  filters: { q: '', city: '', state: '', agent: '', fsbo: '', grade: '', leadStatus: '' },
  sort: { key: '', dir: 1 },   // Contacts table client-side sort
  selected: {},                // Contacts table bulk selection (id -> true)
  registerMode: false
};

/* ------------------------------ API wrapper ------------------------------ */

async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined && body !== null) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  if (state.token) opts.headers['Authorization'] = 'Bearer ' + state.token;

  let res;
  try {
    res = await fetch('/api' + path, opts);
  } catch (e) {
    throw new Error('Network error — is the server running?');
  }

  if (res.status === 401) {
    // token invalid/expired: drop session and show login
    clearSession();
    showLogin();
    throw new Error('Session expired. Please sign in again.');
  }

  let data = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.indexOf('application/json') !== -1) {
    data = await res.json().catch(function () { return null; });
  }
  if (!res.ok) {
    const msg = (data && (data.error || data.message)) || ('Request failed (' + res.status + ')');
    throw new Error(msg);
  }
  return data;
}

/* ------------------------------ Small helpers ------------------------------ */

function $(sel, root) { return (root || document).querySelector(sel); }
function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escAttr(v) { return esc(v); }

/* Parse a value that may already be an array or a JSON string. */
function parseArr(v, fallback) {
  if (Array.isArray(v)) return v.slice();
  if (typeof v === 'string' && v.trim()) {
    try {
      const p = JSON.parse(v);
      if (Array.isArray(p)) return p;
    } catch (e) { /* ignore */ }
  }
  return fallback.slice();
}

function getTexts(c) {
  const a = parseArr(c && c.texts, ['', '', '', '']);
  while (a.length < 4) a.push('');
  return a.slice(0, 4);
}
function getTextStatus(c) {
  const a = parseArr(c && c.textStatus, [false, false, false, false]);
  while (a.length < 4) a.push(false);
  return a.slice(0, 4).map(Boolean);
}
function truthy(v) { return v === true || v === 1 || v === '1' || v === 'true'; }

function debounce(fn, ms) {
  let timer = null;
  return function () {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}

function dateInputVal(v) {
  if (!v) return '';
  const s = String(v);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}
function fmtDate(v) {
  const d = dateInputVal(v);
  return d || '';
}
function fmtTimestamp(v) {
  if (!v) return '';
  const d = new Date(v);
  if (isNaN(d.getTime())) return String(v);
  return d.toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

let toastTimer = null;
function toast(msg, kind) {
  let t = $('#toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.className = kind || '';
  t.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { t.style.display = 'none'; }, 3500);
}
function toastErr(e) { toast(e && e.message ? e.message : String(e), 'error'); }

/* ------------------------------ Session ------------------------------ */

function setSession(token, user) {
  state.token = token;
  state.user = user || null;
  localStorage.setItem(TOKEN_KEY, token);
}
function clearSession() {
  state.token = null;
  state.user = null;
  localStorage.removeItem(TOKEN_KEY);
}

/* ------------------------------ Auth screen ------------------------------ */

function showLogin() {
  $('#app').classList.add('hidden');
  $('#login').classList.remove('hidden');
  closeModal();
  $('#authErr').textContent = '';
}

function applyRegisterMode() {
  const reg = state.registerMode;
  $('#regNameField').style.display = reg ? '' : 'none';
  $('#authSub').textContent = reg ? 'Create your account' : 'Sign in to your workspace';
  $('#authSubmit').textContent = reg ? 'Create account' : 'Sign in';
  $('#authToggleLabel').textContent = reg ? 'Already have an account?' : 'Need an account?';
  $('#authToggle').textContent = reg ? 'Sign in instead' : 'Create account';
  $('#authErr').textContent = '';
}

async function submitAuth() {
  const errBox = $('#authErr');
  errBox.textContent = '';
  const email = $('#authEmail').value.trim();
  const password = $('#authPassword').value;
  const name = $('#authName').value.trim();

  if (!email || !password || (state.registerMode && !name)) {
    errBox.textContent = 'Please fill in all fields.';
    return;
  }
  const btn = $('#authSubmit');
  btn.disabled = true;
  try {
    let out;
    if (state.registerMode) {
      out = await api('POST', '/auth/register', { name: name, email: email, password: password });
    } else {
      out = await api('POST', '/auth/login', { email: email, password: password });
    }
    // 2FA challenge: password accepted, now a code is required.
    if (out && out.twofaRequired) {
      state.twofaTicket = out.ticket;
      showTwoFactorPrompt();
      return;
    }
    finishLogin(out);
  } catch (e) {
    errBox.textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}

/** Complete a login response: store session, flag forced admin 2FA, boot. */
async function finishLogin(out) {
  state.force2faSetup = !!(out && out.require2faSetup);
  setSession(out.token, out.user);
  $('#authPassword').value = '';
  const code = $('#twofaCode'); if (code) code.value = '';
  await bootApp();
}

/** Swap the login card into "enter your 2FA code" mode. */
function showTwoFactorPrompt() {
  $('#authErr').textContent = '';
  ['regNameField', 'authSubmit', 'authTogglRow'].forEach(function (id) {
    const el = document.getElementById(id); if (el) el.style.display = 'none';
  });
  ['authEmail', 'authPassword'].forEach(function (id) {
    const el = document.getElementById(id); if (el) el.closest('.field').style.display = 'none';
  });
  const box = $('#twofaBox'); if (box) box.style.display = '';
  const code = $('#twofaCode'); if (code) { code.value = ''; code.focus(); }
}

/** Return the login card to its normal email/password state. */
function resetLoginForm() {
  ['authSubmit', 'authTogglRow'].forEach(function (id) {
    const el = document.getElementById(id); if (el) el.style.display = '';
  });
  ['authEmail', 'authPassword'].forEach(function (id) {
    const el = document.getElementById(id); if (el) el.closest('.field').style.display = '';
  });
  const reg = $('#regNameField'); if (reg) reg.style.display = state.registerMode ? '' : 'none';
  const box = $('#twofaBox'); if (box) box.style.display = 'none';
  $('#authErr').textContent = '';
}

async function submitTwoFactor() {
  const errBox = $('#authErr');
  errBox.textContent = '';
  const code = ($('#twofaCode').value || '').trim();
  if (!code) { errBox.textContent = 'Enter the 6-digit code from your authenticator app.'; return; }
  const btn = $('#twofaSubmit'); btn.disabled = true;
  try {
    const out = await api('POST', '/auth/login/2fa', { ticket: state.twofaTicket, code: code });
    state.twofaTicket = null;
    resetLoginForm();
    finishLogin(out);
  } catch (e) {
    errBox.textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}

/* ------------------------------ App boot ------------------------------ */

async function bootApp() {
  // Confirm token / load user
  try {
    state.user = await api('GET', '/me');
  } catch (e) {
    clearSession();
    showLogin();
    return;
  }
  try {
    state.config = await api('GET', '/config') || { messagingMode: 'stub' };
  } catch (e) {
    state.config = { messagingMode: 'stub' };
  }
  await refreshGoogleStatus(); // never throws
  await refreshMicrosoftStatus(); // never throws
  await refreshTwilioStatus(); // never throws

  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');

  // header
  const u = state.user || {};
  $('#whoBox').innerHTML = '<b>' + esc(u.name) + '</b><br>' + esc(u.email) + ' &middot; ' + esc(u.role || 'user');
  const badge = $('#modeBadge');
  if (state.config.messagingMode === 'live') {
    badge.textContent = 'Live messaging';
    badge.className = 'mode-badge live';
  } else {
    badge.textContent = 'Stub mode';
    badge.className = 'mode-badge';
  }
  $('#teamTabBtn').classList.toggle('hidden', !isAdmin());

  // Admins: preload the user list so the "view by owner" filter shows names.
  if (isAdmin()) { await refreshUsers().catch(function () {}); }

  await refreshContacts().catch(toastErr);
  switchTab('pipeline');

  // If this admin still owes 2FA setup (required for their role), prompt now.
  if (state.force2faSetup) { state.force2faSetup = false; openTwoFactorSetup(true); }

  // Unread calls/texts/voicemails alert badge (poll every 45s) + push.
  setupVoicemailBadge();
  refreshVoicemailBadge();
  if (!state._vmPoll) state._vmPoll = setInterval(refreshVoicemailBadge, 45000);
  registerServiceWorker();
  setupPush();
  setupNativePush();
}

function isAdmin() { return state.user && state.user.role === 'admin'; }

async function refreshContacts() {
  // Admin lead view filter: 'mine' | '<userId>' | '' (all). Non-admins are
  // always scoped to themselves by the server regardless of this value.
  let qs = '';
  if (isAdmin() && state.leadOwnerFilter) {
    qs = state.leadOwnerFilter === 'mine'
      ? '?mine=true'
      : '?owner=' + encodeURIComponent(state.leadOwnerFilter);
  }
  state.contacts = await api('GET', '/contacts' + qs) || [];
}

/** Build the admin "view by owner" dropdown (All / Mine / each user). */
function ownerFilterHtml() {
  if (!isAdmin()) return '';
  const cur = state.leadOwnerFilter || '';
  let opts = '<option value=""' + (cur === '' ? ' selected' : '') + '>All users</option>' +
    '<option value="mine"' + (cur === 'mine' ? ' selected' : '') + '>My leads only</option>';
  (state.users || []).forEach(function (u) {
    if (state.user && String(u.id) === String(state.user.id)) return; // "mine" covers self
    opts += '<option value="' + escAttr(u.id) + '"' + (String(cur) === String(u.id) ? ' selected' : '') + '>' + esc(u.name) + '</option>';
  });
  return '<select class="inline" id="ownerFilter" title="View leads by owner">' + opts + '</select>';
}

/** Wire the owner-filter dropdown (if present) to reload + re-render. */
function wireOwnerFilter(rerender) {
  const sel = $('#ownerFilter');
  if (!sel) return;
  sel.addEventListener('change', async function () {
    state.leadOwnerFilter = sel.value || '';
    try { await refreshContacts(); } catch (e) { toastErr(e); }
    if (typeof rerender === 'function') rerender();
  });
}
async function refreshTasks() {
  state.tasks = await api('GET', '/tasks') || [];
}
async function refreshUsers() {
  state.users = await api('GET', '/users') || [];
}
async function refreshAssignees() {
  // Active users any role can assign tasks to (id, name, active).
  try { state.assignees = await api('GET', '/tasks/assignees') || []; }
  catch (e) { state.assignees = []; }
}
async function refreshGoogleStatus() {
  try {
    state.google = await api('GET', '/google/status');
  } catch (e) {
    state.google = null; // older server / fetch failure — treat as unavailable
  }
  return state.google;
}
async function refreshMicrosoftStatus() {
  try {
    state.microsoft = await api('GET', '/microsoft/status');
  } catch (e) {
    state.microsoft = null; // older server / fetch failure — treat as unavailable
  }
  return state.microsoft;
}

/* ------------------------- Twilio softphone + SMS ------------------------- */

async function refreshTwilioStatus() {
  try {
    state.twilio.status = await api('GET', '/twilio/status');
  } catch (e) {
    state.twilio.status = null;
  }
  // Register the browser device for calls when Voice is configured.
  if (state.twilio.status && state.twilio.status.voiceConfigured) {
    initTwilioDevice(); // fire-and-forget; never throws
  }
  return state.twilio.status;
}

/** Initialize (or re-initialize) the Twilio Voice Device for this browser. */
async function initTwilioDevice() {
  if (state.twilio.device) return; // already set up
  if (typeof Twilio === 'undefined' || !Twilio.Device) {
    console.warn('[twilio] Voice SDK not loaded');
    return;
  }
  try {
    const r = await api('GET', '/twilio/token');
    if (!r || !r.token) return;
    const device = new Twilio.Device(r.token, { codecPreferences: ['opus', 'pcmu'], logLevel: 'error' });
    device.on('registered', function () { console.log('[twilio] device registered'); });
    device.on('error', function (e) { console.error('[twilio] device error:', e && e.message); });
    device.on('incoming', onTwilioIncoming);
    device.on('tokenWillExpire', async function () {
      try { const t = await api('GET', '/twilio/token'); if (t && t.token) device.updateToken(t.token); }
      catch (e) { /* ignore */ }
    });
    await device.register();
    state.twilio.device = device;
  } catch (e) {
    console.error('[twilio] init failed:', e);
  }
}

function twilioReady() { return !!(state.twilio.status && state.twilio.status.voiceConfigured && state.twilio.device); }

/** Place an outbound call from the browser to a contact's number. */
async function placeCall(number, contactId, contactName) {
  if (!number) { toast('No phone number for this contact.', 'error'); return; }
  if (!twilioReady()) {
    if (!state.twilio.status || !state.twilio.status.voiceConfigured) { toast('Calling is not configured yet.', 'error'); return; }
    toast('Phone still connecting — try again in a moment.', 'error');
    initTwilioDevice();
    return;
  }
  if (state.twilio.call || state.twilio.incoming) { toast('Already on a call.', 'error'); return; }
  try {
    const call = await state.twilio.device.connect({ params: { To: number } });
    const t = state.twilio;
    t.call = call; t.number = number; t.contactId = contactId || null; t.contactName = contactName || '';
    t.direction = 'outbound'; t.note = ''; t.seconds = 0; t.muted = false;
    wireCall(call);
    startCallTimer();
    renderCallWidget();
  } catch (e) {
    console.error('[twilio] connect failed:', e);
    toast('Could not start the call.', 'error');
  }
}

/** Handle an inbound call ringing at this browser. */
function onTwilioIncoming(call) {
  if (state.twilio.call) { call.reject(); return; } // busy
  const from = (call.parameters && call.parameters.From) || '';
  const match = findContactByNumberLocal(from);
  const t = state.twilio;
  t.incoming = call; t.number = from; t.contactId = match ? match.id : null;
  t.contactName = match ? (match.name || '') : ''; t.direction = 'inbound'; t.note = ''; t.seconds = 0; t.muted = false;
  call.on('cancel', function () { // caller hung up before we answered
    state.twilio.incoming = null; renderCallWidget();
  });
  call.on('disconnect', onCallEnd);
  renderCallWidget();
}

function acceptIncoming() {
  const t = state.twilio;
  if (!t.incoming) return;
  const call = t.incoming;
  call.accept();
  t.call = call; t.incoming = null;
  wireCall(call);
  startCallTimer();
  renderCallWidget();
}

function rejectIncoming() {
  const t = state.twilio;
  if (t.incoming) { try { t.incoming.reject(); } catch (e) {} }
  t.incoming = null;
  renderCallWidget();
}

function wireCall(call) {
  call.on('disconnect', onCallEnd);
  call.on('error', function (e) { console.error('[twilio] call error:', e && e.message); });
}

function toggleMute() {
  const t = state.twilio;
  if (!t.call) return;
  t.muted = !t.muted;
  try { t.call.mute(t.muted); } catch (e) {}
  renderCallWidget();
}

function hangup() {
  const t = state.twilio;
  if (t.call) { try { t.call.disconnect(); } catch (e) {} }
}

/** Called when a live call ends — auto-log it with duration + notes. */
async function onCallEnd() {
  const t = state.twilio;
  stopCallTimer();
  const contactId = t.contactId, direction = t.direction, note = t.note, seconds = t.seconds;
  // reset call state (keep widget briefly to show it closed)
  t.call = null; t.incoming = null; t.muted = false;
  renderCallWidget();
  if (contactId) {
    try {
      await api('POST', '/contacts/' + contactId + '/activities', {
        type: 'call', direction: direction, body: note || '', mode: 'automated',
        status: 'completed', duration_sec: seconds,
      });
      toast('Call logged (' + fmtDur(seconds) + ').', 'ok');
      if (state.openContactId === contactId) loadActivities(contactId);
    } catch (e) { toastErr(e); }
  }
  t.contactId = null; t.contactName = ''; t.number = ''; t.note = ''; t.seconds = 0;
}

function startCallTimer() {
  stopCallTimer();
  state.twilio.timer = setInterval(function () {
    state.twilio.seconds++;
    const el = document.getElementById('cwTimer');
    if (el) el.textContent = fmtDur(state.twilio.seconds);
  }, 1000);
}
function stopCallTimer() {
  if (state.twilio.timer) { clearInterval(state.twilio.timer); state.twilio.timer = null; }
}

function fmtDur(sec) {
  sec = Math.max(0, parseInt(sec, 10) || 0);
  const m = Math.floor(sec / 60), s = sec % 60;
  return m + ':' + (s < 10 ? '0' + s : s);
}

/** Match an inbound number to a loaded contact (trailing 10 digits). */
function findContactByNumberLocal(num) {
  const digits = String(num || '').replace(/[^0-9]/g, '');
  if (digits.length < 7) return null;
  const last10 = digits.slice(-10);
  return (state.contacts || []).find(function (c) {
    if (!c.phone) return false;
    return String(c.phone).replace(/[^0-9]/g, '').slice(-10) === last10;
  }) || null;
}

/** Render the floating call widget based on current Twilio state. */
function renderCallWidget() {
  const w = document.getElementById('callWidget');
  if (!w) return;
  const t = state.twilio;
  if (!t.call && !t.incoming) { w.classList.add('hidden'); w.innerHTML = ''; return; }
  w.classList.remove('hidden');

  // Incoming (ringing, not yet accepted)
  if (t.incoming && !t.call) {
    w.innerHTML =
      '<div class="cw-head">Incoming call</div>' +
      '<div class="cw-num">' + esc(t.number || 'Unknown') + (t.contactName ? ' &middot; ' + esc(t.contactName) : '') + '</div>' +
      '<div class="cw-actions">' +
        '<button class="btn small" id="cwAccept">Accept</button>' +
        '<button class="btn ghost small danger" id="cwReject">Reject</button>' +
      '</div>';
    document.getElementById('cwAccept').onclick = acceptIncoming;
    document.getElementById('cwReject').onclick = rejectIncoming;
    return;
  }

  // Active call
  w.innerHTML =
    '<div class="cw-head">' + (t.direction === 'inbound' ? 'On call — incoming' : 'On call') + '</div>' +
    '<div class="cw-num">' + esc(t.number || '') + (t.contactName ? ' &middot; ' + esc(t.contactName) : '') + '</div>' +
    '<div class="cw-timer" id="cwTimer">' + fmtDur(t.seconds) + '</div>' +
    '<textarea id="cwNote" class="cw-note" placeholder="Call notes — saved automatically when the call ends...">' + esc(t.note || '') + '</textarea>' +
    '<div class="cw-actions">' +
      '<button class="btn ghost small" id="cwMute">' + (t.muted ? 'Unmute' : 'Mute') + '</button>' +
      '<button class="btn small danger" id="cwHang">Hang up</button>' +
    '</div>';
  const noteEl = document.getElementById('cwNote');
  if (noteEl) noteEl.addEventListener('input', function () { state.twilio.note = this.value; });
  document.getElementById('cwMute').onclick = toggleMute;
  document.getElementById('cwHang').onclick = hangup;
}

/** Send an SMS to a contact through the CRM number, then refresh the log. */
async function sendContactSms(contactId, number, body, btn) {
  if (!body || !body.trim()) { toast('Type a message first.', 'error'); return false; }
  if (btn) btn.disabled = true;
  try {
    const r = await api('POST', '/twilio/sms', { contactId: contactId, to: number, body: body.trim() });
    if (r && r.ok) toast('Text sent.', 'ok');
    else toast('Text: ' + ((r && r.status) || 'not sent'), 'error');
    if (state.openContactId === contactId) loadActivities(contactId);
    return !!(r && r.ok);
  } catch (e) { toastErr(e); return false; }
  finally { if (btn) btn.disabled = false; }
}

/* After returning from a provider's consent screen the callback redirects to
   /?google=... or /?microsoft=... — show a toast, then clean the URL. */
function handleGoogleReturnParam() {
  let params;
  try { params = new URLSearchParams(window.location.search); }
  catch (e) { return; }
  let changed = false;
  if (params.has('google')) {
    const v = params.get('google');
    if (v === 'connected') toast('Google account connected — tasks will sync.', 'ok');
    else toast('Google connection failed. Please try again.', 'error');
    params.delete('google'); changed = true;
  }
  if (params.has('microsoft')) {
    const v = params.get('microsoft');
    if (v === 'connected') toast('Microsoft account connected — tasks will sync.', 'ok');
    else toast('Microsoft connection failed. Please try again.', 'error');
    params.delete('microsoft'); changed = true;
  }
  if (!changed) return;
  const rest = params.toString();
  window.history.replaceState({}, '', window.location.pathname + (rest ? '?' + rest : ''));
}

/* ------------------------------ Tabs ------------------------------ */

function switchTab(tab) {
  if (tab === 'team' && !isAdmin()) tab = 'pipeline';
  state.tab = tab;
  $all('#navTabs button').forEach(function (b) {
    b.classList.toggle('active', b.getAttribute('data-tab') === tab);
  });
  $all('.view').forEach(function (v) { v.classList.add('hidden'); });
  const view = $('#view-' + tab);
  if (view) view.classList.remove('hidden');

  if (tab === 'pipeline') renderPipeline();
  else if (tab === 'contacts') renderContacts();
  else if (tab === 'tasks') loadAndRenderTasks();
  else if (tab === 'team') loadAndRenderTeam();
  else if (tab === 'leadengine') renderLeadEngine();
  else if (tab === 'settings') renderSettings();
}

/* ------------------------------ Pipeline ------------------------------ */

function renderPipeline() {
  const root = $('#view-pipeline');
  root.innerHTML = '' +
    '<div class="viewhead">' +
    '  <h2>Pipeline</h2>' +
    '  <button class="btn" id="npBtn">+ New Contact</button>' +
    '  <button class="btn blue" id="alBtn">+ Add Lead</button>' +
    '  <input class="search big" id="pipeSearch" type="search" placeholder="Search name, phone, email, or address…" value="' + escAttr(state.pipelineSearch || '') + '">' +
    '  <select class="search sm" id="pipeSort" title="Sort cards within each stage">' +
    [['newest', 'Newest first'], ['oldest', 'Oldest first'], ['address', 'Address (A–Z)'],
     ['city', 'City (A–Z)'], ['state', 'State (A–Z)'], ['name', 'Contact name (A–Z)'], ['grade', 'Grade (A→F)']]
      .map(function (o) { return '<option value="' + o[0] + '"' + ((state.pipelineSort || 'newest') === o[0] ? ' selected' : '') + '>Sort: ' + o[1] + '</option>'; }).join('') +
    '  </select>' +
    ownerFilterHtml() +
    '  <span class="hint">Drag cards between stages to update.</span>' +
    '</div>' +
    '<div class="board" id="board"></div>';

  $('#npBtn').addEventListener('click', function () { openContactModal(null); });
  $('#alBtn').addEventListener('click', openLeadIntake);
  wireOwnerFilter(function () { renderPipeline(); });

  const search = $('#pipeSearch');
  if (search) {
    search.addEventListener('input', function () {
      state.pipelineSearch = this.value;
      renderPipelineBoard(); // re-render only the board so the input keeps focus
    });
  }
  const sortSel = $('#pipeSort');
  if (sortSel) sortSel.addEventListener('change', function () {
    state.pipelineSort = this.value;
    renderPipelineBoard();
  });

  renderPipelineBoard();
}

/** Comparator for the pipeline sort dropdown. */
function pipelineSortCards(cards) {
  const mode = state.pipelineSort || 'newest';
  const arr = cards.slice();
  const txt = function (v) { return String(v || '').trim().toLowerCase(); };
  const dt = function (c) { return c.imported_at || c.created_at || ''; };
  arr.sort(function (a, b) {
    if (mode === 'newest') return String(dt(b)).localeCompare(String(dt(a)));
    if (mode === 'oldest') return String(dt(a)).localeCompare(String(dt(b)));
    if (mode === 'grade') return txt(a.grade || 'z').localeCompare(txt(b.grade || 'z'));
    let key = 'property';
    if (mode === 'city') key = 'city';
    else if (mode === 'state') key = 'state';
    else if (mode === 'name') key = 'name';
    const av = txt(a[key]), bv = txt(b[key]);
    if (!av && bv) return 1;      // blanks last
    if (av && !bv) return -1;
    return av.localeCompare(bv);
  });
  return arr;
}

/** True if a contact matches the live pipeline search (name/phone/email/address). */
function pipelineMatches(c, q) {
  const needle = String(q || '').trim().toLowerCase();
  if (!needle) return true;
  return [c.name, c.phone, c.email, c.property].some(function (v) {
    return String(v || '').toLowerCase().indexOf(needle) !== -1;
  });
}

/** Render (or re-render) just the pipeline board columns + wiring. */
function renderPipelineBoard() {
  const board = $('#board');
  if (!board) return;
  const q = state.pipelineSearch || '';
  let html = '';
  STAGES.forEach(function (stage) {
    const cards = pipelineSortCards(state.contacts.filter(function (c) {
      return (c.stage || STAGES[0]) === stage && pipelineMatches(c, q);
    }));
    html += '<div class="col" data-stage="' + escAttr(stage) + '">' +
      '<h3><span>' + esc(stage) + '</span><span class="count">' + cards.length + '</span></h3>' +
      '<div class="cards" data-stage="' + escAttr(stage) + '">';
    cards.forEach(function (c) { html += pipelineCardHtml(c); });
    html += '</div></div>';
  });
  board.innerHTML = html;

  // card events
  $all('.pcard', board).forEach(wirePipelineCard);

  // column drop targets
  $all('.col', board).forEach(function (col) {
    col.addEventListener('dragover', function (ev) {
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'move';
      col.classList.add('dragover');
    });
    col.addEventListener('dragleave', function (ev) {
      if (!col.contains(ev.relatedTarget)) col.classList.remove('dragover');
    });
    col.addEventListener('drop', async function (ev) {
      ev.preventDefault();
      col.classList.remove('dragover');
      const id = ev.dataTransfer.getData('text/plain');
      const stage = col.getAttribute('data-stage');
      const c = state.contacts.find(function (x) { return String(x.id) === String(id); });
      if (!c || !stage || c.stage === stage) return;
      const prev = c.stage;
      c.stage = stage;
      movePipelineCard(id, stage); // targeted move — no full re-render
      try {
        const updated = await api('PATCH', '/contacts/' + encodeURIComponent(id), { stage: stage });
        if (updated) replaceContact(updated);
        toast('Moved "' + (c.name || 'contact') + '" to ' + stage, 'ok');
      } catch (e) {
        c.stage = prev;
        movePipelineCard(id, prev);
        toastErr(e);
      }
    });
  });
}

/** Attach click + drag handlers to a single pipeline card element. */
function wirePipelineCard(card) {
  const board = $('#board');
  card.addEventListener('click', function () {
    const id = card.getAttribute('data-id');
    const c = state.contacts.find(function (x) { return String(x.id) === String(id); });
    if (c) openContactModal(c);
  });
  card.addEventListener('dragstart', function (ev) {
    ev.dataTransfer.setData('text/plain', String(card.getAttribute('data-id')));
    ev.dataTransfer.effectAllowed = 'move';
    card.classList.add('dragging');
    if (board) board.classList.add('is-dragging');
  });
  card.addEventListener('dragend', function () {
    card.classList.remove('dragging');
    if (board) {
      board.classList.remove('is-dragging');
      $all('.col.dragover', board).forEach(function (col) { col.classList.remove('dragover'); });
    }
  });
}

/** Move one card into the target stage column in-place (no board rebuild). */
function movePipelineCard(id, stage) {
  const board = $('#board');
  if (!board) return;
  const oldCard = board.querySelector('.pcard[data-id="' + id + '"]');
  const targetCol = board.querySelector('.col[data-stage="' + escAttr(stage) + '"]');
  const targetCards = targetCol ? targetCol.querySelector('.cards') : null;
  const c = state.contacts.find(function (x) { return String(x.id) === String(id); });
  if (!oldCard || !targetCards || !c) { renderPipelineBoard(); return; }
  // Rebuild the card fresh so stage-dependent tags (e.g. NEW LEAD) stay correct.
  const tmp = document.createElement('div');
  tmp.innerHTML = pipelineCardHtml(c);
  const newCard = tmp.firstChild;
  oldCard.remove();
  targetCards.insertBefore(newCard, targetCards.firstChild);
  wirePipelineCard(newCard);
  refreshPipelineCounts();
}

/** Recompute the little count badge on each pipeline column header. */
function refreshPipelineCounts() {
  const board = $('#board');
  if (!board) return;
  $all('.col', board).forEach(function (col) {
    const n = $all('.pcard', col).length;
    const badge = col.querySelector('h3 .count');
    if (badge) badge.textContent = n;
  });
}

function pipelineCardHtml(c) {
  let meta = '';
  if (c.lead_status) meta += leadStatusBadge(c);
  if ((c.source === 'Lead' || c.source === 'Lead Engine') && (c.stage || STAGES[0]) === 'Prospect') meta += '<span class="tag lead">NEW LEAD</span>';
  if (truthy(c.isFsbo)) meta += '<span class="tag warn">FSBO</span>';
  if (isAdmin() && c.ownerName) meta += '<span class="tag grey">' + esc(c.ownerName) + '</span>';
  if (truthy(c.dnc)) meta += '<span class="tag warn">DNC</span>';
  if (c.closing) meta += '<span class="tag">Close ' + esc(fmtDate(c.closing)) + '</span>';
  // Date the lead came in (imported/added).
  const added = c.imported_at || c.created_at;
  const dateLine = added ? '<div class="pdate">📅 Added ' + esc(fmtDate(added)) + '</div>' : '';
  return '<div class="pcard" draggable="true" data-id="' + escAttr(c.id) + '">' +
    '<div class="nm">' + gradeBadge(c) + esc(c.property || '(no address)') + '</div>' +
    '<div class="pr">' + esc(c.name || '') + '</div>' +
    dateLine +
    (meta ? '<div class="meta">' + meta + '</div>' : '') +
    '</div>';
}

function replaceContact(updated) {
  const i = state.contacts.findIndex(function (x) { return String(x.id) === String(updated.id); });
  if (i >= 0) state.contacts[i] = updated;
  else state.contacts.push(updated);
}

/* ------------------------------ Contacts table ------------------------------ */

function renderContacts() {
  const root = $('#view-contacts');
  const f = state.filters;
  root.innerHTML = '' +
    '<div class="viewhead">' +
    '  <h2>Contacts</h2>' +
    '  <button class="btn" id="ncBtn">+ New Contact</button>' +
    '  <button class="btn blue" id="alBtn2">+ Add Lead</button>' +
    '</div>' +
    '<div class="filterbar">' +
    '  <input class="search big" id="fQ" type="search" placeholder="Search address, seller, agent, or phone…" value="' + escAttr(f.q) + '">' +
    '  <input class="search sm" id="fCity" type="text" placeholder="City" value="' + escAttr(f.city) + '">' +
    '  <input class="search sm" id="fState" type="text" placeholder="State" maxlength="2" value="' + escAttr(f.state) + '">' +
    '  <input class="search sm" id="fAgent" type="text" placeholder="Agent name" value="' + escAttr(f.agent) + '">' +
    '  <select class="search sm" id="fFsbo">' +
    '    <option value=""' + (f.fsbo === '' ? ' selected' : '') + '>FSBO + Listed</option>' +
    '    <option value="true"' + (f.fsbo === 'true' ? ' selected' : '') + '>FSBO only</option>' +
    '    <option value="false"' + (f.fsbo === 'false' ? ' selected' : '') + '>Listed only</option>' +
    '  </select>' +
    '  <select class="search sm" id="fGrade">' +
    '    <option value=""' + (f.grade === '' ? ' selected' : '') + '>All grades</option>' +
    ['A', 'B', 'C', 'D', 'E', 'F'].map(function (g) {
      return '<option value="' + g + '"' + (f.grade === g ? ' selected' : '') + '>Grade ' + g + '</option>';
    }).join('') +
    '  </select>' +
    '  <select class="search sm" id="fStatus">' +
    '    <option value=""' + (f.leadStatus === '' ? ' selected' : '') + '>All statuses</option>' +
    ['NEW', 'IN QUEUE', 'WORKING'].map(function (st) {
      return '<option value="' + escAttr(st) + '"' + (f.leadStatus === st ? ' selected' : '') + '>' + esc(st) + '</option>';
    }).join('') +
    '  </select>' +
    (isAdmin() ? ownerFilterHtml() : '') +
    '  <button class="btn ghost small" id="fClear">Clear</button>' +
    '</div>' +
    '<div id="bulkBar"></div>' +
    '<div id="contactTable"><div class="empty">Loading...</div></div>';

  $('#ncBtn').addEventListener('click', function () { openContactModal(null); });
  $('#alBtn2').addEventListener('click', openLeadIntake);

  const debounced = debounce(applyContactFilters, 300);
  [['fQ', 'q'], ['fCity', 'city'], ['fState', 'state'], ['fAgent', 'agent']].forEach(function (pair) {
    const el = $('#' + pair[0]);
    el.addEventListener('input', function () {
      state.filters[pair[1]] = el.value.trim();
      debounced();
    });
  });
  $('#fFsbo').addEventListener('change', function () {
    state.filters.fsbo = $('#fFsbo').value;
    applyContactFilters();
  });
  $('#fGrade').addEventListener('change', function () {
    state.filters.grade = $('#fGrade').value;
    applyContactFilters();
  });
  $('#fStatus').addEventListener('change', function () {
    state.filters.leadStatus = $('#fStatus').value;
    applyContactFilters();
  });
  $('#fClear').addEventListener('click', function () {
    state.filters = { q: '', city: '', state: '', agent: '', fsbo: '', grade: '', leadStatus: '' };
    renderContacts();
  });
  wireOwnerFilter(function () { renderContacts(); });

  // Bulk assign needs the user list (admin only).
  if (isAdmin() && !state.users.length) {
    refreshUsers().then(function () { renderBulkBar(); renderContacts(); }).catch(function () {});
  }

  applyContactFilters();
}

function filtersActive() {
  const f = state.filters;
  return Boolean(f.q || f.city || f.state || f.agent || f.fsbo || f.grade || f.leadStatus);
}

/* Fetch the contact list from the server using the active filters (the
   server applies them owner-scoped) and re-render just the table. */
async function applyContactFilters() {
  const f = state.filters;
  const parts = [];
  if (f.q) parts.push('q=' + encodeURIComponent(f.q));
  if (f.city) parts.push('city=' + encodeURIComponent(f.city));
  if (f.state) parts.push('state=' + encodeURIComponent(f.state));
  if (f.agent) parts.push('agent=' + encodeURIComponent(f.agent));
  if (f.fsbo) parts.push('fsbo=' + encodeURIComponent(f.fsbo));
  if (f.grade) parts.push('grade=' + encodeURIComponent(f.grade));
  if (f.leadStatus) parts.push('lead_status=' + encodeURIComponent(f.leadStatus));
  try {
    const rows = await api('GET', '/contacts' + (parts.length ? '?' + parts.join('&') : '')) || [];
    state.contactList = rows;
    if (!filtersActive()) state.contacts = rows; // keep the master list fresh too
    renderContactTable(rows);
  } catch (e) {
    const box = $('#contactTable');
    if (box) box.innerHTML = '<div class="empty">' + esc(e.message) + '</div>';
  }
}

/* ---- Contacts table: sortable columns, bulk selection & admin actions ---- */

var CONTACT_SORT_COLS = [
  { key: 'name', label: 'Name' },
  { key: 'lead_status', label: 'Status' },
  { key: 'grade', label: 'Grade' },
  { key: 'property', label: 'Property' },
  { key: 'city', label: 'City' },
  { key: 'state', label: 'State' },
  { key: 'phone', label: 'Phone' },
  { key: 'stage', label: 'Stage' },
  { key: 'price', label: 'Price' },
  { key: 'daysOnMarket', label: 'Days on Mkt' }
];

function contactSortVal(c, key) {
  if (!c) return null;
  var v = c[key];
  if (key === 'owner') v = c.ownerName;
  if (key === 'stage') {
    var i = STAGES.indexOf(c.stage);
    return i === -1 ? STAGES.length : i;
  }
  if (key === 'phone') v = c.phone || (truthy(c.isFsbo) ? c.fsboPhone : c.agentPhone);
  if (key === 'price' || key === 'daysOnMarket') {
    var n = Number(v);
    return (v === null || v === undefined || v === '' || isNaN(n)) ? null : n;
  }
  if (v === null || v === undefined || String(v).trim() === '') return null;
  return String(v).toLowerCase();
}

function sortContactList(list) {
  var s = state.sort || {};
  if (!s.key) return list.slice();
  var out = list.slice();
  out.sort(function (a, b) {
    var va = contactSortVal(a, s.key);
    var vb = contactSortVal(b, s.key);
    if (va === null && vb === null) return 0;
    if (va === null) return 1;  // blanks always sort last
    if (vb === null) return -1;
    if (va < vb) return -s.dir;
    if (va > vb) return s.dir;
    return 0;
  });
  return out;
}

function selectedIds() {
  return Object.keys(state.selected).filter(function (id) { return state.selected[id]; });
}

/* POST a bulk action, clear the selection and refresh the filtered list. */
async function runBulkAction(path, payload, okMsg) {
  var out = await api('POST', path, payload) || {};
  state.selected = {};
  toast(okMsg + ': ' + (out.updated !== undefined ? out.updated : '?') + ' lead(s)', 'ok');
  await refreshContacts().catch(function () {});
  applyContactFilters(); // re-renders the table + bulk bar
}

/* Admin-only bulk action bar — appears whenever rows are checked. */
function renderBulkBar() {
  var bar = $('#bulkBar');
  if (!bar) return;
  var ids = selectedIds();
  if (!ids.length || !isAdmin()) { bar.innerHTML = ''; return; }

  bar.innerHTML = '<div class="bulkbar">' +
    '<b>' + ids.length + ' selected</b>' +
    '<span>Assign to</span>' +
    '<select id="bulkOwner"><option value="">Choose user…</option>' +
    state.users.filter(function (u) { return truthy(u.active); }).map(function (u) {
      return '<option value="' + escAttr(u.id) + '">' + esc(u.name) + ' (' + esc(u.email) + ')</option>';
    }).join('') +
    '</select>' +
    '<button class="btn small" id="bulkAssign">Assign</button>' +
    '<span class="sep">|</span>' +
    '<button class="btn blue small" id="bulkLock" title="Pin: imports and opens will never change these leads’ status">📌 Keep as NEW (Lock)</button>' +
    '<button class="btn ghost small" id="bulkUnlock">Unlock</button>' +
    '<button class="btn ghost small" id="bulkClear">Clear</button>' +
    '</div>';

  $('#bulkAssign').addEventListener('click', async function () {
    var ownerId = $('#bulkOwner').value;
    if (!ownerId) { toast('Choose a user to assign to.', 'error'); return; }
    this.disabled = true;
    try { await runBulkAction('/contacts/bulk-assign', { ids: selectedIds(), owner_id: ownerId }, 'Assigned'); }
    catch (e) { toastErr(e); this.disabled = false; }
  });
  $('#bulkLock').addEventListener('click', async function () {
    this.disabled = true;
    try { await runBulkAction('/contacts/bulk-lock', { ids: selectedIds(), locked: 1 }, 'Locked as NEW'); }
    catch (e) { toastErr(e); this.disabled = false; }
  });
  $('#bulkUnlock').addEventListener('click', async function () {
    this.disabled = true;
    try { await runBulkAction('/contacts/bulk-lock', { ids: selectedIds(), locked: 0 }, 'Unlocked'); }
    catch (e) { toastErr(e); this.disabled = false; }
  });
  $('#bulkClear').addEventListener('click', function () {
    state.selected = {};
    renderContactTable(state.contactList || []);
  });
}

/* Phone cell for the Contacts table: the number plus a pink call button that
   dials through the in-app softphone (NOT the browser's tel: / Google Voice). */
function phoneCellHtml(c) {
  var num = c.phone || (truthy(c.isFsbo) ? c.fsboPhone : c.agentPhone) || '';
  if (!num) return '<span class="hint">—</span>';
  var canCall = !!(state.twilio && state.twilio.status && state.twilio.status.voiceConfigured);
  var btn = canCall
    ? '<button class="callbtn" data-stop="1" data-call="' + escAttr(num) + '"' +
      ' data-cid="' + escAttr(c.id) + '" data-cname="' + escAttr(c.name || '') + '"' +
      ' title="Call ' + escAttr(num) + ' with the CRM softphone" aria-label="Call">' +
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">' +
      '<path d="M6.6 10.8c1.4 2.8 3.8 5.2 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.2.2 2.4.6 3.6.1.4 0 .8-.3 1l-2.2 2.2z"/></svg>' +
      '</button>'
    : '';
  return '<span class="phonenum" data-stop="1">' + esc(num) + '</span>' + btn;
}

function renderContactTable(list) {
  var box = $('#contactTable');
  if (!box) return;

  if (!list.length) {
    renderBulkBar();
    box.innerHTML = '<div class="empty">' +
      (filtersActive() ? 'No contacts match your filters.' : 'No contacts yet. Add your first one.') +
      '</div>';
    return;
  }

  var admin = isAdmin();
  var rows = sortContactList(list);
  var s = state.sort || {};

  function sortableTh(col) {
    var arrow = s.key === col.key
      ? ' <span class="arrow">' + (s.dir === 1 ? '▲' : '▼') + '</span>' : '';
    return '<th class="sortable" data-sort="' + escAttr(col.key) + '" title="Click to sort">' +
      esc(col.label) + arrow + '</th>';
  }

  var html = '<div class="tablewrap"><table><thead><tr>' +
    '<th class="chk"><input type="checkbox" id="selAll" data-stop="1" title="Select all (filtered)"></th>' +
    CONTACT_SORT_COLS.map(sortableTh).join('') +
    (admin ? sortableTh({ key: 'owner', label: 'Owner' }) : '') +
    '<th>Listing</th></tr></thead><tbody>';

  rows.forEach(function (c) {
    var tags = '';
    if ((c.source === 'Lead' || c.source === 'Lead Engine') && (c.stage || STAGES[0]) === 'Prospect') tags += ' <span class="tag lead">NEW LEAD</span>';
    if (truthy(c.isFsbo)) tags += ' <span class="tag warn">FSBO</span>';
    var link = c.sourceUrl || c.zillow;
    var idStr = String(c.id);
    html += '<tr class="rowlink" data-id="' + escAttr(c.id) + '">' +
      '<td class="chk"><input type="checkbox" class="rowchk" data-stop="1" data-chk="' + escAttr(c.id) + '"' +
      (state.selected[idStr] ? ' checked' : '') + '></td>' +
      '<td>' + esc(c.name || '(no name)') + tags + '</td>' +
      '<td>' + (leadStatusBadge(c) || '<span class="hint">—</span>') +
      (truthy(c.status_locked) ? ' <span class="tag warn" title="Keep as NEW — status is pinned">📌</span>' : '') + '</td>' +
      '<td>' + (gradeBadge(c) || '<span class="hint">—</span>') + '</td>' +
      '<td>' + esc(c.property || '') + '</td>' +
      '<td>' + esc(c.city || '') + '</td>' +
      '<td>' + esc(c.state || '') + '</td>' +
      '<td>' + phoneCellHtml(c) + '</td>' +
      '<td>' + esc(c.stage || '') + '</td>' +
      '<td>' + (c.price !== null && c.price !== undefined && c.price !== '' ? '$' + Number(c.price).toLocaleString() : '<span class="hint">—</span>') + '</td>' +
      '<td>' + (c.daysOnMarket !== null && c.daysOnMarket !== undefined ? esc(c.daysOnMarket) : '<span class="hint">—</span>') + '</td>' +
      (admin ? '<td>' + esc(c.ownerName || '') + '</td>' : '') +
      '<td>' + (link ? '<a href="' + escAttr(link) + '" target="_blank" rel="noopener noreferrer" data-stop="1">Listing</a>' : '<span class="hint">—</span>') + '</td>' +
      '</tr>';
  });
  html += '</tbody></table></div>';
  box.innerHTML = html;

  // Sortable headers: click toggles ascending / descending.
  $all('th.sortable', box).forEach(function (thEl) {
    thEl.addEventListener('click', function () {
      var key = thEl.getAttribute('data-sort');
      if (state.sort && state.sort.key === key) state.sort.dir = -state.sort.dir;
      else state.sort = { key: key, dir: 1 };
      renderContactTable(list);
    });
  });

  // Bulk-selection checkboxes.
  var visIds = rows.map(function (c) { return String(c.id); });
  var selAll = $('#selAll', box);
  function syncSelAll() {
    if (!selAll) return;
    selAll.checked = visIds.length > 0 && visIds.every(function (id) { return state.selected[id]; });
  }
  syncSelAll();
  if (selAll) {
    selAll.addEventListener('change', function () {
      var on = selAll.checked;
      visIds.forEach(function (id) { state.selected[id] = on; });
      renderContactTable(list);
    });
  }
  $all('input.rowchk', box).forEach(function (cb) {
    cb.addEventListener('click', function (ev) { ev.stopPropagation(); });
    cb.addEventListener('change', function () {
      state.selected[cb.getAttribute('data-chk')] = cb.checked;
      syncSelAll();
      renderBulkBar();
    });
  });

  renderBulkBar();

  $all('tr.rowlink', box).forEach(function (tr) {
    tr.addEventListener('click', function (ev) {
      if (ev.target && ev.target.closest && ev.target.closest('[data-stop]')) return;
      var id = tr.getAttribute('data-id');
      var c = (state.contactList || []).find(function (x) { return String(x.id) === String(id); }) ||
        state.contacts.find(function (x) { return String(x.id) === String(id); });
      if (c) openContactModal(c);
    });
  });

  // Pink call buttons → dial through the in-app softphone.
  $all('.callbtn', box).forEach(function (b) {
    b.addEventListener('click', function (ev) {
      ev.stopPropagation();
      placeCall(b.getAttribute('data-call'), b.getAttribute('data-cid'), b.getAttribute('data-cname'));
    });
  });
}

/* ------------------------------ Contact modal ------------------------------ */

const CONTACT_TEXT_FIELDS = [
  { key: 'name', label: 'Name' },
  { key: 'phone', label: 'Phone' },
  { key: 'email', label: 'Email' },
  { key: 'property', label: 'Property Address' },
  { key: 'zillow', label: 'Zillow URL' }
];
const AGENT_FIELDS = [
  { key: 'agentName', label: 'Agent Name' },
  { key: 'agentCompany', label: 'Agent Company' },
  { key: 'agentPhone', label: 'Agent Phone' },
  { key: 'agentEmail', label: 'Agent Email' }
];
const DATE_FIELDS = [
  { key: 'executedContract', label: 'Executed Contract' },
  { key: 'closing', label: 'Closing' },
  { key: 'dueDiligence', label: 'Due Diligence Ends' },
  { key: 'inspectionExpires', label: 'Inspection Expires' }
];

function closeModal() {
  $('#modalMount').innerHTML = '';
  state.openContactId = null;
  state._modalDismissable = true;
}

/**
 * Generic modal builder. `innerHtml` should already contain the .mbody (and an
 * optional .mfoot). Pass { dismissable:false } to hide the X + disable
 * click-outside/ESC dismissal (used for the mandatory admin 2FA enrollment).
 */
function openModal(title, innerHtml, opts) {
  opts = opts || {};
  const dismissable = opts.dismissable !== false;
  const mount = $('#modalMount');
  const closeBtn = dismissable ? '<button class="close" id="genModalClose" title="Close">&times;</button>' : '';
  mount.innerHTML =
    '<div class="overlay" id="genOverlay"><div class="modal" style="max-width:560px">' +
    '<div class="mhead"><h3>' + esc(title) + '</h3>' + closeBtn + '</div>' +
    innerHtml +
    '</div></div>';
  state._modalDismissable = dismissable;
  const overlay = $('#genOverlay');
  if (dismissable && overlay) {
    overlay.addEventListener('mousedown', function (ev) { if (ev.target === overlay) closeModal(); });
    const x = $('#genModalClose'); if (x) x.addEventListener('click', closeModal);
  }
}

function fieldHtml(f, value, type) {
  return '<div class="field"><label>' + esc(f.label) + '</label>' +
    '<input type="' + (type || 'text') + '" data-field="' + escAttr(f.key) + '" value="' + escAttr(value) + '"></div>';
}

function numFieldHtml(key, label, value) {
  const v = (value === null || value === undefined) ? '' : value;
  return '<div class="field"><label>' + esc(label) + '</label>' +
    '<input type="number" step="any" min="0" data-field="' + escAttr(key) + '" value="' + escAttr(v) + '"></div>';
}

/* Keywords may arrive as an array (parse draft) or a comma string (DB). */
function keywordsVal(v) {
  if (Array.isArray(v)) return v.join(', ');
  return v || '';
}

function openContactModal(contact, leadDraft) {
  const isNew = !contact;
  const isLead = isNew && !!leadDraft;
  const c = contact || leadDraft || { stage: STAGES[0] };
  const texts = getTexts(c);
  const textStatus = getTextStatus(c);
  const mount = $('#modalMount');

  const canText = !truthy(c.dnc) && truthy(c.consent_sms);
  const canRvm = !truthy(c.dnc) && truthy(c.consent_rvm);

  let html = '<div class="overlay" id="contactOverlay"><div class="modal">' +
    '<div class="mhead"><h3>' + (isNew ? (isLead ? 'New Lead (review & save)' : 'New Contact') : esc(c.name || 'Contact') + ' ' + gradeBadge(c) + leadStatusBadge(c)) + '</h3>' +
    '<button class="close" id="cmClose" title="Close">&times;</button></div>' +
    '<div class="mbody">';

  // ---- Admin bar: assign-to-user + Keep-as-NEW pin (always near the top)
  if (!isNew && isAdmin()) {
    html += '<div class="adminbar">' +
      '<div class="field" style="margin:0;flex:1;min-width:220px"><label>Assign to (admin only)</label>' +
      '<select id="assignOwner" disabled><option>Loading users...</option></select></div>' +
      '<button class="btn small' + (truthy(c.status_locked) ? ' blue' : ' ghost') + '" id="lockToggle" ' +
      'title="When ON, imports and opening the lead never change its status">' +
      '📌 Keep as NEW: ' + (truthy(c.status_locked) ? 'ON' : 'OFF') + '</button>' +
      '</div>';
  }

  // ---- Lead status: actually set NEW / IN QUEUE / WORKING (the pin only
  //      prevents auto-changes; this control changes the status directly).
  if (!isNew) {
    const cur = c.lead_status || '';
    html += '<div class="adminbar">' +
      '<div class="field" style="margin:0"><label>Lead status</label>' +
      '<select id="leadStatusSel" style="min-width:150px">' +
      '<option value=""' + (!cur ? ' selected' : '') + '>— none —</option>' +
      ['NEW', 'IN QUEUE', 'WORKING'].map(function (s) {
        return '<option value="' + escAttr(s) + '"' + (cur === s ? ' selected' : '') + '>' + esc(s) + '</option>';
      }).join('') +
      '</select></div>' +
      '<button class="btn blue small" id="setNewBtn" title="Change this lead’s status to NEW">Set to NEW</button>' +
      '</div>';
  }

  // ---- Details
  html += '<div class="sec" style="margin-top:0"><h4>Details</h4><div class="grid2">';
  CONTACT_TEXT_FIELDS.forEach(function (f) { html += fieldHtml(f, c[f.key] || ''); });
  html += '<div class="field"><label>Stage</label><select data-field="stage">';
  STAGES.forEach(function (s) {
    html += '<option value="' + escAttr(s) + '"' + ((c.stage || STAGES[0]) === s ? ' selected' : '') + '>' + esc(s) + '</option>';
  });
  html += '</select></div>';
  html += '</div>' +
    '<div class="field" style="margin-top:14px"><label>Notes</label>' +
    '<textarea data-field="notes" rows="3">' + esc(c.notes || '') + '</textarea></div>' +
    (c.grade ? '<p class="hint" style="margin:10px 0 0">Lead grade: ' + gradeBadge(c) +
      (c.price !== null && c.price !== undefined && c.price !== '' ? ' &middot; Listed at $' + Number(c.price).toLocaleString() : '') +
      (c.daysOnMarket !== null && c.daysOnMarket !== undefined ? ' &middot; ' + esc(c.daysOnMarket) + ' days on market' : '') +
      '</p>' : '') +
    '</div>';

  // ---- Lead Engine: status, import dates, change history, admin assign
  if (!isNew) {
    const isLeadEngine = c.source === 'Lead Engine' || c.lead_status ||
      c.imported_at || c.updated_from_sheet_at || c.change_log;
    if (isLeadEngine) {
      html += '<div class="sec"><h4>Lead Engine</h4>' +
        '<div class="kv"><b>Status:</b> ' + (leadStatusBadge(c) || '<span class="hint">\u2014</span>') +
        (truthy(c.opened) ? ' <span class="pill sent">Opened' + (c.opened_at ? ' ' + esc(fmtTimestamp(c.opened_at)) : '') + '</span>' : ' <span class="pill">Not opened</span>') +
        (truthy(c.called) ? ' <span class="pill sent">Called</span>' : ' <span class="pill">No call yet</span>') +
        '</div>' +
        '<div class="kv"><b>Imported:</b> ' + (c.imported_at ? esc(fmtTimestamp(c.imported_at)) : '\u2014') + '</div>' +
        '<div class="kv"><b>Last sheet update:</b> ' + (c.updated_from_sheet_at ? esc(fmtTimestamp(c.updated_from_sheet_at)) : '\u2014') + '</div>';
      html += '<div style="margin-top:10px"><div class="kv"><b>Import change history</b></div>' +
        '<div class="changelog">' +
        (c.change_log
          ? String(c.change_log).split('\n').map(function (ln) {
              return '<div class="cl-line">' + esc(ln) + '</div>';
            }).join('')
          : '<div class="hint">No sheet changes recorded yet.</div>') +
        '</div></div>' +
        '</div>';
    }
  }

  // ---- Property / listing details (lead fields)
  html += '<div class="sec"><h4>Property Details</h4><div class="grid3">' +
    numFieldHtml('beds', 'Beds', c.beds) +
    numFieldHtml('baths', 'Baths', c.baths) +
    numFieldHtml('sqft', 'Sqft', c.sqft) +
    '</div><div class="grid3" style="margin-top:14px">' +
    fieldHtml({ key: 'city', label: 'City' }, c.city || '') +
    fieldHtml({ key: 'state', label: 'State' }, c.state || '') +
    numFieldHtml('daysOnMarket', 'Days on Market', c.daysOnMarket) +
    '</div><div class="grid2" style="margin-top:14px">' +
    fieldHtml({ key: 'propertyTax', label: 'Property Tax ($/yr)' }, c.propertyTax || '') +
    fieldHtml({ key: 'priceChanges', label: 'Price Changes' }, c.priceChanges || '') +
    '</div><div class="grid2" style="margin-top:14px">' +
    '<div class="field"><label>Photo URL</label>' +
    '<input type="url" data-field="photoUrl" value="' + escAttr(c.photoUrl || '') + '">' +
    (c.photoUrl
      ? '<a href="' + escAttr(c.photoUrl) + '" target="_blank" rel="noopener noreferrer">' +
        '<img class="thumb" src="' + escAttr(c.photoUrl) + '" alt="Property photo"></a>'
      : '') +
    '</div>' +
    '<div class="field"><label>Source URL (stored only — never fetched)</label>' +
    '<input type="url" data-field="sourceUrl" value="' + escAttr(c.sourceUrl || '') + '">' +
    (c.sourceUrl
      ? '<a href="' + escAttr(c.sourceUrl) + '" target="_blank" rel="noopener noreferrer" style="font-size:12px">Open source listing</a>'
      : '') +
    '</div>' +
    '</div>' +
    '<div class="field" style="margin-top:14px"><label>Keywords (comma separated)</label>' +
    '<input type="text" data-field="keywords" value="' + escAttr(keywordsVal(c.keywords)) + '"></div>' +
    '<div class="field" style="margin-top:14px"><label>Listing Description (pasted text)</label>' +
    '<textarea data-field="listingDescription" rows="4">' + esc(c.listingDescription || '') + '</textarea></div>' +
    '</div>';

  // ---- FSBO
  const fsboOn = truthy(c.isFsbo);
  html += '<div class="sec"><h4>For Sale By Owner</h4>' +
    '<div class="toggles">' + toggleHtml('isFsbo', 'FSBO — no listing agent', fsboOn) + '</div>' +
    '<div id="fsboFields" class="grid3" style="margin-top:14px' + (fsboOn ? '' : ';display:none') + '">' +
    fieldHtml({ key: 'sellerName', label: 'Seller Name' }, c.sellerName || '') +
    fieldHtml({ key: 'fsboPhone', label: 'FSBO Phone' }, c.fsboPhone || '') +
    fieldHtml({ key: 'fsboEmail', label: 'FSBO Email' }, c.fsboEmail || '') +
    '</div></div>';

  // ---- Listing agent
  html += '<div class="sec"><h4>Listing Agent</h4><div class="grid3">';
  AGENT_FIELDS.forEach(function (f) { html += fieldHtml(f, c[f.key] || ''); });
  html += '</div></div>';

  // ---- Dates
  html += '<div class="sec"><h4>Important Dates</h4><div class="grid2">';
  DATE_FIELDS.forEach(function (f) { html += fieldHtml(f, dateInputVal(c[f.key]), 'date'); });
  html += '</div></div>';

  // ---- Compliance
  html += '<div class="sec"><h4>Compliance</h4><div class="toggles">' +
    toggleHtml('dnc', 'Do Not Contact (DNC)', truthy(c.dnc)) +
    toggleHtml('consent_sms', 'SMS consent', truthy(c.consent_sms)) +
    toggleHtml('consent_rvm', 'Ringless voicemail consent', truthy(c.consent_rvm)) +
    '</div><p class="hint" style="margin:8px 0 0">Automated sends are blocked when DNC is on or consent is missing. Toggle, then Save.</p></div>';

  // ---- Quick actions (manual)
  html += '<div class="sec"><h4>Quick Actions (manual)</h4>';
  if (isNew) {
    html += '<p class="hint">Save the contact first to enable actions, messaging, and the activity log.</p>';
  } else {
    html += '<div class="actions-row">' +
      (c.phone
        ? '<a class="btn blue small" style="text-decoration:none" href="tel:' + escAttr(c.phone) + '">Call</a>' +
          '<a class="btn blue small" style="text-decoration:none" href="sms:' + escAttr(c.phone) + '">Text</a>'
        : '<span class="hint">Add a phone number for call/text links.</span>') +
      (c.email ? '<a class="btn blue small" style="text-decoration:none" href="mailto:' + escAttr(c.email) + '">Email</a>' : '') +
      '</div>' +
      '<div class="actions-row">' +
      '<input class="search" id="logNote" type="text" placeholder="Optional note for the log entry..." style="flex:1;min-width:180px">' +
      '</div>' +
      '<div class="actions-row">' +
      '<button class="btn ghost small" data-log="call">Log Call</button>' +
      '<button class="btn ghost small" data-log="sms">Log Text</button>' +
      '<button class="btn ghost small" data-log="email">Log Email</button>' +
      '<button class="btn ghost small" data-log="note">Log Note</button>' +
      '</div>';
  }
  html += '</div>';

  // ---- Phone (in-app softphone + SMS via CRM number)
  const tw = state.twilio.status || {};
  if (!isNew && (tw.voiceConfigured || tw.smsConfigured)) {
    html += '<div class="sec"><h4>Phone &amp; Text (in-app)</h4>';
    if (!c.phone) {
      html += '<p class="hint">Add a phone number to call or text this contact from the CRM.</p>';
    } else {
      html += '<p class="hint" style="margin:0 0 10px">Calls and texts go through your CRM number and are logged automatically below' +
        (tw.from ? ' (from ' + esc(tw.from) + ')' : '') + '.</p>';
      if (tw.voiceConfigured) {
        html += '<div class="actions-row">' +
          '<button class="btn blue small" id="appCallBtn">📞 Call in app</button>' +
          '<span class="hint" id="appCallHint" style="align-self:center"></span>' +
          '</div>';
      }
      if (tw.smsConfigured) {
        html += '<div class="field" style="margin-top:10px"><label>Send a text</label>' +
          '<textarea id="appSmsBody" rows="2" placeholder="Type a message to ' + escAttr(c.name || 'this contact') + '..."></textarea></div>' +
          '<div class="actions-row"><button class="btn small" id="appSmsBtn">Send Text</button></div>';
      }
    }
    html += '</div>';
  }

  // ---- Automated text workflow
  html += '<div class="sec"><h4>Automated Text Workflow</h4>' +
    '<p class="hint" style="margin:0 0 10px">Tokens: <code>{name}</code> <code>{property}</code> <code>{agent}</code> are replaced when sending.' +
    (state.config.messagingMode === 'stub' ? ' Server is in stub mode: sends are simulated and logged.' : '') + '</p>';
  for (let i = 0; i < 4; i++) {
    html += '<div class="msgrow">' +
      '<div class="num">' + (i + 1) + '</div>' +
      '<textarea data-text-index="' + i + '" placeholder="Message #' + (i + 1) + '...">' + esc(texts[i] || '') + '</textarea>' +
      '<div class="msgside">' +
      '<button class="btn small' + (textStatus[i] ? ' ghost' : '') + '" data-send-text="' + i + '"' +
      (isNew || !canText ? ' disabled' : '') + '>Send #' + (i + 1) + '</button>' +
      '<label class="pill' + (textStatus[i] ? ' sent' : '') + '" id="sentPill' + i + '">' +
      '<input type="checkbox" disabled' + (textStatus[i] ? ' checked' : '') + '> Sent</label>' +
      '</div></div>';
  }
  if (!isNew && !canText) {
    html += '<p class="hint">Sending disabled: ' + (truthy(c.dnc) ? 'contact is marked DNC.' : 'SMS consent not granted.') + '</p>';
  }
  html += '</div>';

  // ---- RVM
  html += '<div class="sec"><h4>Ringless Voicemail <span class="hint" id="rvmProviderStatus" style="font-weight:400"></span></h4>' +
    '<p class="hint" style="margin:0 0 10px">Record a voicemail and drop it now or schedule it. Delivered ringless via your RVM provider (Slybroadcast / Drop Cowboy). Requires RVM consent; blocked for DNC.</p>' +
    '<div class="field"><label>Voicemail script (text-to-speech fallback if no recording is selected)</label>' +
    '<textarea data-field="rvm" rows="2" placeholder="Voicemail message...">' + esc(c.rvm || '') + '</textarea></div>' +
    (isNew
      ? '<p class="hint">Save the contact first to record and send voicemails.</p>'
      : '<div class="rvmrec">' +
        '  <button type="button" class="btn small" id="rvmRecBtn">● Record</button>' +
        '  <button type="button" class="btn ghost small" id="rvmStopBtn" disabled>■ Stop</button>' +
        '  <span class="hint" id="rvmRecStatus"></span>' +
        '  <audio id="rvmPreview" controls style="display:none;max-width:220px;height:34px;vertical-align:middle"></audio>' +
        '  <button type="button" class="btn small" id="rvmSaveBtn" disabled>Save recording</button>' +
        '</div>' +
        '<div class="doclist" id="rvmRecordings"><p class="hint">Loading recordings…</p></div>' +
        '<div class="actions-row" style="margin-top:10px">' +
        '  <select id="rvmUseRec" class="search sm" style="min-width:180px"><option value="">— script (text-to-speech) —</option></select>' +
        '  <button class="btn blue small" id="rvmSendNow"' + (!canRvm ? ' disabled' : '') + '>Send now</button>' +
        '  <input type="datetime-local" id="rvmWhen" class="search sm">' +
        '  <button class="btn small" id="rvmSchedule"' + (!canRvm ? ' disabled' : '') + '>Schedule</button>' +
        '</div>' +
        '<div class="doclist" id="rvmScheduled"></div>' +
        (!canRvm ? '<p class="hint">Sending disabled: ' + (truthy(c.dnc) ? 'contact is marked DNC.' : 'RVM consent not granted — toggle SMS/RVM consent above and Save.') + '</p>' : '')) +
    '</div>';

  // ---- Tasks (linked to this contact)
  html += '<div class="sec"><h4>Tasks</h4>' +
    (isNew
      ? '<p class="hint">Save the contact first to add tasks for it.</p>'
      : '<p class="hint" style="margin:0 0 10px">Tasks you add here are linked to this contact and also appear in your main Tasks list.</p>' +
        '<div class="taskform">' +
        '  <div class="field" style="flex:2"><label>New task</label><input id="ctTaskTitle" type="text" placeholder="e.g. Follow up with seller"></div>' +
        '  <div class="field"><label>Due date</label><input id="ctTaskDue" type="date"></div>' +
        '  <div class="field"><label>Time (optional)</label><input id="ctTaskTime" type="time"></div>' +
        '  <div class="field"><label>Duration</label><select id="ctTaskDur">' + durationOptions(30) + '</select></div>' +
        '  <button class="btn" id="ctTaskAdd" type="button">Add Task</button>' +
        '</div>' +
        '<div class="tasklist" id="contactTasks"><p class="hint">Loading tasks...</p></div>') +
    '</div>';

  // ---- Documents (uploaded files for this contact)
  html += '<div class="sec"><h4>Documents</h4>' +
    (isNew
      ? '<p class="hint">Save the contact first to upload documents.</p>'
      : '<p class="hint" style="margin:0 0 10px">Upload contracts, photos, or any file for this contact (up to 25&nbsp;MB each).</p>' +
        '<div class="actions-row">' +
        '  <input type="file" id="docFile" style="display:none">' +
        '  <input type="file" id="docCamera" accept="image/*" capture="environment" style="display:none">' +
        '  <button class="btn small" id="docPick" type="button">Choose file…</button>' +
        '  <button class="btn small" id="docScan" type="button">📷 Scan / Photo</button>' +
        '  <span class="hint" id="docPickName" style="align-self:center"></span>' +
        '  <button class="btn blue small" id="docUpload" type="button" disabled>Upload</button>' +
        '</div>' +
        '<div class="doclist" id="contactDocs"><p class="hint">Loading documents...</p></div>') +
    '</div>';

  // ---- Activity log
  html += '<div class="sec"><h4>Activity Log</h4><div class="log" id="activityLog">' +
    (isNew ? '<p class="hint">Activity appears after the contact is saved.</p>' : '<p class="hint">Loading activity...</p>') +
    '</div></div>';

  html += '</div>'; // mbody

  // ---- Footer
  html += '<div class="mfoot">' +
    (isNew ? '' : '<button class="btn danger" id="cmDelete">Delete</button>') +
    '<div class="spacer"></div>' +
    '<button class="btn ghost" id="cmCancel">Cancel</button>' +
    '<button class="btn" id="cmSave">' + (isNew ? (isLead ? 'Save as New Lead' : 'Create Contact') : 'Save Changes') + '</button>' +
    '</div>';

  html += '</div></div>';
  mount.innerHTML = html;
  state.openContactId = isNew ? null : c.id;

  const overlay = $('#contactOverlay');
  overlay.addEventListener('mousedown', function (ev) {
    if (ev.target === overlay) closeModal();
  });
  $('#cmClose').addEventListener('click', closeModal);
  $('#cmCancel').addEventListener('click', closeModal);

  const fsboCb = $('[data-toggle="isFsbo"]', overlay);
  if (fsboCb) {
    fsboCb.addEventListener('change', function () {
      const box = $('#fsboFields', overlay);
      if (box) box.style.display = fsboCb.checked ? '' : 'none';
    });
  }

  function collect() {
    const out = {};
    $all('[data-field]', overlay).forEach(function (elm) {
      out[elm.getAttribute('data-field')] = elm.value;
    });
    ['dnc', 'consent_sms', 'consent_rvm', 'isFsbo'].forEach(function (k) {
      const cb = $('[data-toggle="' + k + '"]', overlay);
      if (cb) out[k] = cb.checked;
    });
    out.texts = $all('[data-text-index]', overlay).map(function (t) { return t.value; });
    return out;
  }

  // ---- Save
  $('#cmSave').addEventListener('click', async function () {
    const btn = this;
    btn.disabled = true;
    const payload = collect();
    try {
      let saved;
      if (isNew) {
        if (isLead && !payload.name) {
          payload.name = payload.sellerName || payload.agentName || payload.property || 'New Lead';
        }
        saved = await api('POST', isLead ? '/leads' : '/contacts', payload);
        toast(isLead ? 'New lead saved to Prospect' : 'Contact created', 'ok');
      } else {
        saved = await api('PATCH', '/contacts/' + encodeURIComponent(c.id), payload);
        toast('Contact saved', 'ok');
      }
      if (saved) replaceContact(saved);
      closeModal();
      rerenderCurrentContactView();
    } catch (e) {
      toastErr(e);
      btn.disabled = false;
    }
  });

  // ---- Delete
  if (!isNew) {
    $('#cmDelete').addEventListener('click', async function () {
      if (!window.confirm('Delete "' + (c.name || 'this contact') + '"? This cannot be undone.')) return;
      try {
        await api('DELETE', '/contacts/' + encodeURIComponent(c.id));
        state.contacts = state.contacts.filter(function (x) { return String(x.id) !== String(c.id); });
        toast('Contact deleted', 'ok');
        closeModal();
        rerenderCurrentContactView();
      } catch (e) { toastErr(e); }
    });
  }

  if (isNew) return; // no logging/sending/activity for unsaved contacts

  // ---- In-app softphone call + SMS
  const appCallBtn = $('#appCallBtn', overlay);
  if (appCallBtn) {
    appCallBtn.addEventListener('click', function () {
      placeCall(c.phone, c.id, c.name);
    });
  }
  const appSmsBtn = $('#appSmsBtn', overlay);
  if (appSmsBtn) {
    appSmsBtn.addEventListener('click', async function () {
      const bodyEl = $('#appSmsBody', overlay);
      const ok = await sendContactSms(c.id, c.phone, bodyEl ? bodyEl.value : '', appSmsBtn);
      if (ok && bodyEl) bodyEl.value = '';
    });
  }

  // ---- Log buttons
  $all('[data-log]', overlay).forEach(function (btn) {
    btn.addEventListener('click', async function () {
      const type = btn.getAttribute('data-log');
      const noteEl = $('#logNote', overlay);
      const body = (noteEl && noteEl.value.trim()) ||
        (type === 'note' ? '' : 'Manual ' + (type === 'sms' ? 'text' : type) + ' logged');
      if (type === 'note' && !body) { toast('Type a note first.', 'error'); return; }
      btn.disabled = true;
      try {
        await api('POST', '/contacts/' + encodeURIComponent(c.id) + '/log', { type: type, body: body });
        if (noteEl) noteEl.value = '';
        toast('Logged ' + type, 'ok');
        loadActivities(c.id);
      } catch (e) { toastErr(e); }
      btn.disabled = false;
    });
  });

  // ---- Documents (upload / list / download / delete)
  wireDocuments(c.id, overlay);

  // ---- Contact tasks (linked to this contact)
  loadContactTasks(c.id, overlay);
  const ctAdd = $('#ctTaskAdd', overlay);
  if (ctAdd) {
    ctAdd.addEventListener('click', async function () {
      const titleEl = $('#ctTaskTitle', overlay);
      const title = titleEl.value.trim();
      if (!title) { toast('Enter a task title.', 'error'); return; }
      const dueEl = $('#ctTaskDue', overlay);
      const timeEl = $('#ctTaskTime', overlay);
      const durEl = $('#ctTaskDur', overlay);
      const body = { title: title, contact_id: c.id };
      if (dueEl && dueEl.value) body.due_date = dueEl.value;
      if (timeEl && timeEl.value) { body.due_time = timeEl.value; body.duration_min = Number(durEl && durEl.value) || 30; }
      ctAdd.disabled = true;
      try {
        await api('POST', '/tasks', body);
        titleEl.value = '';
        if (dueEl) dueEl.value = '';
        if (timeEl) timeEl.value = '';
        toast('Task added', 'ok');
        await loadContactTasks(c.id, overlay);
      } catch (e) { toastErr(e); }
      ctAdd.disabled = false;
    });
    const ctTitle = $('#ctTaskTitle', overlay);
    if (ctTitle) ctTitle.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') ctAdd.click();
    });
  }

  // ---- Send automated text
  $all('[data-send-text]', overlay).forEach(function (btn) {
    btn.addEventListener('click', async function () {
      const i = parseInt(btn.getAttribute('data-send-text'), 10);
      btn.disabled = true;
      const orig = btn.textContent;
      btn.textContent = 'Sending...';
      try {
        // Persist any edits to the message templates first, then send.
        const editedTexts = $all('[data-text-index]', overlay).map(function (t) { return t.value; });
        await api('PATCH', '/contacts/' + encodeURIComponent(c.id), { texts: editedTexts });
        const updated = await api('POST', '/contacts/' + encodeURIComponent(c.id) + '/send-text', { index: i });
        if (updated && updated.id !== undefined) {
          replaceContact(updated);
          const st = getTextStatus(updated);
          const pill = $('#sentPill' + i, overlay);
          if (pill) {
            pill.classList.toggle('sent', !!st[i]);
            pill.querySelector('input').checked = !!st[i];
          }
        } else {
          const pill = $('#sentPill' + i, overlay);
          if (pill) { pill.classList.add('sent'); pill.querySelector('input').checked = true; }
        }
        toast('Text #' + (i + 1) + ' sent', 'ok');
        loadActivities(c.id);
      } catch (e) { toastErr(e); }
      btn.textContent = orig;
      btn.disabled = false;
    });
  });

  // ---- Ringless voicemail: recorder + send / schedule
  wireRvm(c, overlay);

  // ---- Lead status control (change status, e.g. back to NEW)
  const leadSel = $('#leadStatusSel', overlay);
  const applyLeadStatus = async function (val) {
    try {
      const u = await api('PATCH', '/contacts/' + encodeURIComponent(c.id), { lead_status: val || null });
      if (u) replaceContact(u);
      if (leadSel) leadSel.value = val || '';
      toast('Lead status ' + (val ? 'set to ' + val : 'cleared'), 'ok');
      rerenderCurrentContactView();
    } catch (e) { toastErr(e); }
  };
  if (leadSel) leadSel.addEventListener('change', function () { applyLeadStatus(this.value); });
  const setNewBtn = $('#setNewBtn', overlay);
  if (setNewBtn) setNewBtn.addEventListener('click', function () { applyLeadStatus('NEW'); });

  // ---- Admin: assign-to-user dropdown (PATCHes owner_id; owner_id is the
  //      tenant-isolation key, so assigning moves visibility to that user).
  if (isAdmin()) {
    (async function () {
      try {
        if (!state.users.length) await refreshUsers();
        const sel = $('#assignOwner', overlay);
        if (!sel) return;
        // Only active team members are assignable. If this contact is already
        // owned by someone since deactivated, keep them in the list (labeled)
        // so the current assignment isn't silently hidden.
        const assignable = state.users.filter(function (u) { return truthy(u.active); });
        if (c.owner_id && !assignable.some(function (u) { return String(u.id) === String(c.owner_id); })) {
          const cur = state.users.find(function (u) { return String(u.id) === String(c.owner_id); });
          if (cur) assignable.unshift(cur);
        }
        sel.innerHTML = assignable.map(function (u) {
          return '<option value="' + escAttr(u.id) + '"' +
            (String(u.id) === String(c.owner_id) ? ' selected' : '') + '>' +
            esc(u.name) + ' (' + esc(u.email) + ')' +
            (truthy(u.active) ? '' : ' — inactive') + '</option>';
        }).join('');
        sel.disabled = false;
        sel.addEventListener('change', async function () {
          sel.disabled = true;
          try {
            const updated = await api('PATCH', '/contacts/' + encodeURIComponent(c.id), { owner_id: sel.value });
            if (updated) replaceContact(updated);
            toast('Lead assigned', 'ok');
            rerenderCurrentContactView();
          } catch (e) { toastErr(e); }
          sel.disabled = false;
        });

        // Keep-as-NEW pin toggle (admin) — PATCHes status_locked 0/1.
        const lockBtn = $('#lockToggle', overlay);
        if (lockBtn) {
          let lockedNow = truthy(c.status_locked);
          lockBtn.addEventListener('click', async function () {
            lockBtn.disabled = true;
            try {
              const updated = await api('PATCH', '/contacts/' + encodeURIComponent(c.id),
                { status_locked: lockedNow ? 0 : 1 });
              if (updated) { replaceContact(updated); lockedNow = truthy(updated.status_locked); }
              else { lockedNow = !lockedNow; }
              lockBtn.innerHTML = '📌 Keep as NEW: ' + (lockedNow ? 'ON' : 'OFF');
              lockBtn.classList.toggle('blue', lockedNow);
              lockBtn.classList.toggle('ghost', !lockedNow);
              toast(lockedNow
                ? 'Status pinned — imports and opens will not change it'
                : 'Status unpinned', 'ok');
              rerenderCurrentContactView();
            } catch (e) { toastErr(e); }
            lockBtn.disabled = false;
          });
        }
      } catch (e) { /* users list unavailable */ }
    })();
  }

  // Server-side open tracking: fetching the detail marks the lead opened and
  // moves NEW / IN QUEUE to WORKING. Refresh our cached copy with the result.
  api('GET', '/contacts/' + encodeURIComponent(c.id)).then(function (fresh) {
    if (fresh && fresh.id !== undefined) {
      replaceContact(fresh);
      const h3 = $('.mhead h3', overlay);
      if (h3) h3.innerHTML = esc(fresh.name || 'Contact') + ' ' + gradeBadge(fresh) + leadStatusBadge(fresh);
    }
  }).catch(function () {});

  loadActivities(c.id);
}

/* ------------------------------ Lead intake ------------------------------ */
/* Compliance: leads are created from text the USER pastes. The URL field is
   stored as sourceUrl for reference only — the app never fetches or scrapes
   Zillow / Realtor / Homes or any other listing site. */

function openLeadIntake() {
  const mount = $('#modalMount');
  mount.innerHTML = '' +
    '<div class="overlay" id="leadOverlay"><div class="modal" style="max-width:640px">' +
    '<div class="mhead"><h3>Add Lead</h3><button class="close" id="liClose" title="Close">&times;</button></div>' +
    '<div class="mbody">' +
    '<p class="hint" style="margin-top:0">Copy the listing description yourself (from an email, flyer, or a licensed data feed) and paste it below. ' +
    'We parse only what you paste — this app never fetches or scrapes listing sites.</p>' +
    '<div class="field"><label>Listing URL (optional — saved as the source link, never fetched)</label>' +
    '<input id="liUrl" type="url" placeholder="https://..."></div>' +
    '<div class="field"><label>Paste listing text here</label>' +
    '<textarea id="liText" rows="10" placeholder="e.g. 123 Maple St, Dallas, TX 75201 — 3 bd 2 ba 1,450 sqft. $215,000. Fixer upper, motivated seller..."></textarea></div>' +
    '</div>' +
    '<div class="mfoot">' +
    '<button class="btn ghost" id="liCancel">Cancel</button>' +
    '<button class="btn blue" id="liBlank">Skip — blank lead</button>' +
    '<button class="btn" id="liParse">Parse &rarr; Review</button>' +
    '</div></div></div>';

  const overlay = $('#leadOverlay');
  overlay.addEventListener('mousedown', function (ev) {
    if (ev.target === overlay) closeModal();
  });
  $('#liClose').addEventListener('click', closeModal);
  $('#liCancel').addEventListener('click', closeModal);

  $('#liBlank').addEventListener('click', function () {
    const url = $('#liUrl').value.trim();
    closeModal();
    openContactModal(null, { stage: STAGES[0], sourceUrl: url || '' });
  });

  $('#liParse').addEventListener('click', async function () {
    const btn = this;
    const url = $('#liUrl').value.trim();
    const text = $('#liText').value;
    if (!text.trim()) { toast('Paste the listing text first.', 'error'); return; }
    btn.disabled = true;
    btn.textContent = 'Parsing...';
    try {
      const draft = await api('POST', '/leads/parse', { url: url || null, text: text }) || {};
      draft.stage = STAGES[0];
      if (draft.price && !draft.notes) {
        draft.notes = 'Asking price: $' + Number(draft.price).toLocaleString();
      }
      draft.name = draft.name || draft.sellerName || draft.agentName || draft.property || '';
      closeModal();
      openContactModal(null, draft);
      toast('Draft parsed — review the fields, then Save as New Lead.', 'ok');
    } catch (e) {
      toastErr(e);
      btn.disabled = false;
      btn.textContent = 'Parse \u2192 Review';
    }
  });
}

function toggleHtml(key, label, checked) {
  return '<label class="toggle"><input type="checkbox" data-toggle="' + escAttr(key) + '"' +
    (checked ? ' checked' : '') + '> ' + esc(label) + '</label>';
}

/* ---- Unread inbound-voicemail alert (nav badge, polled) ---- */

function setupVoicemailBadge() {
  if (document.getElementById('vmBadge')) return;
  const topbar = document.querySelector('.topbar');
  const who = document.getElementById('whoBox');
  if (!topbar || !who) return;
  const b = document.createElement('button');
  b.id = 'vmBadge';
  b.className = 'btn small vm-badge hidden';
  b.title = 'Unlistened voicemails — click to open';
  b.addEventListener('click', openMostRecentUnreadVm);
  topbar.insertBefore(b, who);
}

async function refreshVoicemailBadge() {
  const b = document.getElementById('vmBadge');
  try {
    const r = await api('GET', '/inbox/unread');
    state._vmUnread = (r && r.items) ? r.items : [];
    const n = (r && r.count) ? r.count : 0;
    if (b) {
      if (n > 0) { b.textContent = '🔔 ' + n + ' new'; b.classList.remove('hidden'); }
      else { b.classList.add('hidden'); }
    }
    // Update the installed-app icon badge (Android + iOS 16.4+ installed PWA).
    try { if (navigator.setAppBadge) { n > 0 ? navigator.setAppBadge(n) : navigator.clearAppBadge(); } } catch (e) {}
    // Native app (Capacitor) icon badge.
    try {
      if (isNativeApp()) {
        const Badge = capPlugin('Badge');
        if (Badge) { if (n > 0) { Badge.set({ count: n }); } else if (Badge.clear) { Badge.clear(); } }
      }
    } catch (e) {}
  } catch (e) { /* ignore */ }
}

async function openMostRecentUnreadVm() {
  const items = state._vmUnread || [];
  if (!items.length) return;
  const vm = items[0];
  let c = state.contacts.find(function (x) { return String(x.id) === String(vm.contact_id); });
  if (!c) { try { c = await api('GET', '/contacts/' + encodeURIComponent(vm.contact_id)); } catch (e) {} }
  if (c) openContactModal(c);
  else toast('Open the contact.', 'error');
}

/* ---- PWA: service worker + web push notifications ---- */

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js').catch(function (e) { console.warn('[pwa] SW registration failed:', e && e.message); });
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

async function subscribeForPush(vapidKey) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false;
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidKey),
    });
  }
  await api('POST', '/push/subscribe', { subscription: sub.toJSON ? sub.toJSON() : sub });
  return true;
}

/** After login: if push is available, subscribe (or offer an "Enable alerts" button). */
async function setupPush() {
  if (isNativeApp()) return; // native app uses Firebase push, not web push
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return;
  let key = null;
  try { const r = await api('GET', '/push/key'); key = r && r.key; } catch (e) {}
  if (!key) return; // push not configured on the server yet
  if (Notification.permission === 'granted') {
    subscribeForPush(key).catch(function () {});
    return;
  }
  if (Notification.permission === 'denied') return;
  // Offer an opt-in button in the top bar.
  const topbar = document.querySelector('.topbar');
  const who = document.getElementById('whoBox');
  if (!topbar || !who || document.getElementById('enableAlertsBtn')) return;
  const b = document.createElement('button');
  b.id = 'enableAlertsBtn';
  b.className = 'btn ghost small';
  b.textContent = '🔔 Enable alerts';
  b.addEventListener('click', async function () {
    const perm = await Notification.requestPermission();
    if (perm === 'granted') {
      try { await subscribeForPush(key); toast('Notifications enabled.', 'ok'); b.remove(); }
      catch (e) { toastErr(e); }
    } else {
      toast('Notifications not enabled.', 'error');
    }
  });
  topbar.insertBefore(b, who);
}

/* ---- Native app (Capacitor) push notifications + app badge ---- */

// True only inside the installed Android/iOS app (Capacitor webview).
function isNativeApp() {
  try { return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()); }
  catch (e) { return false; }
}

function capPlugin(name) {
  try { return window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins[name]; }
  catch (e) { return null; }
}

// Register for Firebase push inside the native app and forward the device
// token to the CRM so the server can push to this phone.
async function setupNativePush() {
  if (!isNativeApp()) return;
  const Push = capPlugin('PushNotifications');
  if (!Push) return;
  try {
    Push.addListener('registration', async function (t) {
      const token = t && (t.value || t.token);
      if (!token) return;
      let platform = 'android';
      try { if (window.Capacitor.getPlatform) platform = window.Capacitor.getPlatform(); } catch (e) {}
      try { await api('POST', '/push/native-register', { token: token, platform: platform }); } catch (e) {}
    });
    Push.addListener('registrationError', function (e) { console.warn('[push] native registration error:', e); });
    Push.addListener('pushNotificationReceived', function () { try { refreshVoicemailBadge(); } catch (e) {} });
    Push.addListener('pushNotificationActionPerformed', function () {
      try { refreshVoicemailBadge(); } catch (e) {}
      try { openMostRecentUnreadVm(); } catch (e) {}
    });
    let perm = await Push.checkPermissions();
    if (perm && (perm.receive === 'prompt' || perm.receive === 'prompt-with-rationale')) {
      perm = await Push.requestPermissions();
    }
    if (perm && perm.receive === 'granted') { await Push.register(); }
  } catch (e) { console.warn('[push] native setup failed:', e && e.message); }
}

async function loadActivities(contactId) {
  const box = $('#activityLog');
  if (!box) return;
  try {
    const acts = await api('GET', '/contacts/' + encodeURIComponent(contactId) + '/activities') || [];
    if (!acts.length) {
      box.innerHTML = '<p class="hint">No activity yet.</p>';
      return;
    }
    box.innerHTML = acts.map(function (a) {
      const type = String(a.type || 'note').toLowerCase();
      const chipClass = ['call', 'sms', 'email', 'rvm', 'note', 'stage'].indexOf(type) !== -1 ? type : 'note';
      const extra = [];
      if (a.mode) extra.push(esc(a.mode));
      if (a.direction) extra.push(esc(a.direction));
      if (a.status) extra.push(esc(a.status));
      if (type === 'call' && a.duration_sec) extra.push(fmtDur(a.duration_sec));
      // New-vs-viewed applies to any INBOUND text / call / voicemail.
      const isInbound = a.direction === 'inbound' && ['sms', 'call', 'rvm'].indexOf(type) !== -1;
      const isUnread = isInbound && !a.read_at;
      const newBadge = isUnread ? ' <span class="tag warn">NEW</span>' : '';
      const isVm = type === 'rvm' && a.direction === 'inbound';
      const playBtn = (isVm && a.provider_id)
        ? ' <button class="btn ghost small" data-vmplay="' + escAttr(a.provider_id) + '" data-vmact="' + escAttr(a.id) + '">▶ Play</button>'
        : '';
      const toggleBtn = isInbound
        ? ' <button class="btn ghost small" data-toggleread="' + escAttr(a.id) + '" data-read="' + (a.read_at ? '1' : '0') + '">' +
          (a.read_at ? 'Mark new' : 'Mark viewed') + '</button>'
        : '';
      return '<div class="logitem' + (isUnread ? ' unread' : '') + '">' +
        '<div class="lh">' +
        '<span><span class="typechip ' + chipClass + '">' + esc(type.toUpperCase()) + '</span>' + newBadge +
        (extra.length ? ' <span>' + extra.join(' &middot; ') + '</span>' : '') + '</span>' +
        '<span>' + esc(fmtTimestamp(a.created_at)) + (a.created_by ? ' &middot; ' + esc(a.created_by) : '') + '</span>' +
        '</div>' +
        '<div>' + esc(a.body || '') + playBtn + toggleBtn + '</div>' +
        '</div>';
    }).join('');
    box.scrollTop = box.scrollHeight;

    // Wire inbound-voicemail play buttons (play + mark as listened).
    $all('[data-vmplay]', box).forEach(function (b) {
      b.addEventListener('click', async function () {
        playRecording(b.getAttribute('data-vmplay'));
        try {
          await api('POST', '/voicemails/' + encodeURIComponent(b.getAttribute('data-vmact')) + '/read');
          loadActivities(contactId);
          refreshVoicemailBadge();
        } catch (e) {}
      });
    });

    // Wire new-vs-viewed toggles (mark viewed / bump back to NEW).
    $all('[data-toggleread]', box).forEach(function (b) {
      b.addEventListener('click', async function () {
        const wasRead = b.getAttribute('data-read') === '1';
        try {
          await api('POST', '/activities/' + encodeURIComponent(b.getAttribute('data-toggleread')) + '/read', { read: !wasRead });
          loadActivities(contactId);
          refreshVoicemailBadge();
        } catch (e) { toastErr(e); }
      });
    });
  } catch (e) {
    box.innerHTML = '<p class="hint">Could not load activity: ' + esc(e.message) + '</p>';
  }
}

function rerenderCurrentContactView() {
  if (state.tab === 'pipeline') renderPipeline();
  else if (state.tab === 'contacts') renderContacts();
}

/* ------------------------------ Tasks ------------------------------ */

async function loadAndRenderTasks() {
  const root = $('#view-tasks');
  root.innerHTML = '<div class="viewhead"><h2>Tasks</h2></div><div class="empty">Loading...</div>';
  try {
    await refreshTasks();
    await refreshAssignees(); // active users for the per-task "Assign to" editor
    // ensure contacts loaded for the link dropdown
    if (!state.contacts.length) await refreshContacts().catch(function () {});
  } catch (e) {
    root.innerHTML = '<div class="viewhead"><h2>Tasks</h2></div><div class="empty">' + esc(e.message) + '</div>';
    return;
  }
  renderTasks();
}

function renderTasks() {
  const root = $('#view-tasks');
  const open = state.tasks.filter(function (t) { return !truthy(t.done); });
  const done = state.tasks.filter(function (t) { return truthy(t.done); });

  let html = '' +
    '<div class="viewhead">' +
    '  <h2>Tasks</h2>' +
    '  <button class="btn blue" id="icsBtn">Export to Calendar/To-Do (.ics)</button>' +
    '</div>' +
    '<div class="banner">This is your full task list — every task you create, including ones added inside a contact. Admins see all users’ tasks; each user sees only their own. To add a task linked to a specific contact, open that contact and use its Tasks section. The form below is for general tasks that aren’t tied to a contact.</div>' +
    '<div class="taskform">' +
    '  <div class="field" style="flex:2"><label>New task (no contact)</label><input id="taskTitle" type="text" placeholder="e.g. Order more yard signs"></div>' +
    '  <div class="field"><label>Due date</label><input id="taskDue" type="date"></div>' +
    '  <div class="field"><label>Time (optional)</label><input id="taskTime" type="time"></div>' +
    '  <div class="field"><label>Duration</label><select id="taskDur">' + durationOptions(30) + '</select></div>' +
    '  <button class="btn" id="taskAdd">Add Task</button>' +
    '</div>';

  html += '<div class="subhead">Open (' + open.length + ')</div>';
  html += open.length ? '<div class="tasklist">' + open.map(taskItemHtml).join('') + '</div>'
    : '<div class="empty">No open tasks. Nice.</div>';

  html += '<div class="subhead">Done (' + done.length + ')</div>';
  html += done.length ? '<div class="tasklist">' + done.map(taskItemHtml).join('') + '</div>'
    : '<div class="empty">Nothing completed yet.</div>';

  root.innerHTML = html;

  $('#icsBtn').addEventListener('click', exportIcs);
  $('#taskAdd').addEventListener('click', async function () {
    const title = $('#taskTitle').value.trim();
    if (!title) { toast('Enter a task title.', 'error'); return; }
    const body = { title: title };
    const due = $('#taskDue').value;
    if (due) body.due_date = due;
    const time = $('#taskTime').value;
    if (time) { body.due_time = time; body.duration_min = Number($('#taskDur').value) || 30; }
    try {
      await api('POST', '/tasks', body);
      await refreshTasks();
      renderTasks();
      toast('Task added', 'ok');
    } catch (e) { toastErr(e); }
  });
  $('#taskTitle').addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') $('#taskAdd').click();
  });

  $all('.taskitem', root).forEach(function (item) {
    const id = item.getAttribute('data-id');
    wireTaskEditing(item, async function () { await refreshTasks(); renderTasks(); });
    const cb = $('input[type=checkbox]', item);
    cb.addEventListener('change', async function () {
      try {
        await api('PATCH', '/tasks/' + encodeURIComponent(id), { done: cb.checked });
        await refreshTasks();
        renderTasks();
      } catch (e) { toastErr(e); }
    });
    const del = $('[data-del]', item);
    del.addEventListener('click', async function () {
      try {
        await api('DELETE', '/tasks/' + encodeURIComponent(id));
        state.tasks = state.tasks.filter(function (t) { return String(t.id) !== String(id); });
        renderTasks();
        toast('Task deleted', 'ok');
      } catch (e) { toastErr(e); }
    });
    const link = $('[data-contact-link]', item);
    if (link) {
      link.addEventListener('click', function () {
        const c = state.contacts.find(function (x) { return String(x.id) === String(link.getAttribute('data-contact-link')); });
        if (c) openContactModal(c);
      });
    }
    const pushBtn = $('[data-push-google]', item);
    if (pushBtn) {
      pushBtn.addEventListener('click', async function () {
        pushBtn.disabled = true;
        const orig = pushBtn.textContent;
        pushBtn.textContent = 'Sending...';
        try {
          await api('POST', '/tasks/' + encodeURIComponent(id) + '/push-google');
          await refreshTasks();
          renderTasks();
          toast('Task sent to Google', 'ok');
        } catch (e) {
          toastErr(e);
          pushBtn.textContent = orig;
          pushBtn.disabled = false;
        }
      });
    }
    const pushMsBtn = $('[data-push-microsoft]', item);
    if (pushMsBtn) {
      pushMsBtn.addEventListener('click', async function () {
        pushMsBtn.disabled = true;
        const orig = pushMsBtn.textContent;
        pushMsBtn.textContent = 'Sending...';
        try {
          await api('POST', '/tasks/' + encodeURIComponent(id) + '/push-microsoft');
          await refreshTasks();
          renderTasks();
          toast('Task sent to Microsoft', 'ok');
        } catch (e) {
          toastErr(e);
          pushMsBtn.textContent = orig;
          pushMsBtn.disabled = false;
        }
      });
    }
  });
}

/** <option> list of task durations, `selected` (minutes) marked (default 30). */
function durationOptions(selected) {
  const opts = [[15, '15 min'], [30, '30 min'], [45, '45 min'], [60, '1 hour'], [90, '1.5 hours'], [120, '2 hours'], [180, '3 hours']];
  const sel = selected ? String(selected) : '30';
  return opts.map(function (o) {
    return '<option value="' + o[0] + '"' + (String(o[0]) === sel ? ' selected' : '') + '>' + o[1] + '</option>';
  }).join('');
}

/** Human-readable "2:00 PM" from an HH:MM 24h string (empty → ''). */
function fmtTime(hhmm) {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})/);
  if (!m) return '';
  let h = parseInt(m[1], 10);
  const ap = h < 12 ? 'AM' : 'PM';
  h = h % 12; if (h === 0) h = 12;
  return h + ':' + m[2] + ' ' + ap;
}

/** <option> list of ACTIVE users for assigning a task, current owner selected.
 *  If the task's current owner is inactive, keep them (labeled) so reassignment
 *  choices never silently drop the existing assignment. */
function taskAssigneeOptions(ownerId, ownerName) {
  // Prefer the all-roles assignee list; fall back to the admin user list.
  const source = (state.assignees && state.assignees.length) ? state.assignees : (state.users || []);
  const assignable = source.filter(function (u) { return truthy(u.active); });
  if (ownerId && !assignable.some(function (u) { return String(u.id) === String(ownerId); })) {
    // Current owner isn't an active user (deactivated/legacy). Keep them as a
    // selected option so editing the task doesn't silently reassign it.
    const cur = (state.users || []).find(function (u) { return String(u.id) === String(ownerId); })
      || { id: ownerId, name: ownerName || 'Current owner', active: 0 };
    assignable.unshift(cur);
  }
  return assignable.map(function (u) {
    const me = state.user && String(u.id) === String(state.user.id);
    return '<option value="' + escAttr(u.id) + '"' +
      (String(u.id) === String(ownerId) ? ' selected' : '') + '>' +
      esc(u.name) + (me ? ' (me)' : '') +
      (truthy(u.active) ? '' : ' — inactive') + '</option>';
  }).join('');
}

function taskItemHtml(t) {
  const isDone = truthy(t.done);
  const contact = t.contact_id
    ? state.contacts.find(function (c) { return String(c.id) === String(t.contact_id); })
    : null;
  const today = new Date().toISOString().slice(0, 10);
  const dd = dateInputVal(t.due_date);
  const overdue = !isDone && dd && dd < today;
  const gConnected = state.google && state.google.connected;
  let googleBit = '';
  if (t.google_task_id) {
    googleBit = '<span class="tag blue" title="Synced to Google Tasks' +
      (t.google_event_id ? ' + Calendar' : '') + '">Google &#10003;</span>';
  } else if (gConnected && !isDone) {
    googleBit = '<button class="btn ghost small" data-push-google="1" title="Push this task to Google Tasks (and Calendar if it has a due date)">Send to Google</button>';
  }
  const msConnected = state.microsoft && state.microsoft.connected;
  let msBit = '';
  if (t.ms_todo_id) {
    msBit = '<span class="tag blue" title="Synced to Microsoft To Do' +
      (t.ms_event_id ? ' + Outlook Calendar' : '') + '">Microsoft &#10003;</span>';
  } else if (msConnected && !isDone) {
    msBit = '<button class="btn ghost small" data-push-microsoft="1" title="Push this task to Microsoft To Do (and Outlook Calendar if it has a due date)">Send to Microsoft</button>';
  }
  return '<div class="taskitem' + (isDone ? ' done' : '') + '" data-id="' + escAttr(t.id) + '">' +
    '<input type="checkbox"' + (isDone ? ' checked' : '') + ' title="Toggle done">' +
    '<span class="tt">' + esc(t.title || '') +
    (t.ownerName ? ' <span class="tag grey" title="Assigned to">' + esc(t.ownerName) + '</span>' : '') +
    '</span>' +
    (contact ? '<button class="linklike" data-contact-link="' + escAttr(contact.id) + '">' + esc(contact.name || 'contact') + '</button>' : '') +
    (dd ? '<span class="due' + (overdue ? ' overdue' : '') + '">due ' + esc(dd) +
      (t.due_time ? ' ' + esc(fmtTime(t.due_time)) +
        (t.duration_min ? ' <span class="tag grey">' + esc(String(t.duration_min)) + 'm</span>' : '') : '') +
      '</span>' : '') +
    googleBit +
    msBit +
    '<button class="btn ghost small" data-edit="1">Edit</button>' +
    '<button class="btn ghost small" data-del="1">Delete</button>' +
    // Hidden inline editor: title, due date, time, duration, assignee.
    '<div class="taskform taskedit" data-edit-panel style="display:none;flex-basis:100%;margin-top:8px">' +
    '<div class="field" style="flex:2"><label>Task</label>' +
    '<input type="text" data-edit-title value="' + escAttr(t.title || '') + '"></div>' +
    '<div class="field"><label>Due date</label>' +
    '<input type="date" data-edit-due value="' + escAttr(dd || '') + '"></div>' +
    '<div class="field"><label>Time</label>' +
    '<input type="time" data-edit-time value="' + escAttr(t.due_time || '') + '"></div>' +
    '<div class="field"><label>Duration</label>' +
    '<select data-edit-dur>' + durationOptions(t.duration_min || 30) + '</select></div>' +
    '<div class="field"><label>Assign to</label>' +
    '<select data-edit-owner>' + taskAssigneeOptions(t.owner_id, t.ownerName) + '</select></div>' +
    '<button class="btn small" data-edit-save>Save</button>' +
    '<button class="btn ghost small" data-edit-cancel>Cancel</button>' +
    '</div>' +
    '</div>';
}

/** Wire the inline Edit panel on a single .taskitem. `reload` re-renders the
 *  surrounding list after a successful save. Shared by the Tasks page and the
 *  per-contact task list. */
function wireTaskEditing(item, reload) {
  const id = item.getAttribute('data-id');
  const panel = $('[data-edit-panel]', item);
  const editBtn = $('[data-edit]', item);
  if (!panel || !editBtn) return;
  editBtn.addEventListener('click', function () {
    panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
  });
  const cancel = $('[data-edit-cancel]', item);
  if (cancel) cancel.addEventListener('click', function () { panel.style.display = 'none'; });
  const save = $('[data-edit-save]', item);
  if (save) save.addEventListener('click', async function () {
    const title = $('[data-edit-title]', item).value.trim();
    if (!title) { toast('Task title cannot be empty.', 'error'); return; }
    const timeEl = $('[data-edit-time]', item);
    const durEl = $('[data-edit-dur]', item);
    const hasTime = timeEl && timeEl.value;
    const body = {
      title: title,
      due_date: $('[data-edit-due]', item).value || null,
      due_time: hasTime ? timeEl.value : null,
      duration_min: hasTime ? (Number(durEl && durEl.value) || 30) : null,
      owner_id: $('[data-edit-owner]', item).value,
    };
    save.disabled = true;
    try {
      await api('PATCH', '/tasks/' + encodeURIComponent(id), body);
      toast('Task updated', 'ok');
      await reload();
    } catch (e) { toastErr(e); save.disabled = false; }
  });
}

/* ------------------------------ Documents ------------------------------ */

var DOC_MAX_BYTES = 25 * 1024 * 1024; // keep in sync with routes/documents.js

function fmtBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

/** Wire the Documents section: file picker, upload, and load the list. */
function wireDocuments(contactId, overlay) {
  const pick = $('#docPick', overlay);
  const scan = $('#docScan', overlay);
  const fileInput = $('#docFile', overlay);
  const camInput = $('#docCamera', overlay);
  const nameEl = $('#docPickName', overlay);
  const uploadBtn = $('#docUpload', overlay);
  if (!fileInput || !uploadBtn) return; // isNew contact: no documents UI

  let pendingFile = null;
  function choose(f, isScan) {
    if (!f) { pendingFile = null; nameEl.textContent = ''; uploadBtn.disabled = true; return; }
    if (f.size > DOC_MAX_BYTES) {
      toast('That file is larger than 25 MB.', 'error');
      pendingFile = null; nameEl.textContent = ''; uploadBtn.disabled = true; return;
    }
    // Camera captures come in as generic "image.jpg" — give a friendlier name.
    let name = f.name || 'file';
    if (isScan && (!f.name || /^image\.(jpe?g|png)$/i.test(f.name))) {
      name = 'Scan ' + new Date().toISOString().slice(0, 16).replace('T', ' ') + '.jpg';
    }
    pendingFile = { blob: f, name: name };
    nameEl.textContent = name + ' (' + fmtBytes(f.size) + ')';
    uploadBtn.disabled = false;
  }

  if (pick) pick.addEventListener('click', function () { fileInput.click(); });
  if (scan && camInput) scan.addEventListener('click', function () { camInput.click(); });
  fileInput.addEventListener('change', function () { choose(fileInput.files && fileInput.files[0], false); });
  if (camInput) camInput.addEventListener('change', function () { choose(camInput.files && camInput.files[0], true); });

  uploadBtn.addEventListener('click', async function () {
    if (!pendingFile) { toast('Choose or scan a file first.', 'error'); return; }
    uploadBtn.disabled = true;
    const prev = uploadBtn.textContent;
    uploadBtn.textContent = 'Uploading…';
    try {
      const dataBase64 = await fileToBase64(pendingFile.blob);
      await api('POST', '/contacts/' + encodeURIComponent(contactId) + '/documents', {
        filename: pendingFile.name, mime: pendingFile.blob.type || null, dataBase64: dataBase64,
      });
      toast('Uploaded ' + pendingFile.name, 'ok');
      pendingFile = null; fileInput.value = ''; if (camInput) camInput.value = ''; nameEl.textContent = '';
      loadDocuments(contactId, overlay);
    } catch (e) {
      toastErr(e);
    }
    uploadBtn.textContent = prev;
    uploadBtn.disabled = true;
  });

  loadDocuments(contactId, overlay);
}

/** Read a File as a base64 string (no data: prefix). */
function fileToBase64(file) {
  return new Promise(function (resolve, reject) {
    const r = new FileReader();
    r.onload = function () {
      const s = String(r.result || '');
      resolve(s.indexOf(',') !== -1 ? s.slice(s.indexOf(',') + 1) : s);
    };
    r.onerror = function () { reject(new Error('Could not read the file.')); };
    r.readAsDataURL(file);
  });
}

/** Load + render the document list for a contact, inside its modal. */
async function loadDocuments(contactId, overlay) {
  const box = overlay ? $('#contactDocs', overlay) : $('#contactDocs');
  if (!box) return;
  try {
    const docs = await api('GET', '/contacts/' + encodeURIComponent(contactId) + '/documents') || [];
    if (!docs.length) { box.innerHTML = '<p class="hint">No documents yet.</p>'; return; }
    box.innerHTML = docs.map(function (d) {
      return '<div class="docitem" data-doc="' + escAttr(d.id) + '">' +
        '<span class="docname" title="' + escAttr(d.filename) + '">📄 ' + esc(d.filename) + '</span>' +
        '<span class="docmeta">' + esc(fmtBytes(d.size)) + ' &middot; ' + esc(fmtTimestamp(d.created_at)) + '</span>' +
        '<span class="docacts">' +
        '<button class="btn ghost small" data-dl="' + escAttr(d.id) + '" data-name="' + escAttr(d.filename) + '">Download</button>' +
        '<button class="btn ghost small danger" data-del="' + escAttr(d.id) + '">Delete</button>' +
        '</span></div>';
    }).join('');

    $all('[data-dl]', box).forEach(function (b) {
      b.addEventListener('click', function () {
        downloadDocument(b.getAttribute('data-dl'), b.getAttribute('data-name'), b);
      });
    });
    $all('[data-del]', box).forEach(function (b) {
      b.addEventListener('click', async function () {
        if (!window.confirm('Delete this document? This cannot be undone.')) return;
        b.disabled = true;
        try {
          await api('DELETE', '/documents/' + encodeURIComponent(b.getAttribute('data-del')));
          toast('Document deleted', 'ok');
          loadDocuments(contactId, overlay);
        } catch (e) { toastErr(e); b.disabled = false; }
      });
    });
  } catch (e) {
    box.innerHTML = '<p class="hint">Could not load documents: ' + esc(e.message) + '</p>';
  }
}

/** Download a document (auth header → blob → save) so the token isn't in the URL. */
async function downloadDocument(docId, filename, btn) {
  if (btn) btn.disabled = true;
  try {
    const res = await fetch('/api/documents/' + encodeURIComponent(docId) + '/download', {
      headers: state.token ? { Authorization: 'Bearer ' + state.token } : {},
    });
    if (!res.ok) throw new Error('Download failed (' + res.status + ')');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'document';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  } catch (e) {
    toastErr(e);
  }
  if (btn) btn.disabled = false;
}

/* ------------------------- Ringless Voicemail (RVM) ------------------------- */

/** Encode a decoded AudioBuffer to a 16-bit mono WAV Blob (provider-friendly). */
function encodeWav(audioBuffer) {
  const len = audioBuffer.length;
  const sampleRate = audioBuffer.sampleRate;
  const chs = audioBuffer.numberOfChannels || 1;
  const data = new Float32Array(len);
  for (let ch = 0; ch < chs; ch++) {
    const cd = audioBuffer.getChannelData(ch);
    for (let i = 0; i < len; i++) data[i] += cd[i] / chs; // downmix to mono
  }
  const buffer = new ArrayBuffer(44 + len * 2);
  const view = new DataView(buffer);
  const wr = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  wr(0, 'RIFF'); view.setUint32(4, 36 + len * 2, true); wr(8, 'WAVE');
  wr(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  wr(36, 'data'); view.setUint32(40, len * 2, true);
  let off = 44;
  for (let i = 0; i < len; i++) { const s = Math.max(-1, Math.min(1, data[i])); view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true); off += 2; }
  return new Blob([view], { type: 'audio/wav' });
}

/** Convert a recorded Blob (webm/mp4) to a WAV Blob via the Web Audio API. */
async function blobToWav(blob) {
  const buf = await blob.arrayBuffer();
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  try {
    const audio = await ctx.decodeAudioData(buf);
    return encodeWav(audio);
  } finally {
    try { ctx.close(); } catch (e) {}
  }
}

/** Wire the Ringless Voicemail section: record, save, send now / schedule. */
function wireRvm(c, overlay) {
  const recBtn = $('#rvmRecBtn', overlay);
  if (!recBtn) return; // isNew contact
  const stopBtn = $('#rvmStopBtn', overlay);
  const saveBtn = $('#rvmSaveBtn', overlay);
  const statusEl = $('#rvmRecStatus', overlay);
  const preview = $('#rvmPreview', overlay);
  const sendNowBtn = $('#rvmSendNow', overlay);
  const whenEl = $('#rvmWhen', overlay);
  const schedBtn = $('#rvmSchedule', overlay);

  let mediaRecorder = null, chunks = [], recordedB64 = null, recordedUrl = null, startTs = 0, durMs = 0, timer = null;

  recBtn.addEventListener('click', async function () {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toast('Recording is not supported in this browser.', 'error'); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunks = [];
      mediaRecorder = new MediaRecorder(stream);
      mediaRecorder.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
      mediaRecorder.onstop = async function () {
        stream.getTracks().forEach(function (t) { t.stop(); });
        clearInterval(timer);
        durMs = Date.now() - startTs;
        const blob = new Blob(chunks, { type: chunks[0] ? chunks[0].type : 'audio/webm' });
        statusEl.textContent = 'Processing…';
        try {
          const wav = await blobToWav(blob);
          recordedB64 = await fileToBase64(wav);
          if (recordedUrl) URL.revokeObjectURL(recordedUrl);
          recordedUrl = URL.createObjectURL(wav);
          preview.src = recordedUrl; preview.style.display = 'inline-block';
          saveBtn.disabled = false;
          statusEl.textContent = 'Recorded ' + fmtDur(Math.round(durMs / 1000)) + ' — preview, then Save.';
        } catch (err) {
          toast('Could not process the recording.', 'error');
          statusEl.textContent = '';
        }
      };
      mediaRecorder.start();
      startTs = Date.now();
      recBtn.disabled = true; stopBtn.disabled = false; saveBtn.disabled = true;
      statusEl.textContent = 'Recording… 0:00';
      timer = setInterval(function () { statusEl.textContent = 'Recording… ' + fmtDur(Math.round((Date.now() - startTs) / 1000)); }, 500);
    } catch (e) {
      toast('Microphone access was blocked or unavailable.', 'error');
    }
  });

  stopBtn.addEventListener('click', function () {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    recBtn.disabled = false; stopBtn.disabled = true;
  });

  saveBtn.addEventListener('click', async function () {
    if (!recordedB64) { toast('Record something first.', 'error'); return; }
    saveBtn.disabled = true;
    try {
      await api('POST', '/contacts/' + encodeURIComponent(c.id) + '/rvm/recordings', {
        mime: 'audio/wav', dataBase64: recordedB64, duration_ms: durMs,
      });
      toast('Recording saved', 'ok');
      recordedB64 = null; preview.style.display = 'none'; statusEl.textContent = '';
      loadRvmRecordings(c.id, overlay);
    } catch (e) { toastErr(e); saveBtn.disabled = false; }
  });

  if (sendNowBtn) sendNowBtn.addEventListener('click', function () { sendRvmForContact(c, overlay, null); });
  if (schedBtn) schedBtn.addEventListener('click', function () {
    const v = whenEl && whenEl.value;
    if (!v) { toast('Pick a date & time to schedule.', 'error'); return; }
    sendRvmForContact(c, overlay, new Date(v).toISOString());
  });

  loadRvmRecordings(c.id, overlay);
  loadRvmScheduled(c.id, overlay);

  // Show whether RVM delivery is live (provider connected) or stubbed.
  api('GET', '/rvm/status').then(function (s) {
    const el = $('#rvmProviderStatus', overlay);
    if (!el || !s) return;
    el.textContent = s.mode === 'live'
      ? '· live via ' + s.provider
      : '· not connected (test mode)';
    el.style.color = s.mode === 'live' ? '#39d98a' : '';
  }).catch(function () {});
}

async function sendRvmForContact(c, overlay, sendAt) {
  const useRec = $('#rvmUseRec', overlay);
  const scriptEl = $('[data-field="rvm"]', overlay);
  const payload = {
    recordingId: useRec && useRec.value ? useRec.value : null,
    script: scriptEl ? scriptEl.value : '',
    sendAt: sendAt || null,
  };
  try {
    const r = await api('POST', '/contacts/' + encodeURIComponent(c.id) + '/rvm/send', payload);
    if (r && r.scheduled) { toast('Voicemail scheduled', 'ok'); loadRvmScheduled(c.id, overlay); }
    else { toast(r && r.ok ? 'Voicemail sent' : ('Voicemail: ' + ((r && r.result && r.result.status) || 'not sent')), r && r.ok ? 'ok' : 'error'); }
    if (scriptEl) api('PATCH', '/contacts/' + encodeURIComponent(c.id), { rvm: scriptEl.value }).catch(function () {});
    loadActivities(c.id);
  } catch (e) { toastErr(e); }
}

async function loadRvmRecordings(contactId, overlay) {
  const box = $('#rvmRecordings', overlay);
  const sel = $('#rvmUseRec', overlay);
  if (!box) return;
  try {
    const recs = await api('GET', '/contacts/' + encodeURIComponent(contactId) + '/rvm/recordings') || [];
    if (sel) {
      sel.innerHTML = '<option value="">— script (text-to-speech) —</option>' +
        recs.map(function (r, i) { return '<option value="' + escAttr(r.id) + '">' + esc(r.label || ('Recording ' + (i + 1))) + '</option>'; }).join('');
      if (recs[0]) sel.value = recs[0].id;
    }
    if (!recs.length) { box.innerHTML = '<p class="hint">No recordings yet.</p>'; return; }
    box.innerHTML = recs.map(function (r) {
      return '<div class="docitem">' +
        '<span class="docname">🎙 ' + esc(r.label || 'Recording') + '</span>' +
        '<span class="docmeta">' + (r.duration_ms ? fmtDur(Math.round(r.duration_ms / 1000)) : '') + ' &middot; ' + esc(fmtTimestamp(r.created_at)) + '</span>' +
        '<span class="docacts">' +
        '<button class="btn ghost small" data-play="' + escAttr(r.id) + '">Play</button>' +
        '<button class="btn ghost small danger" data-delrec="' + escAttr(r.id) + '">Delete</button>' +
        '</span></div>';
    }).join('');
    $all('[data-play]', box).forEach(function (b) { b.addEventListener('click', function () { playRecording(b.getAttribute('data-play')); }); });
    $all('[data-delrec]', box).forEach(function (b) {
      b.addEventListener('click', async function () {
        if (!window.confirm('Delete this recording?')) return;
        b.disabled = true;
        try { await api('DELETE', '/rvm/recordings/' + encodeURIComponent(b.getAttribute('data-delrec'))); toast('Recording deleted', 'ok'); loadRvmRecordings(contactId, overlay); }
        catch (e) { toastErr(e); b.disabled = false; }
      });
    });
  } catch (e) { box.innerHTML = '<p class="hint">Could not load recordings: ' + esc(e.message) + '</p>'; }
}

async function playRecording(recId) {
  try {
    const res = await fetch('/api/rvm/recordings/' + encodeURIComponent(recId) + '/audio', {
      headers: state.token ? { Authorization: 'Bearer ' + state.token } : {},
    });
    if (!res.ok) throw new Error('Playback failed (' + res.status + ')');
    const url = URL.createObjectURL(await res.blob());
    const a = new Audio(url);
    a.play();
    a.onended = function () { URL.revokeObjectURL(url); };
  } catch (e) { toastErr(e); }
}

async function loadRvmScheduled(contactId, overlay) {
  const box = $('#rvmScheduled', overlay);
  if (!box) return;
  try {
    const items = await api('GET', '/contacts/' + encodeURIComponent(contactId) + '/rvm/scheduled') || [];
    if (!items.length) { box.innerHTML = ''; return; }
    box.innerHTML = '<p class="hint" style="margin:8px 0 4px">Scheduled voicemails:</p>' + items.map(function (s) {
      return '<div class="docitem">' +
        '<span class="docname">⏰ ' + esc(fmtTimestamp(s.send_at)) + '</span>' +
        '<span class="docmeta">' + (s.recording_id ? 'recording' : 'script') + '</span>' +
        '<span class="docacts"><button class="btn ghost small danger" data-cancelsch="' + escAttr(s.id) + '">Cancel</button></span>' +
        '</div>';
    }).join('');
    $all('[data-cancelsch]', box).forEach(function (b) {
      b.addEventListener('click', async function () {
        b.disabled = true;
        try { await api('DELETE', '/rvm/scheduled/' + encodeURIComponent(b.getAttribute('data-cancelsch'))); toast('Schedule canceled', 'ok'); loadRvmScheduled(contactId, overlay); }
        catch (e) { toastErr(e); b.disabled = false; }
      });
    });
  } catch (e) { box.innerHTML = ''; }
}

/** Load + render the tasks linked to a single contact, inside its modal. */
async function loadContactTasks(contactId, overlay) {
  const box = overlay ? $('#contactTasks', overlay) : $('#contactTasks');
  if (!box) return;
  try {
    await refreshTasks(); // owner-scoped; admin sees all, users see their own
    if (!state.assignees.length) await refreshAssignees(); // for the "Assign to" editor
    const list = state.tasks.filter(function (t) {
      return String(t.contact_id) === String(contactId);
    });
    if (!list.length) {
      box.innerHTML = '<p class="hint">No tasks yet for this contact.</p>';
      return;
    }
    box.innerHTML = list.map(taskItemHtml).join('');
    wireContactTaskItems(box, contactId, overlay);
  } catch (e) {
    box.innerHTML = '<p class="hint">Could not load tasks: ' + esc(e.message) + '</p>';
  }
}

/** Wire done/delete/push-google on task rows shown inside a contact modal. */
function wireContactTaskItems(box, contactId, overlay) {
  $all('.taskitem', box).forEach(function (item) {
    const id = item.getAttribute('data-id');
    wireTaskEditing(item, function () { return loadContactTasks(contactId, overlay); });
    const cb = $('input[type=checkbox]', item);
    if (cb) cb.addEventListener('change', async function () {
      try {
        await api('PATCH', '/tasks/' + encodeURIComponent(id), { done: cb.checked });
        await loadContactTasks(contactId, overlay);
      } catch (e) { toastErr(e); }
    });
    const del = $('[data-del]', item);
    if (del) del.addEventListener('click', async function () {
      try {
        await api('DELETE', '/tasks/' + encodeURIComponent(id));
        toast('Task deleted', 'ok');
        await loadContactTasks(contactId, overlay);
      } catch (e) { toastErr(e); }
    });
    const pushBtn = $('[data-push-google]', item);
    if (pushBtn) pushBtn.addEventListener('click', async function () {
      pushBtn.disabled = true;
      const orig = pushBtn.textContent;
      pushBtn.textContent = 'Sending...';
      try {
        await api('POST', '/tasks/' + encodeURIComponent(id) + '/push-google');
        toast('Task sent to Google', 'ok');
        await loadContactTasks(contactId, overlay);
      } catch (e) {
        toastErr(e);
        pushBtn.textContent = orig;
        pushBtn.disabled = false;
      }
    });
    const pushMsBtn = $('[data-push-microsoft]', item);
    if (pushMsBtn) pushMsBtn.addEventListener('click', async function () {
      pushMsBtn.disabled = true;
      const orig = pushMsBtn.textContent;
      pushMsBtn.textContent = 'Sending...';
      try {
        await api('POST', '/tasks/' + encodeURIComponent(id) + '/push-microsoft');
        toast('Task sent to Microsoft', 'ok');
        await loadContactTasks(contactId, overlay);
      } catch (e) {
        toastErr(e);
        pushMsBtn.textContent = orig;
        pushMsBtn.disabled = false;
      }
    });
  });
}

async function exportIcs() {
  const btn = $('#icsBtn');
  if (btn) btn.disabled = true;
  try {
    const res = await fetch('/api/tasks/export.ics', {
      headers: state.token ? { 'Authorization': 'Bearer ' + state.token } : {}
    });
    if (!res.ok) throw new Error('Export failed (' + res.status + ')');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'crm-tasks.ics';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
    toast('Downloaded crm-tasks.ics — import it into your calendar app.', 'ok');
  } catch (e) { toastErr(e); }
  if (btn) btn.disabled = false;
}

/* ------------------------------ Team (admin) ------------------------------ */

async function loadAndRenderTeam() {
  const root = $('#view-team');
  root.innerHTML = '<div class="viewhead"><h2>Team</h2></div><div class="empty">Loading...</div>';
  try {
    await refreshUsers();
  } catch (e) {
    root.innerHTML = '<div class="viewhead"><h2>Team</h2></div><div class="empty">' + esc(e.message) + '</div>';
    return;
  }
  renderTeam();
}

function renderTeam() {
  const root = $('#view-team');
  let html = '' +
    '<div class="viewhead"><h2>Team</h2></div>' +
    '<div class="banner">As an admin you can see every user’s contacts and tasks across the app (owner tags show whose record it is). Deactivated users can no longer sign in, but their data stays visible to admins.</div>';

  html += '<div class="taskform">' +
    '<div class="field"><label>Name</label><input id="nuName" type="text" placeholder="Full name"></div>' +
    '<div class="field"><label>Email</label><input id="nuEmail" type="email" placeholder="email@company.com"></div>' +
    '<div class="field"><label>Password</label><input id="nuPass" type="password" placeholder="Temp password"></div>' +
    '<div class="field" style="flex:0 0 130px"><label>Role</label><select id="nuRole">' +
    '<option value="user">user</option><option value="admin">admin</option></select></div>' +
    '<button class="btn" id="nuAdd">Add User</button>' +
    '</div>';

  html += '<div class="banner" style="margin-top:0">As the admin you can see and reset every user’s password here. Passwords set before this feature was added show as “— (reset to view)”; use <b>Edit</b> to set a new one, which then becomes visible.</div>';

  html += '<div class="tablewrap"><table><thead><tr>' +
    '<th>Name</th><th>Email</th><th>Password</th><th>2FA</th><th>Role</th><th>Contacts</th><th>Open Tasks</th><th>Status</th><th>Actions</th></tr></thead><tbody>';
  state.users.forEach(function (u) {
    const isSelf = state.user && String(u.id) === String(state.user.id);
    const contacts = (u.contact_count !== undefined) ? u.contact_count : (u.contactCount !== undefined ? u.contactCount : '');
    const openTasks = (u.open_task_count !== undefined) ? u.open_task_count : (u.openTaskCount !== undefined ? u.openTaskCount : '');
    const pwCell = (u.password != null && u.password !== '')
      ? '<span class="pwmask" data-pw="' + escAttr(u.password) + '">••••••••</span> ' +
        '<button class="btn ghost small" data-pw-toggle title="Show / hide">Show</button>'
      : '<span class="hint">— (reset to view)</span>';
    const twofaCell = truthy(u.totp_enabled)
      ? '<span class="tag">On</span> ' + (isSelf ? '' : '<button class="btn ghost small" data-2fa-reset title="Clear this user’s 2FA if they lost their device">Reset</button>')
      : '<span class="hint">Off</span>';
    html += '<tr data-id="' + escAttr(u.id) + '">' +
      '<td>' + esc(u.name) + (isSelf ? ' <span class="tag blue">you</span>' : '') + '</td>' +
      '<td>' + esc(u.email) + '</td>' +
      '<td class="nowrap">' + pwCell + '</td>' +
      '<td class="nowrap">' + twofaCell + '</td>' +
      '<td><select class="inline" data-role' + (isSelf ? ' disabled' : '') + '>' +
      '<option value="user"' + (u.role === 'user' ? ' selected' : '') + '>user</option>' +
      '<option value="admin"' + (u.role === 'admin' ? ' selected' : '') + '>admin</option>' +
      '</select></td>' +
      '<td>' + esc(String(contacts)) + '</td>' +
      '<td>' + esc(String(openTasks)) + '</td>' +
      '<td><label class="toggle"><input type="checkbox" data-active' +
      (truthy(u.active) ? ' checked' : '') + (isSelf ? ' disabled' : '') + '> ' +
      (truthy(u.active) ? 'Active' : 'Inactive') + '</label></td>' +
      '<td class="nowrap">' +
      '<button class="btn ghost small" data-edit-user>Edit</button> ' +
      (isSelf ? '' : '<button class="btn ghost small" data-del-user title="Permanently remove this user; their contacts/tasks are reassigned to you">Delete</button>') +
      '</td>' +
      '</tr>' +
      // Hidden inline editor for this user (name / email / optional new password).
      '<tr class="editrow" data-editrow style="display:none"><td colspan="9">' +
      '<div class="taskform">' +
      '<div class="field" style="flex:1"><label>Name</label><input type="text" data-eu-name value="' + escAttr(u.name) + '"></div>' +
      '<div class="field" style="flex:1"><label>Email</label><input type="email" data-eu-email value="' + escAttr(u.email) + '"></div>' +
      '<div class="field" style="flex:1"><label>New password (optional)</label><input type="password" data-eu-pass placeholder="leave blank to keep"></div>' +
      '<button class="btn small" data-eu-save>Save</button>' +
      '<button class="btn ghost small" data-eu-cancel>Cancel</button>' +
      '</div>' +
      '</td></tr>';
  });
  html += '</tbody></table></div>';
  root.innerHTML = html;

  $('#nuAdd').addEventListener('click', async function () {
    const name = $('#nuName').value.trim();
    const email = $('#nuEmail').value.trim();
    const password = $('#nuPass').value;
    const role = $('#nuRole').value;
    if (!name || !email || !password) { toast('Name, email and password are required.', 'error'); return; }
    try {
      await api('POST', '/users', { name: name, email: email, password: password, role: role });
      toast('User added', 'ok');
      await refreshUsers();
      renderTeam();
    } catch (e) { toastErr(e); }
  });

  $all('tbody tr[data-id]', root).forEach(function (tr) {
    const id = tr.getAttribute('data-id');
    const editRow = tr.nextElementSibling && tr.nextElementSibling.hasAttribute('data-editrow')
      ? tr.nextElementSibling : null;

    // Password reveal toggle
    const pwToggle = $('[data-pw-toggle]', tr);
    if (pwToggle) pwToggle.addEventListener('click', function () {
      const span = $('.pwmask', tr);
      if (!span) return;
      const showing = span.getAttribute('data-shown') === '1';
      if (showing) { span.textContent = '••••••••'; span.setAttribute('data-shown', '0'); pwToggle.textContent = 'Show'; }
      else { span.textContent = span.getAttribute('data-pw') || ''; span.setAttribute('data-shown', '1'); pwToggle.textContent = 'Hide'; }
    });

    // Reset this user's 2FA (they lost their device)
    const twofaReset = $('[data-2fa-reset]', tr);
    if (twofaReset) twofaReset.addEventListener('click', async function () {
      if (!window.confirm('Clear this user’s 2FA? They’ll sign in with just their password until they set it up again.')) return;
      try {
        await api('POST', '/users/' + encodeURIComponent(id) + '/2fa-reset');
        toast('2FA reset for user', 'ok');
        await refreshUsers(); renderTeam();
      } catch (e) { toastErr(e); }
    });

    const roleSel = $('[data-role]', tr);
    if (roleSel) roleSel.addEventListener('change', async function () {
      try {
        await api('PATCH', '/users/' + encodeURIComponent(id), { role: roleSel.value });
        toast('Role updated', 'ok');
        await refreshUsers();
        renderTeam();
      } catch (e) {
        toastErr(e);
        await refreshUsers().catch(function () {});
        renderTeam();
      }
    });
    const activeCb = $('[data-active]', tr);
    if (activeCb) activeCb.addEventListener('change', async function () {
      try {
        await api('PATCH', '/users/' + encodeURIComponent(id), { active: activeCb.checked });
        toast(activeCb.checked ? 'User activated' : 'User deactivated', 'ok');
        await refreshUsers();
        renderTeam();
      } catch (e) {
        toastErr(e);
        await refreshUsers().catch(function () {});
        renderTeam();
      }
    });

    // ---- Edit (toggle inline editor)
    const editBtn = $('[data-edit-user]', tr);
    if (editBtn && editRow) editBtn.addEventListener('click', function () {
      editRow.style.display = editRow.style.display === 'none' ? '' : 'none';
    });
    const cancelBtn = editRow ? $('[data-eu-cancel]', editRow) : null;
    if (cancelBtn) cancelBtn.addEventListener('click', function () { editRow.style.display = 'none'; });
    const saveBtn = editRow ? $('[data-eu-save]', editRow) : null;
    if (saveBtn) saveBtn.addEventListener('click', async function () {
      const name = $('[data-eu-name]', editRow).value.trim();
      const email = $('[data-eu-email]', editRow).value.trim();
      const pass = $('[data-eu-pass]', editRow).value;
      if (!name || !email) { toast('Name and email are required.', 'error'); return; }
      const body = { name: name, email: email };
      if (pass) body.password = pass;
      saveBtn.disabled = true;
      try {
        await api('PATCH', '/users/' + encodeURIComponent(id), body);
        toast('User updated', 'ok');
        await refreshUsers();
        renderTeam();
      } catch (e) { toastErr(e); saveBtn.disabled = false; }
    });

    // ---- Delete (with confirmation)
    const delBtn = $('[data-del-user]', tr);
    if (delBtn) delBtn.addEventListener('click', async function () {
      const nameCell = $('td', tr);
      const label = nameCell ? nameCell.textContent.replace(' you', '').trim() : 'this user';
      if (!window.confirm('Permanently delete ' + label + '?\n\nTheir contacts, tasks and activity will be reassigned to you. This cannot be undone.')) return;
      delBtn.disabled = true;
      try {
        await api('DELETE', '/users/' + encodeURIComponent(id));
        toast('User deleted', 'ok');
        await refreshUsers();
        renderTeam();
      } catch (e) { toastErr(e); delBtn.disabled = false; }
    });
  });
}

/* ------------------------------ Lead Engine ------------------------------ */
/* Compliance: the Lead Engine only reads a CSV the user provides (a Google
   Sheet the USER published, or pasted CSV text). It never scrapes sites. */

/* Lead Engine triage status badge: NEW (gold), IN QUEUE (blue/grey),
   WORKING (muted). Rendered alongside the A-F grade badge. */
function leadStatusBadge(c) {
  const st = (c && c.lead_status ? String(c.lead_status) : '').trim().toUpperCase();
  if (['NEW', 'IN QUEUE', 'WORKING'].indexOf(st) === -1) return '';
  const cls = st === 'NEW' ? 'ls-new' : (st === 'IN QUEUE' ? 'ls-queue' : 'ls-working');
  return '<span class="status-badge ' + cls + '" title="Lead status: ' + escAttr(st) + '">' + esc(st) + '</span>';
}

function gradeBadge(c) {
  const g = (c && c.grade ? String(c.grade) : '').trim().toUpperCase();
  if (['A', 'B', 'C', 'D', 'E', 'F'].indexOf(g) === -1) return '';
  return '<span class="grade-badge grade-' + g + '" title="Lead grade ' + g + '">' + g + '</span>';
}

/** Load an external script once (cached by src). */
function loadScriptOnce(src) {
  return new Promise(function (resolve, reject) {
    if (document.querySelector('script[data-src="' + src + '"]')) return resolve();
    const s = document.createElement('script');
    s.src = src; s.setAttribute('data-src', src);
    s.onload = function () { resolve(); };
    s.onerror = function () { reject(new Error('Could not load helper library (check your connection).')); };
    document.head.appendChild(s);
  });
}

/** Read a CSV or Excel File and return CSV text (Excel parsed via SheetJS). */
async function fileToCsvText(file) {
  const name = (file.name || '').toLowerCase();
  if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
    await loadScriptOnce('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js');
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_csv(ws);
  }
  return await file.text();
}

function renderLeadEngine() {
  const root = $('#view-leadengine');
  const admin = isAdmin();

  let html = '' +
    '<div class="viewhead"><h2>Lead Engine</h2></div>' +
    '<div class="banner">Sync leads from a CSV you provide \u2014 a Google Sheet link or pasted CSV. ' +
    'Rows are graded A\u2013F, deduped by ZPID/address and change-tracked. New or sheet-updated leads are marked ' +
    '<span class="status-badge ls-new">NEW</span>; un-opened NEW leads age to ' +
    '<span class="status-badge ls-queue">IN QUEUE</span> on the next import; opening or calling a lead moves it to ' +
    '<span class="status-badge ls-working">WORKING</span>. This app never fetches or scrapes listing sites.</div>' +
    '<div class="panelbox">' +
    '<h3>Google Sheet URL</h3>' +
    '<p class="hint" style="margin:6px 0 10px">Paste the sheet\u2019s normal edit link \u2014 it is auto-converted to a CSV export link. ' +
    'Publish to web as CSV, or share the sheet as \u201canyone with link can view\u201d.</p>' +
    '<div class="actions-row">' +
    '<input class="search" id="leUrl" type="url" placeholder="https://docs.google.com/spreadsheets/d/.../edit?gid=0#gid=0" style="flex:1;min-width:260px">' +
    '<button class="btn" id="leRun">RUN Sync</button>' +
    '</div>' +
    '<h3 style="margin-top:20px">Upload your leads (CSV / Excel)</h3>' +
    '<p class="hint" style="margin:6px 0 10px">Import from a <b>.csv</b> or <b>.xlsx / .xls</b> file on your device — including Zillow exports. Columns are auto-mapped and graded A–F. ' +
    (admin ? 'Your uploaded leads are assigned to you.' : 'Leads you upload are assigned to <b>you</b> and are visible only to you and the admin.') +
    ' Not sure of the format? Download the template below and fill it in.</p>' +
    '<div class="actions-row">' +
    '<button class="btn ghost small" id="leTemplate">⬇ Download CSV template</button>' +
    '</div>' +
    '<div class="actions-row" style="margin-top:8px">' +
    '<input type="file" id="leFile" accept=".csv,.xlsx,.xls,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" style="display:none">' +
    '<button class="btn" id="leFilePick">Choose CSV / Excel…</button>' +
    '<span class="hint" id="leFileName" style="align-self:center"></span>' +
    '<button class="btn blue" id="leFileImport" disabled>Import file</button>' +
    '</div>';

  if (admin) {
    html += '<div class="sec" style="margin-top:18px"><h4>Daily auto-import (admin)</h4>' +
      '<div class="actions-row">' +
      '<label class="toggle"><input type="checkbox" id="leAuto"> Auto-import daily</label>' +
      '<label class="toggle">at <input type="time" id="leTime" value="06:00" class="search sm" style="min-width:110px"></label>' +
      '<button class="btn blue small" id="leSave">Save settings</button>' +
      '</div>' +
      '<p class="hint" style="margin:6px 0 0">Saving stores the Sheet URL and schedule on the server; the import then runs automatically every day (server time) using the same sync as the RUN button.</p>' +
      '<div class="kv" id="leLast" style="margin-top:8px"><b>Last import:</b> \u2014</div>' +
      '</div>';
  }

  html += '<h3 style="margin-top:20px">Or paste CSV</h3>' +
    '<div class="field" style="margin-top:8px"><textarea id="leCsv" rows="8" placeholder="Import Date,Date Found,Address,City,State,ZIP,Listing Price,..."></textarea></div>' +
    '<div class="actions-row"><button class="btn blue" id="lePaste">Import Pasted</button></div>' +
    '<div id="leResult" class="le-result"></div>' +
    '<p class="hint" style="margin:14px 0 0">Grades: ' +
    '<span class="grade-badge grade-A">A</span> <span class="grade-badge grade-B">B</span> ' +
    '<span class="grade-badge grade-C">C</span> <span class="grade-badge grade-D">D</span> ' +
    '<span class="grade-badge grade-E">E</span> <span class="grade-badge grade-F">F</span> ' +
    '\u2014 scored on price, days on market, FSBO, seller-financing keywords, price drops and contact info. ' +
    'Re-imports keep your stage, notes, owner and opened/called flags, and log every sheet change to the lead\u2019s Import change history.</p>' +
    '</div>';

  root.innerHTML = html;

  function setResult(msg, isErr) {
    const el = $('#leResult');
    if (!el) return;
    el.textContent = msg;
    el.className = 'le-result ' + (isErr ? 'error' : 'ok');
  }

  async function loadLeSettings() {
    if (!admin) return;
    try {
      const sset = await api('GET', '/leadengine/settings') || {};
      const urlEl = $('#leUrl');
      if (urlEl && sset.csvUrl && !urlEl.value) urlEl.value = sset.csvUrl;
      const autoEl = $('#leAuto');
      if (autoEl) autoEl.checked = sset.autoimport === 'on';
      const m = String(sset.cron || '').match(/^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/);
      const timeEl = $('#leTime');
      if (timeEl && m) {
        timeEl.value = ('0' + m[2]).slice(-2) + ':' + ('0' + m[1]).slice(-2);
      }
      const lastEl = $('#leLast');
      if (lastEl) {
        if (sset.lastImportAt) {
          const cnt = sset.lastCounts || {};
          lastEl.innerHTML = '<b>Last import:</b> ' + esc(fmtTimestamp(sset.lastImportAt)) +
            ' \u2014 ' + esc(cnt.inserted !== undefined ? cnt.inserted : '?') + ' new, ' +
            esc(cnt.updated !== undefined ? cnt.updated : '?') + ' updated' +
            (cnt.queued ? ', ' + esc(cnt.queued) + ' moved to IN QUEUE' : '');
        } else {
          lastEl.innerHTML = '<b>Last import:</b> never';
        }
      }
    } catch (e) { /* non-admin or fetch failure — panel stays at defaults */ }
  }

  async function runSync(payload, btn) {
    const orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Syncing...';
    try {
      const out = await api('POST', '/leadengine/sync', payload) || {};
      let msg = 'Imported ' + (out.inserted || 0) + ' new, updated ' + (out.updated || 0) +
        ', ' + (out.unchanged || 0) + ' unchanged' +
        (out.queued ? ', ' + out.queued + ' moved to IN QUEUE' : '');
      if (out.errors && out.errors.length) {
        msg += ' \u2014 ' + out.errors.length + ' row error(s): ' + out.errors.slice(0, 3).join('; ');
      }
      setResult(msg, false);
      await refreshContacts().catch(function () {});
      loadLeSettings();
      toast('Lead Engine sync complete', 'ok');
    } catch (e) {
      setResult(e && e.message ? e.message : String(e), true);
    }
    btn.disabled = false;
    btn.textContent = orig;
  }

  const leTpl = $('#leTemplate');
  if (leTpl) leTpl.addEventListener('click', async function () {
    this.disabled = true;
    try {
      const resp = await fetch('/api/leadengine/template.csv', {
        headers: state.token ? { Authorization: 'Bearer ' + state.token } : {},
      });
      if (!resp.ok) throw new Error('Could not download template');
      const blob = await resp.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'Deal-Flow-Pro-lead-template.csv';
      document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    } catch (e) { toastErr(e); }
    this.disabled = false;
  });

  $('#leRun').addEventListener('click', function () {
    const url = $('#leUrl').value.trim();
    if (!url) { toast('Paste the Google Sheet link first.', 'error'); return; }
    runSync({ csvUrl: url }, this); // the server saves this URL for auto-import
  });
  $('#lePaste').addEventListener('click', function () {
    const text = $('#leCsv').value;
    if (!text.trim()) { toast('Paste CSV text first.', 'error'); return; }
    runSync({ csvText: text }, this);
  });

  // ---- Upload a CSV / Excel file
  var lePicked = null;
  const leFile = $('#leFile'), leFilePick = $('#leFilePick'), leFileImport = $('#leFileImport'), leFileName = $('#leFileName');
  if (leFilePick) leFilePick.addEventListener('click', function () { leFile.click(); });
  if (leFile) leFile.addEventListener('change', function () {
    lePicked = (leFile.files && leFile.files[0]) || null;
    if (leFileName) leFileName.textContent = lePicked ? lePicked.name : '';
    if (leFileImport) leFileImport.disabled = !lePicked;
  });
  if (leFileImport) leFileImport.addEventListener('click', async function () {
    if (!lePicked) { toast('Choose a file first.', 'error'); return; }
    const btn = this; const orig = btn.textContent;
    btn.disabled = true; btn.textContent = 'Reading…';
    try {
      const csvText = await fileToCsvText(lePicked);
      btn.textContent = orig;
      if (!csvText || !csvText.trim()) { setResult('That file appears to be empty.', true); btn.disabled = false; return; }
      runSync({ csvText: csvText }, btn); // runSync re-enables the button
    } catch (e) {
      setResult(e && e.message ? e.message : String(e), true);
      btn.textContent = orig; btn.disabled = false;
    }
  });

  if (admin) {
    $('#leSave').addEventListener('click', async function () {
      const btn = this;
      btn.disabled = true;
      try {
        const parts = String($('#leTime').value || '06:00').split(':');
        const hh = parseInt(parts[0], 10);
        const mm = parseInt(parts[1], 10);
        const cronSpec = (isNaN(mm) ? 0 : mm) + ' ' + (isNaN(hh) ? 6 : hh) + ' * * *';
        await api('POST', '/leadengine/settings', {
          csvUrl: $('#leUrl').value.trim(),
          autoimport: $('#leAuto').checked ? 'on' : 'off',
          cron: cronSpec
        });
        toast('Lead Engine settings saved', 'ok');
        loadLeSettings();
      } catch (e) { toastErr(e); }
      btn.disabled = false;
    });
    loadLeSettings();
  }
}

/* ------------------------------ Settings ------------------------------ */

function renderSettings() {
  const root = $('#view-settings');
  const live = state.config.messagingMode === 'live';
  root.innerHTML = '' +
    '<div class="viewhead"><h2>Settings</h2></div>' +
    '<div class="panelbox">' +
    '<h3>Messaging</h3>' +
    '<div class="kv"><b>Mode:</b> <span class="mode-badge' + (live ? ' live' : '') + '">' +
    (live ? 'Live messaging' : 'Stub mode') + '</span></div>' +
    '<p class="hint">' + (live
      ? 'Automated texts and ringless voicemails are being sent through the configured provider.'
      : 'Stub mode: automated sends are simulated and written to the activity log, but no real SMS or voicemail goes out.') + '</p>' +
    '<h3 style="margin-top:18px">Enabling live automated texting</h3>' +
    '<p class="hint">Automated SMS requires a registered A2P (10DLC) business phone number and Twilio credentials ' +
    '(<code>TWILIO_ACCOUNT_SID</code>, <code>TWILIO_AUTH_TOKEN</code>, <code>TWILIO_FROM_NUMBER</code>) in the server’s ' +
    '<code>.env</code> file. Once those are set and the number’s A2P campaign is approved, the server switches to live mode automatically. ' +
    'Manual tap-to-text, tap-to-call, and email links in the contact modal work from your own device without any of that setup.</p>' +
    '<h3 style="margin-top:18px">My Voicemail Greeting</h3>' +
    '<p class="hint">Your own greeting — what callers hear when a call to you goes to voicemail. Only you can see and change this. Type a greeting (spoken by the system) and/or record your own voice — a recording, if present, is used instead of the text.</p>' +
    '<div class="field"><label>Greeting text</label>' +
    '<textarea id="vmGreetText" rows="2" placeholder="You\'ve reached Deal Flow Pro. Please leave a message after the tone, then hang up."></textarea></div>' +
    '<div class="actions-row"><button class="btn small" id="vmGreetSave">Save text</button></div>' +
    '<div class="rvmrec" style="margin-top:10px">' +
    '  <button type="button" class="btn small" id="vmGreetRec">● Record greeting</button>' +
    '  <button type="button" class="btn ghost small" id="vmGreetStop" disabled>■ Stop</button>' +
    '  <span class="hint" id="vmGreetStatus"></span>' +
    '  <audio id="vmGreetPreview" controls style="display:none;max-width:220px;height:34px;vertical-align:middle"></audio>' +
    '  <button type="button" class="btn small" id="vmGreetSaveRec" disabled>Save recording</button>' +
    '</div>' +
    '<div id="vmGreetCurrent" class="doclist"></div>' +
    '<h3 style="margin-top:18px">Google Tasks &amp; Calendar</h3>' +
    '<div id="googleBox"><p class="hint">Checking Google status…</p></div>' +
    '<h3 style="margin-top:18px">Microsoft To Do &amp; Outlook Calendar</h3>' +
    '<div id="microsoftBox"><p class="hint">Checking Microsoft status…</p></div>' +
    '<p class="hint" style="margin-top:8px;opacity:.75">You can connect Google, Microsoft, or both — each person on the team chooses their own. Tasks you own sync to whichever you connect.</p>' +
    '<h3 style="margin-top:18px">Account</h3>' +
    '<div class="kv"><b>Signed in as:</b> ' + esc(state.user ? state.user.name : '') + ' (' + esc(state.user ? state.user.email : '') + ')</div>' +
    '<div class="kv"><b>Role:</b> ' + esc(state.user ? state.user.role : '') + '</div>' +

    '<h3 style="margin-top:18px">Change my password</h3>' +
    '<p class="hint">Update your own password anytime. You need your current one.</p>' +
    '<div class="grid3">' +
    '  <div class="field"><label>Current password</label><input id="pwCurrent" type="password" autocomplete="current-password"></div>' +
    '  <div class="field"><label>New password</label><input id="pwNew" type="password" autocomplete="new-password"></div>' +
    '  <div class="field"><label>Confirm new</label><input id="pwNew2" type="password" autocomplete="new-password"></div>' +
    '</div>' +
    '<div class="actions-row"><button class="btn small" id="pwSave">Update password</button><span class="hint" id="pwMsg"></span></div>' +

    '<h3 style="margin-top:18px">Two-factor authentication (2FA)</h3>' +
    '<div id="twofaBoxSettings"><p class="hint">Checking 2FA status…</p></div>' +
    '</div>';

  renderGoogleBox(); // render from cached status immediately...
  refreshGoogleStatus().then(renderGoogleBox); // ...then re-check the server
  renderMicrosoftBox();
  refreshMicrosoftStatus().then(renderMicrosoftBox);
  wireVmGreeting();        // per-user greeting for everyone
  wirePasswordChange();    // self-service password change
  refreshTwoFactorSection(); // 2FA status + enable/disable controls
}

/** Settings → self-service password change. */
function wirePasswordChange() {
  const btn = $('#pwSave');
  if (!btn) return;
  btn.addEventListener('click', async function () {
    const cur = $('#pwCurrent').value, nw = $('#pwNew').value, nw2 = $('#pwNew2').value;
    const msg = $('#pwMsg');
    msg.textContent = '';
    if (!cur || !nw) { msg.textContent = 'Fill in all fields.'; return; }
    if (nw.length < 6) { msg.textContent = 'New password must be at least 6 characters.'; return; }
    if (nw !== nw2) { msg.textContent = 'New passwords do not match.'; return; }
    btn.disabled = true;
    try {
      await api('POST', '/account/password', { currentPassword: cur, newPassword: nw });
      $('#pwCurrent').value = ''; $('#pwNew').value = ''; $('#pwNew2').value = '';
      toast('Password updated', 'ok');
    } catch (e) { msg.textContent = e.message; }
    btn.disabled = false;
  });
}

/** Settings → render current 2FA state + enable/disable controls. */
async function refreshTwoFactorSection() {
  const box = $('#twofaBoxSettings');
  if (!box) return;
  let st;
  try { st = await api('GET', '/account/2fa/status'); }
  catch (e) { box.innerHTML = '<p class="hint">Could not load 2FA status.</p>'; return; }

  if (st.enabled) {
    box.innerHTML =
      '<div class="kv"><b>Status:</b> <span class="tag">On</span>' +
      (st.required ? ' <span class="hint">(required for admins)</span>' : '') + '</div>' +
      '<div class="actions-row"><button class="btn ghost small danger" id="twofaOff">Turn off 2FA</button></div>';
    $('#twofaOff').addEventListener('click', async function () {
      const code = window.prompt('Enter a current 2FA code (or your password) to turn 2FA off:');
      if (!code) return;
      try {
        await api('POST', '/account/2fa/disable', { code: code, password: code });
        toast('2FA turned off', 'ok');
        refreshTwoFactorSection();
      } catch (e) { toastErr(e); }
    });
  } else {
    box.innerHTML =
      '<div class="kv"><b>Status:</b> <span class="tag warn">Off</span>' +
      (st.required ? ' <span class="hint">— required for your admin account, please turn it on</span>' : '') + '</div>' +
      '<p class="hint">Protect your account with a code from an authenticator app (Google Authenticator, Authy, 1Password, etc.).</p>' +
      '<div class="actions-row"><button class="btn small" id="twofaOn">Set up 2FA</button></div>';
    $('#twofaOn').addEventListener('click', function () { openTwoFactorSetup(false); });
  }
}

/**
 * 2FA enrollment modal: fetches a secret + QR, shows both, verifies a code.
 * When `forced` is true (admin who must enroll), the modal is not dismissable
 * until 2FA is enabled.
 */
async function openTwoFactorSetup(forced) {
  let data;
  try { data = await api('POST', '/account/2fa/setup'); }
  catch (e) { toastErr(e); return; }

  const qrImg = data.qr ? '<img src="' + escAttr(data.qr) + '" alt="QR code" style="width:180px;height:180px;background:#fff;border-radius:10px;padding:6px">' : '';
  const body =
    '<div class="mbody">' +
    (forced ? '<div class="banner">Two-factor authentication is required for admin accounts. Please finish setup to continue.</div>' : '') +
    '<p class="hint">1. Install an authenticator app (Google Authenticator, Authy, 1Password…).<br>' +
    '2. Scan this QR code, or enter the key manually.<br>' +
    '3. Type the 6-digit code the app shows to confirm.</p>' +
    '<div style="text-align:center;margin:12px 0">' + qrImg + '</div>' +
    '<div class="kv" style="text-align:center"><b>Manual key:</b> <code>' + esc(data.secret || '') + '</code></div>' +
    '<div class="field" style="max-width:220px;margin:14px auto 0"><label>6-digit code</label>' +
    '<input id="twofaEnableCode" type="text" inputmode="numeric" maxlength="6" placeholder="123456"></div>' +
    '<div class="err" id="twofaSetupErr" style="text-align:center"></div>' +
    '</div>' +
    '<div class="mfoot">' +
    (forced ? '' : '<button class="btn ghost" id="twofaSetupCancel">Cancel</button>') +
    '<button class="btn blue" id="twofaEnableBtn">Verify &amp; turn on</button></div>';

  openModal('Set up two-factor authentication', body, { dismissable: !forced });

  const cancel = $('#twofaSetupCancel');
  if (cancel) cancel.addEventListener('click', closeModal);
  $('#twofaEnableBtn').addEventListener('click', async function () {
    const code = ($('#twofaEnableCode').value || '').trim();
    const err = $('#twofaSetupErr');
    err.textContent = '';
    if (!code) { err.textContent = 'Enter the 6-digit code.'; return; }
    this.disabled = true;
    try {
      await api('POST', '/account/2fa/enable', { code: code });
      closeModal();
      toast('Two-factor authentication is on', 'ok');
      refreshTwoFactorSection();
    } catch (e) { err.textContent = e.message; this.disabled = false; }
  });
}

/** Settings → Voicemail Greeting: text + recorded voice greeting. */
function wireVmGreeting() {
  const textEl = $('#vmGreetText');
  if (!textEl) return;
  const saveText = $('#vmGreetSave');
  const recBtn = $('#vmGreetRec'), stopBtn = $('#vmGreetStop'), saveRec = $('#vmGreetSaveRec');
  const statusEl = $('#vmGreetStatus'), preview = $('#vmGreetPreview'), curBox = $('#vmGreetCurrent');
  let mediaRecorder = null, chunks = [], recordedB64 = null, recUrl = null, startTs = 0, durMs = 0, timer = null;

  async function refresh() {
    try {
      const g = await api('GET', '/settings/vm-greeting');
      textEl.value = g.text || '';
      if (curBox) {
        curBox.innerHTML = g.hasAudio
          ? '<div class="docitem"><span class="docname">🔊 Recorded voice greeting (in use)</span>' +
            '<span class="docacts">' +
            '<button class="btn ghost small" id="vmGreetPlay">Play</button>' +
            '<button class="btn ghost small danger" id="vmGreetDel">Remove</button></span></div>'
          : '<p class="hint">No voice greeting recorded — the text above is spoken to callers.</p>';
        const play = $('#vmGreetPlay'); if (play) play.onclick = function () { playRecording(g.recordingId); };
        const del = $('#vmGreetDel'); if (del) del.onclick = async function () {
          if (!window.confirm('Remove the recorded greeting? Callers will hear the text instead.')) return;
          try { await api('DELETE', '/settings/vm-greeting/recording'); toast('Greeting recording removed', 'ok'); refresh(); }
          catch (e) { toastErr(e); }
        };
      }
    } catch (e) {}
  }

  if (saveText) saveText.addEventListener('click', async function () {
    try { await api('POST', '/settings/vm-greeting', { text: textEl.value }); toast('Greeting text saved', 'ok'); }
    catch (e) { toastErr(e); }
  });

  if (recBtn) recBtn.addEventListener('click', async function () {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toast('Recording not supported here.', 'error'); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunks = [];
      mediaRecorder = new MediaRecorder(stream);
      mediaRecorder.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
      mediaRecorder.onstop = async function () {
        stream.getTracks().forEach(function (t) { t.stop(); });
        clearInterval(timer); durMs = Date.now() - startTs;
        const blob = new Blob(chunks, { type: chunks[0] ? chunks[0].type : 'audio/webm' });
        statusEl.textContent = 'Processing…';
        try {
          const wav = await blobToWav(blob);
          recordedB64 = await fileToBase64(wav);
          if (recUrl) URL.revokeObjectURL(recUrl);
          recUrl = URL.createObjectURL(wav); preview.src = recUrl; preview.style.display = 'inline-block';
          saveRec.disabled = false; statusEl.textContent = 'Recorded ' + fmtDur(Math.round(durMs / 1000)) + ' — preview, then Save.';
        } catch (e) { toast('Could not process recording.', 'error'); statusEl.textContent = ''; }
      };
      mediaRecorder.start(); startTs = Date.now();
      recBtn.disabled = true; stopBtn.disabled = false; saveRec.disabled = true;
      statusEl.textContent = 'Recording… 0:00';
      timer = setInterval(function () { statusEl.textContent = 'Recording… ' + fmtDur(Math.round((Date.now() - startTs) / 1000)); }, 500);
    } catch (e) { toast('Microphone blocked or unavailable.', 'error'); }
  });

  if (stopBtn) stopBtn.addEventListener('click', function () {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    recBtn.disabled = false; stopBtn.disabled = true;
  });

  if (saveRec) saveRec.addEventListener('click', async function () {
    if (!recordedB64) { toast('Record something first.', 'error'); return; }
    saveRec.disabled = true;
    try {
      await api('POST', '/settings/vm-greeting/recording', { mime: 'audio/wav', dataBase64: recordedB64, duration_ms: durMs });
      toast('Voice greeting saved — callers will hear it.', 'ok');
      recordedB64 = null; preview.style.display = 'none'; statusEl.textContent = '';
      refresh();
    } catch (e) { toastErr(e); saveRec.disabled = false; }
  });

  refresh();
}

/* Google section of Settings — status card + Connect/Disconnect actions. */
function renderGoogleBox() {
  const box = $('#googleBox');
  if (!box) return;

  const g = state.google;
  if (!g || !g.configured) {
    box.innerHTML = '<p class="hint" style="opacity:.7">Google integration not configured yet. ' +
      'Once <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> are set on the server, ' +
      'you can connect your Google account here to sync CRM tasks to Google Tasks and Calendar.</p>';
    return;
  }

  if (!g.connected) {
    box.innerHTML = '<p class="hint">Connect your Google account and every new CRM task is added to ' +
      'Google Tasks — tasks with a due date also become an all-day Google Calendar event with a reminder.</p>' +
      '<div class="actions-row"><button class="btn" id="gConnect">Connect Google</button></div>';
    $('#gConnect').addEventListener('click', async function () {
      const btn = this;
      btn.disabled = true;
      try {
        const out = await api('GET', '/google/auth') || {};
        if (!out.url) throw new Error('Could not start Google sign-in.');
        window.location = out.url; // off to Google's consent screen
      } catch (e) {
        toastErr(e);
        btn.disabled = false;
      }
    });
    return;
  }

  box.innerHTML = '<div class="kv"><b>Connected as:</b> ' + esc(g.email || 'Google account') +
    ' <span class="pill sent"><input type="checkbox" disabled checked> Syncing</span></div>' +
    '<p class="hint" style="margin:6px 0 10px">New tasks are pushed to Google Tasks; tasks with a due date also get an all-day Calendar event.</p>' +
    '<div class="actions-row"><button class="btn ghost small" id="gDisconnect">Disconnect</button></div>';
  $('#gDisconnect').addEventListener('click', async function () {
    const btn = this;
    btn.disabled = true;
    try {
      await api('POST', '/google/disconnect');
      toast('Google account disconnected', 'ok');
      await refreshGoogleStatus();
      renderGoogleBox();
    } catch (e) {
      toastErr(e);
      btn.disabled = false;
    }
  });
}

/* Microsoft section of Settings — status card + Connect/Disconnect actions. */
function renderMicrosoftBox() {
  const box = $('#microsoftBox');
  if (!box) return;

  const m = state.microsoft;
  if (!m || !m.configured) {
    box.innerHTML = '<p class="hint" style="opacity:.7">Microsoft integration not configured yet. ' +
      'Once <code>MS_CLIENT_ID</code> and <code>MS_CLIENT_SECRET</code> are set on the server, ' +
      'you can connect your Microsoft account here to sync CRM tasks to Microsoft To Do and Outlook Calendar.</p>';
    return;
  }

  if (!m.connected) {
    box.innerHTML = '<p class="hint">Connect your Microsoft account and every new CRM task is added to ' +
      'Microsoft To Do — tasks with a due date also become an Outlook Calendar event (timed if you set a time).</p>' +
      '<div class="actions-row"><button class="btn" id="msConnect">Connect Microsoft</button></div>';
    $('#msConnect').addEventListener('click', async function () {
      const btn = this;
      btn.disabled = true;
      try {
        const out = await api('GET', '/microsoft/auth') || {};
        if (!out.url) throw new Error('Could not start Microsoft sign-in.');
        window.location = out.url; // off to Microsoft's consent screen
      } catch (e) {
        toastErr(e);
        btn.disabled = false;
      }
    });
    return;
  }

  box.innerHTML = '<div class="kv"><b>Connected as:</b> ' + esc(m.email || 'Microsoft account') +
    ' <span class="pill sent"><input type="checkbox" disabled checked> Syncing</span></div>' +
    '<p class="hint" style="margin:6px 0 10px">New tasks are pushed to Microsoft To Do; tasks with a due date also get an Outlook Calendar event.</p>' +
    '<div class="actions-row"><button class="btn ghost small" id="msDisconnect">Disconnect</button></div>';
  $('#msDisconnect').addEventListener('click', async function () {
    const btn = this;
    btn.disabled = true;
    try {
      await api('POST', '/microsoft/disconnect');
      toast('Microsoft account disconnected', 'ok');
      await refreshMicrosoftStatus();
      renderMicrosoftBox();
    } catch (e) {
      toastErr(e);
      btn.disabled = false;
    }
  });
}

/* ------------------------------ Wiring / init ------------------------------ */

document.addEventListener('DOMContentLoaded', function () {
  // auth
  $('#authSubmit').addEventListener('click', submitAuth);
  $('#authToggle').addEventListener('click', function () {
    state.registerMode = !state.registerMode;
    applyRegisterMode();
  });
  ['authEmail', 'authPassword', 'authName'].forEach(function (id) {
    $('#' + id).addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') submitAuth();
    });
  });
  const twofaSubmit = $('#twofaSubmit');
  if (twofaSubmit) twofaSubmit.addEventListener('click', submitTwoFactor);
  const twofaCode = $('#twofaCode');
  if (twofaCode) twofaCode.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') submitTwoFactor(); });
  const twofaCancel = $('#twofaCancel');
  if (twofaCancel) twofaCancel.addEventListener('click', function () { state.twofaTicket = null; resetLoginForm(); });

  // nav
  $all('#navTabs button').forEach(function (b) {
    b.addEventListener('click', function () { switchTab(b.getAttribute('data-tab')); });
  });
  $('#logoutBtn').addEventListener('click', function () {
    clearSession();
    showLogin();
  });

  // esc closes modal (unless the current modal is non-dismissable)
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && state._modalDismissable !== false) closeModal();
  });

  // Toast + clean URL when returning from the Google consent screen.
  handleGoogleReturnParam();

  // boot the app
  if (state.token) {
    bootApp();
  } else {
    showLogin();
  }
});
