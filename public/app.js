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
  google: null, // {configured, connected, email} from /api/google/status
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
    setSession(out.token, out.user);
    $('#authPassword').value = '';
    await bootApp();
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

  await refreshContacts().catch(toastErr);
  switchTab('pipeline');
}

function isAdmin() { return state.user && state.user.role === 'admin'; }

async function refreshContacts() {
  state.contacts = await api('GET', '/contacts') || [];
}
async function refreshTasks() {
  state.tasks = await api('GET', '/tasks') || [];
}
async function refreshUsers() {
  state.users = await api('GET', '/users') || [];
}
async function refreshGoogleStatus() {
  try {
    state.google = await api('GET', '/google/status');
  } catch (e) {
    state.google = null; // older server / fetch failure — treat as unavailable
  }
  return state.google;
}

/* After returning from Google's consent screen the callback redirects to
   /?google=connected or /?google=error — show a toast, then clean the URL. */
function handleGoogleReturnParam() {
  let params;
  try { params = new URLSearchParams(window.location.search); }
  catch (e) { return; }
  if (!params.has('google')) return;
  const v = params.get('google');
  if (v === 'connected') toast('Google account connected — tasks will sync.', 'ok');
  else toast('Google connection failed. Please try again.', 'error');
  params.delete('google');
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
  let html = '' +
    '<div class="viewhead">' +
    '  <h2>Pipeline</h2>' +
    '  <button class="btn" id="npBtn">+ New Contact</button>' +
    '  <button class="btn blue" id="alBtn">+ Add Lead</button>' +
    '  <span class="hint">Drag cards between stages to update.</span>' +
    '</div>' +
    '<div class="board" id="board">';

  STAGES.forEach(function (stage) {
    const cards = state.contacts.filter(function (c) { return (c.stage || STAGES[0]) === stage; });
    html += '<div class="col" data-stage="' + escAttr(stage) + '">' +
      '<h3><span>' + esc(stage) + '</span><span class="count">' + cards.length + '</span></h3>' +
      '<div class="cards" data-stage="' + escAttr(stage) + '">';
    cards.forEach(function (c) {
      html += pipelineCardHtml(c);
    });
    html += '</div></div>';
  });
  html += '</div>';
  root.innerHTML = html;

  $('#npBtn').addEventListener('click', function () { openContactModal(null); });
  $('#alBtn').addEventListener('click', openLeadIntake);

  // card events
  $all('.pcard', root).forEach(function (card) {
    card.addEventListener('click', function () {
      const id = card.getAttribute('data-id');
      const c = state.contacts.find(function (x) { return String(x.id) === String(id); });
      if (c) openContactModal(c);
    });
    card.addEventListener('dragstart', function (ev) {
      ev.dataTransfer.setData('text/plain', String(card.getAttribute('data-id')));
      ev.dataTransfer.effectAllowed = 'move';
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', function () {
      card.classList.remove('dragging');
      $all('.col.dragover', root).forEach(function (col) { col.classList.remove('dragover'); });
    });
  });

  // column drop targets
  $all('.col', root).forEach(function (col) {
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
      renderPipeline(); // optimistic
      try {
        const updated = await api('PATCH', '/contacts/' + encodeURIComponent(id), { stage: stage });
        if (updated) replaceContact(updated);
        toast('Moved "' + (c.name || 'contact') + '" to ' + stage, 'ok');
      } catch (e) {
        c.stage = prev;
        renderPipeline();
        toastErr(e);
      }
    });
  });
}

function pipelineCardHtml(c) {
  let meta = '';
  if (c.lead_status) meta += leadStatusBadge(c);
  if ((c.source === 'Lead' || c.source === 'Lead Engine') && (c.stage || STAGES[0]) === 'Prospect') meta += '<span class="tag lead">NEW LEAD</span>';
  if (truthy(c.isFsbo)) meta += '<span class="tag warn">FSBO</span>';
  if (c.zillow) meta += '<span class="tag blue">Zillow</span>';
  if (isAdmin() && c.ownerName) meta += '<span class="tag grey">' + esc(c.ownerName) + '</span>';
  if (truthy(c.dnc)) meta += '<span class="tag warn">DNC</span>';
  if (c.closing) meta += '<span class="tag">Close ' + esc(fmtDate(c.closing)) + '</span>';
  return '<div class="pcard" draggable="true" data-id="' + escAttr(c.id) + '">' +
    '<div class="nm">' + gradeBadge(c) + esc(c.name || '(no name)') + '</div>' +
    '<div class="pr">' + esc(c.property || '') + '</div>' +
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

  // Bulk assign needs the user list (admin only).
  if (isAdmin() && !state.users.length) {
    refreshUsers().then(renderBulkBar).catch(function () {});
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
    state.users.map(function (u) {
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
      '<td>' + esc(c.phone || (truthy(c.isFsbo) ? c.fsboPhone : c.agentPhone) || '') + '</td>' +
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
      if (ev.target && ev.target.getAttribute && ev.target.getAttribute('data-stop')) return;
      var id = tr.getAttribute('data-id');
      var c = (state.contactList || []).find(function (x) { return String(x.id) === String(id); }) ||
        state.contacts.find(function (x) { return String(x.id) === String(id); });
      if (c) openContactModal(c);
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
  html += '<div class="sec"><h4>Ringless Voicemail</h4>' +
    '<div class="field"><label>Voicemail script</label>' +
    '<textarea data-field="rvm" rows="3" placeholder="Voicemail message...">' + esc(c.rvm || '') + '</textarea></div>' +
    '<div class="actions-row">' +
    '<button class="btn small" id="dropRvmBtn"' + (isNew || !canRvm ? ' disabled' : '') + '>Drop RVM</button>' +
    '<label class="pill' + (truthy(c.rvmStatus) ? ' sent' : '') + '" id="rvmPill">' +
    '<input type="checkbox" disabled' + (truthy(c.rvmStatus) ? ' checked' : '') + '> RVM dropped</label>' +
    '</div>' +
    (!isNew && !canRvm ? '<p class="hint">Dropping disabled: ' + (truthy(c.dnc) ? 'contact is marked DNC.' : 'RVM consent not granted.') + '</p>' : '') +
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

  // ---- Drop RVM
  const rvmBtn = $('#dropRvmBtn', overlay);
  if (rvmBtn) {
    rvmBtn.addEventListener('click', async function () {
      rvmBtn.disabled = true;
      const orig = rvmBtn.textContent;
      rvmBtn.textContent = 'Dropping...';
      try {
        const rvmEl = $('[data-field="rvm"]', overlay);
        await api('PATCH', '/contacts/' + encodeURIComponent(c.id), { rvm: rvmEl ? rvmEl.value : (c.rvm || '') });
        const updated = await api('POST', '/contacts/' + encodeURIComponent(c.id) + '/send-rvm');
        if (updated && updated.id !== undefined) replaceContact(updated);
        const pill = $('#rvmPill', overlay);
        if (pill) { pill.classList.add('sent'); pill.querySelector('input').checked = true; }
        toast('Ringless voicemail dropped', 'ok');
        loadActivities(c.id);
      } catch (e) { toastErr(e); }
      rvmBtn.textContent = orig;
      rvmBtn.disabled = false;
    });
  }

  // ---- Admin: assign-to-user dropdown (PATCHes owner_id; owner_id is the
  //      tenant-isolation key, so assigning moves visibility to that user).
  if (isAdmin()) {
    (async function () {
      try {
        if (!state.users.length) await refreshUsers();
        const sel = $('#assignOwner', overlay);
        if (!sel) return;
        sel.innerHTML = state.users.map(function (u) {
          return '<option value="' + escAttr(u.id) + '"' +
            (String(u.id) === String(c.owner_id) ? ' selected' : '') + '>' +
            esc(u.name) + ' (' + esc(u.email) + ')</option>';
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
      return '<div class="logitem">' +
        '<div class="lh">' +
        '<span><span class="typechip ' + chipClass + '">' + esc(type.toUpperCase()) + '</span>' +
        (extra.length ? ' <span>' + extra.join(' &middot; ') + '</span>' : '') + '</span>' +
        '<span>' + esc(fmtTimestamp(a.created_at)) + (a.created_by ? ' &middot; ' + esc(a.created_by) : '') + '</span>' +
        '</div>' +
        '<div>' + esc(a.body || '') + '</div>' +
        '</div>';
    }).join('');
    box.scrollTop = box.scrollHeight;
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

  let contactOpts = '<option value="">— No linked contact —</option>';
  state.contacts.forEach(function (c) {
    contactOpts += '<option value="' + escAttr(c.id) + '">' + esc(c.name || c.property || ('Contact #' + c.id)) + '</option>';
  });

  let html = '' +
    '<div class="viewhead">' +
    '  <h2>Tasks</h2>' +
    '  <button class="btn blue" id="icsBtn">Export to Calendar/To-Do (.ics)</button>' +
    '</div>' +
    '<div class="banner">The .ics export can be imported into (or subscribed to from) Google Calendar, Apple Calendar/Reminders, and Outlook — your CRM tasks show up as calendar events with due dates.</div>' +
    '<div class="taskform">' +
    '  <div class="field" style="flex:2"><label>New task</label><input id="taskTitle" type="text" placeholder="e.g. Follow up with seller"></div>' +
    '  <div class="field"><label>Due date</label><input id="taskDue" type="date"></div>' +
    '  <div class="field"><label>Link to contact</label><select id="taskContact">' + contactOpts + '</select></div>' +
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
    const cid = $('#taskContact').value;
    if (cid) body.contact_id = isNaN(Number(cid)) ? cid : Number(cid);
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
  });
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
  return '<div class="taskitem' + (isDone ? ' done' : '') + '" data-id="' + escAttr(t.id) + '">' +
    '<input type="checkbox"' + (isDone ? ' checked' : '') + ' title="Toggle done">' +
    '<span class="tt">' + esc(t.title || '') +
    (isAdmin() && t.ownerName ? ' <span class="tag grey">' + esc(t.ownerName) + '</span>' : '') +
    '</span>' +
    (contact ? '<button class="linklike" data-contact-link="' + escAttr(contact.id) + '">' + esc(contact.name || 'contact') + '</button>' : '') +
    (dd ? '<span class="due' + (overdue ? ' overdue' : '') + '">due ' + esc(dd) + '</span>' : '') +
    googleBit +
    '<button class="btn ghost small" data-del="1">Delete</button>' +
    '</div>';
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

  html += '<div class="tablewrap"><table><thead><tr>' +
    '<th>Name</th><th>Email</th><th>Role</th><th>Contacts</th><th>Open Tasks</th><th>Status</th></tr></thead><tbody>';
  state.users.forEach(function (u) {
    const isSelf = state.user && String(u.id) === String(state.user.id);
    html += '<tr data-id="' + escAttr(u.id) + '">' +
      '<td>' + esc(u.name) + (isSelf ? ' <span class="tag blue">you</span>' : '') + '</td>' +
      '<td>' + esc(u.email) + '</td>' +
      '<td><select class="inline" data-role' + (isSelf ? ' disabled' : '') + '>' +
      '<option value="user"' + (u.role === 'user' ? ' selected' : '') + '>user</option>' +
      '<option value="admin"' + (u.role === 'admin' ? ' selected' : '') + '>admin</option>' +
      '</select></td>' +
      '<td>' + esc(u.contactCount !== undefined ? u.contactCount : '') + '</td>' +
      '<td>' + esc(u.openTaskCount !== undefined ? u.openTaskCount : '') + '</td>' +
      '<td><label class="toggle"><input type="checkbox" data-active' +
      (truthy(u.active) ? ' checked' : '') + (isSelf ? ' disabled' : '') + '> ' +
      (truthy(u.active) ? 'Active' : 'Inactive') + '</label></td>' +
      '</tr>';
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

  $all('tbody tr', root).forEach(function (tr) {
    const id = tr.getAttribute('data-id');
    const roleSel = $('[data-role]', tr);
    roleSel.addEventListener('change', async function () {
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
    activeCb.addEventListener('change', async function () {
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
    '<h3 style="margin-top:18px">Google Tasks &amp; Calendar</h3>' +
    '<div id="googleBox"><p class="hint">Checking Google status…</p></div>' +
    '<h3 style="margin-top:18px">Account</h3>' +
    '<div class="kv"><b>Signed in as:</b> ' + esc(state.user ? state.user.name : '') + ' (' + esc(state.user ? state.user.email : '') + ')</div>' +
    '<div class="kv"><b>Role:</b> ' + esc(state.user ? state.user.role : '') + '</div>' +
    '</div>';

  renderGoogleBox(); // render from cached status immediately...
  refreshGoogleStatus().then(renderGoogleBox); // ...then re-check the server
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

  // nav
  $all('#navTabs button').forEach(function (b) {
    b.addEventListener('click', function () { switchTab(b.getAttribute('data-tab')); });
  });
  $('#logoutBtn').addEventListener('click', function () {
    clearSession();
    showLogin();
  });

  // esc closes modal
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') closeModal();
  });

  // Toast + clean URL when returning from the Google consent screen.
  handleGoogleReturnParam();

  // boot
  if (state.token) {
    bootApp();
  } else {
    showLogin();
  }
});
