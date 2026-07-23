/* ============================================================================
 * mobile.js — Mobile-only enhancement layer for Deal Flow Pro.
 *
 * ADDITIVE + NON-DESTRUCTIVE: this file only *adds* a bottom tab bar, a compact
 * one-screen dashboard, and a card-style contacts list, and only when the
 * screen is phone-width (<=720px) or running inside the native app. Desktop is
 * never touched — every hook degrades to a no-op above the breakpoint.
 *
 * It reuses the existing app globals (switchTab, state, STAGES, money,
 * openContactModal) rather than duplicating any logic.
 * ========================================================================== */
(function () {
  'use strict';

  var MQ = window.matchMedia('(max-width:720px)');
  function isMobile() { return MQ.matches; }

  /* ---- SVG icons (inline, crisp) ---- */
  var IC = {
    home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/></svg>',
    pipe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="6" height="14" rx="1.5"/><rect x="15" y="3" width="6" height="9" rx="1.5"/></svg>',
    people: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9"/><path d="M16 3.1a4 4 0 0 1 0 7.8"/></svg>',
    chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z"/></svg>',
    more: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3 8-8"/><path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9"/></svg>',
    engine: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 2 7l10 5 10-5-10-5Z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/></svg>',
    team: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.9"/></svg>',
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H1a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 2.6 7Z"/></svg>',
    logout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/></svg>',
    phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3-8.6A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.4-1.2a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2Z"/></svg>',
    sms: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z"/></svg>'
  };

  /* ---- Primary bottom-tab config (maps to existing data-tab views) ---- */
  var TABS = [
    { tab: 'dashboard', label: 'Home', icon: IC.home },
    { tab: 'pipeline', label: 'Pipeline', icon: IC.pipe },
    { tab: 'contacts', label: 'Contacts', icon: IC.people, center: true },
    { tab: 'conversations', label: 'Inbox', icon: IC.chat, badge: true },
    { tab: '__more__', label: 'More', icon: IC.more }
  ];

  var navEl, sheetEl, building = false;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m];
    });
  }
  function fmtMoney(n) { try { return money(n); } catch (e) { return '$' + (Number(n) || 0).toLocaleString(); } }

  /* ------------------------------------------------------------------ nav */
  function buildNav() {
    if (navEl) return;
    navEl = document.createElement('nav');
    navEl.className = 'mnav';
    navEl.innerHTML = TABS.map(function (t) {
      return '<button class="mtab' + (t.center ? ' center' : '') + '" data-mtab="' + t.tab + '">' +
        (t.badge ? '<span class="mnb" style="display:none">0</span>' : '') +
        '<span class="mti">' + t.icon + '</span><span class="mtl">' + t.label + '</span></button>';
    }).join('');
    document.body.appendChild(navEl);

    navEl.addEventListener('click', function (e) {
      var btn = e.target.closest('.mtab'); if (!btn) return;
      var t = btn.getAttribute('data-mtab');
      if (t === '__more__') { openSheet(); return; }
      try { switchTab(t); } catch (err) {}
      closeSheet();
    });

    // Build "More" sheet
    sheetEl = document.createElement('div');
    sheetEl.className = 'msheet-bg';
    sheetEl.innerHTML =
      '<div class="msheet"><div class="mgrip"></div><h3>More</h3>' +
      moreItem('tasks', IC.check, 'Tasks', 'Your to-do list', '#f59e0b') +
      moreItem('leadengine', IC.engine, 'Lead Engine', 'Pull Zillow leads by keyword', '#8b5cf6') +
      '<div data-more-team>' + moreItem('team', IC.team, 'Team', 'Assign contacts & deals', '#3b82f6') + '</div>' +
      moreItem('settings', IC.gear, 'Settings', 'Automations, texts, RVM', '#5b6472') +
      '<button class="mitem mlogout" data-logout><span class="mmi" style="background:#dc2626">' + IC.logout + '</span>' +
      '<span><span class="mmt">Log out</span></span></button>' +
      '</div>';
    document.body.appendChild(sheetEl);

    sheetEl.addEventListener('click', function (e) {
      if (e.target === sheetEl) { closeSheet(); return; }
      var logout = e.target.closest('[data-logout]');
      if (logout) { closeSheet(); var lb = document.getElementById('logoutBtn'); if (lb) lb.click(); return; }
      var item = e.target.closest('.mitem[data-mtab]');
      if (item) { try { switchTab(item.getAttribute('data-mtab')); } catch (err) {} closeSheet(); }
    });
  }
  function moreItem(tab, icon, title, sub, color) {
    return '<button class="mitem" data-mtab="' + tab + '"><span class="mmi" style="background:' + color + '">' + icon + '</span>' +
      '<span><span class="mmt">' + title + '</span><span class="mms">' + sub + '</span></span><span class="marw">›</span></button>';
  }
  function openSheet() { if (sheetEl) { sheetEl.classList.add('open'); syncTeamItem(); } }
  function closeSheet() { if (sheetEl) sheetEl.classList.remove('open'); }

  function syncTeamItem() {
    // Only show Team for admins (the native Team tab button is unhidden for admins).
    var teamBtn = document.getElementById('teamTabBtn');
    var wrap = sheetEl && sheetEl.querySelector('[data-more-team]');
    if (wrap) wrap.style.display = (teamBtn && !teamBtn.classList.contains('hidden')) ? '' : 'none';
  }

  function syncActive() {
    if (!navEl) return;
    var cur = (state && state.tab) || 'dashboard';
    var primary = ['dashboard', 'pipeline', 'contacts', 'conversations'];
    navEl.querySelectorAll('.mtab').forEach(function (b) {
      var t = b.getAttribute('data-mtab');
      var on = (t === cur) || (t === '__more__' && primary.indexOf(cur) === -1);
      b.classList.toggle('on', on);
    });
    // Inbox unread badge mirrors the native #convNavBadge
    var src = document.getElementById('convNavBadge');
    var nb = navEl.querySelector('.mtab[data-mtab="conversations"] .mnb');
    if (nb) {
      var n = src && !src.classList.contains('hidden') ? (src.textContent || '').trim() : '';
      if (n && n !== '0') { nb.textContent = n; nb.style.display = ''; }
      else { nb.style.display = 'none'; }
    }
  }

  /* ------------------------------------------------ compact dashboard */
  var UC_STAGES = ['Offer Accepted', 'Property Analyzer', 'BOG Walk Through', 'EMD Sent', 'Dispo'];
  var WON_STAGES = ['Assigned', 'Closed'];
  function truthy(v) { return v === true || v === 1 || v === '1' || v === 'true'; }
  function dealVal(c) {
    var w = (c.wholesale_fee !== null && c.wholesale_fee !== undefined && c.wholesale_fee !== '') ? Number(c.wholesale_fee) : null;
    if (w && isFinite(w)) return w;
    return Number(c.price) || 0;
  }

  function renderMobileDash() {
    var root = document.getElementById('view-dashboard');
    if (!root || !isMobile()) return;
    var all = (state && state.contacts) || [];
    var active = all.filter(function (c) { return !truthy(c.archived); });
    var byStage = {};
    active.forEach(function (c) { var s = c.stage || 'New'; byStage[s] = (byStage[s] || 0) + 1; });
    var count = function (list) { return active.filter(function (c) { return list.indexOf(c.stage) !== -1; }).length; };

    var pipeVal = active.reduce(function (a, c) { return a + dealVal(c); }, 0);
    var won = count(WON_STAGES);
    var underContract = count(UC_STAGES);
    var offersOut = count(['Offer Sent', 'Negotiation']);
    var activeDeals = active.length - won;
    var wonRevenue = active.filter(function (c) { return WON_STAGES.indexOf(c.stage) !== -1; }).reduce(function (a, c) { return a + dealVal(c); }, 0);

    // Funnel snapshot
    var steps = [['New', 'New'], ['Contacted', 'Contacted'], ['Offer Sent', 'Offer Sent'], ['Offer Accepted', 'Accepted'], ['Closed', 'Closed']];
    var maxF = 1; steps.forEach(function (s) { maxF = Math.max(maxF, byStage[s[0]] || 0); });

    // Tasks due today (incl. overdue)
    var today = new Date(); today.setHours(0, 0, 0, 0);
    var todayISO = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
    var tasks = (state && state.tasks) || [];
    var due = tasks.filter(function (t) { return !truthy(t.done) && t.due_date && String(t.due_date).slice(0, 10) <= todayISO; });
    var name = (state && state.user && state.user.name ? state.user.name.split(' ')[0] : 'there');
    var hr = new Date().getHours();
    var greet = hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';

    var kpi = function (label, value, sub, cls, ic) {
      return '<div class="mkpi"><div class="mkt"><span class="mkdot ' + cls + '">' + ic + '</span>' + label + '</div>' +
        '<div class="mkv">' + value + '</div><div class="mkd">' + sub + '</div></div>';
    };
    var frow = function (lbl, n) {
      var w = Math.round(((n || 0) / maxF) * 100);
      return '<div class="mfrow"><span class="mflbl">' + lbl + '</span><span class="mftrack"><span class="mffill" style="width:' + w + '%"></span></span><span class="mfval">' + (n || 0) + '</span></div>';
    };

    var html =
      '<div class="mhero"><div class="mh-l">' + greet + ', ' + esc(name) + '</div>' +
      '<div class="mh-big">' + fmtMoney(pipeVal) + '</div>' +
      '<div class="mh-sub">Pipeline value · <b>' + due.length + '</b> ' + (due.length === 1 ? 'task' : 'tasks') + ' due today</div></div>' +
      '<div class="mkpis">' +
      kpi('Active', activeDeals, 'in pipeline', 'blu', IC.pipe) +
      kpi('Offers Out', offersOut, offersOut ? 'awaiting reply' : 'none pending', 'amb', IC.sms) +
      kpi('Under Contract', underContract, 'in progress', 'pur', IC.check) +
      kpi('Won', won, fmtMoney(wonRevenue) + ' value', 'grn', IC.home) +
      '</div>' +
      '<div class="mpanel"><div class="mph"><h3>Pipeline</h3><a data-goto="pipeline">View board ›</a></div>' +
      '<div class="mfunnel">' + steps.map(function (s) { return frow(s[1], byStage[s[0]] || 0); }).join('') + '</div></div>' +
      '<div class="mpanel mtoday"><div class="mph"><h3>Today</h3><a data-goto="tasks">All tasks ›</a></div>' +
      (due.length ? due.slice(0, 3).map(function (t) {
        return '<div class="mtrow"><span class="mtck"></span><div class="mtmeta"><div class="mtnm">' + esc(t.title || 'Task') + '</div>' +
          '<div class="mtsub">' + (t.due_time ? 'Due ' + esc(t.due_time) : 'Due today') + '</div></div></div>';
      }).join('') : '<div class="mempty">Nothing due today 🎉</div>') +
      '</div>';

    var mount = document.getElementById('mDash');
    if (!mount) { mount = document.createElement('div'); mount.id = 'mDash'; root.insertBefore(mount, root.firstChild); }
    mount.innerHTML = html;
    mount.querySelectorAll('[data-goto]').forEach(function (a) {
      a.addEventListener('click', function () { try { switchTab(a.getAttribute('data-goto')); } catch (e) {} });
    });
  }

  /* ------------------------------------------------ contacts as cards */
  function stageClass(s) {
    if (WON_STAGES.indexOf(s) !== -1) return 'acc';
    if (UC_STAGES.indexOf(s) !== -1) return 'contract';
    if (s === 'Offer Sent' || s === 'Negotiation' || s === 'Qualified') return 'offer';
    if (s === 'Dead Deal') return 'dead';
    return 'new';
  }
  var AV = ['#6d5efc', '#f7971e', '#11998e', '#dc2626', '#8b5cf6', '#0ea5e9', '#e8590c'];
  function initials(n) { return String(n || '?').trim().split(/\s+/).map(function (x) { return x[0]; }).slice(0, 2).join('').toUpperCase(); }

  function renderMobileContacts() {
    var root = document.getElementById('view-contacts');
    if (!root || !isMobile() || building) return;
    var list = ((state && state.contactList) && state.contactList.length ? state.contactList : (state && state.contacts)) || [];
    var q = ((root.querySelector('#mcSearch') && root.querySelector('#mcSearch').value) || '').toLowerCase();
    if (q) {
      list = list.filter(function (c) {
        return [c.name, c.property, c.phone, c.city, c.agentName].some(function (v) { return String(v || '').toLowerCase().indexOf(q) !== -1; });
      });
    }
    var cards = list.map(function (c, i) {
      var st = c.stage || 'New';
      var isZ = c.zillow || c.source === 'Lead' || c.source === 'Lead Engine' || c.lead_source;
      var color = AV[i % AV.length];
      var phone = String(c.phone || '').replace(/[^0-9+]/g, '');
      var acts = phone ? (
        '<a class="mqbtn call" href="tel:' + esc(phone) + '" onclick="event.stopPropagation()">' + IC.phone + '</a>' +
        '<a class="mqbtn text" href="sms:' + esc(phone) + '" onclick="event.stopPropagation()">' + IC.sms + '</a>'
      ) : '';
      return '<div class="mccard" data-cid="' + esc(c.id) + '">' +
        '<span class="mcav" style="background:' + color + '">' + esc(initials(c.name)) + '</span>' +
        '<div class="mcmid"><div class="mcn">' + esc(c.name || 'Unnamed') + '</div>' +
        '<div class="mcaddr">' + esc(c.property || c.city || 'No address') + '</div>' +
        '<div class="mctags"><span class="mstag ' + stageClass(st) + '">' + esc(st) + '</span>' +
        (isZ ? '<span class="mstag zillow">◆ Zillow</span>' : '') + '</div></div>' +
        '<div class="mcact">' + acts + '</div></div>';
    }).join('');

    var html =
      '<div class="mchead"><h1>Contacts</h1><span class="mcnt">' + list.length + '</span></div>' +
      '<div class="mcsearch"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>' +
      '<input id="mcSearch" placeholder="Search name, address, phone…" value="' + esc(q) + '"></div>' +
      '<button class="maddbtn" data-newcontact>+ New Contact</button>' +
      '<div class="mclist">' + (cards || '<div class="mempty">No contacts yet.</div>') + '</div>';

    var mount = document.getElementById('mContacts');
    building = true;
    if (!mount) { mount = document.createElement('div'); mount.id = 'mContacts'; root.appendChild(mount); }
    mount.innerHTML = html;
    building = false;

    var search = mount.querySelector('#mcSearch');
    if (search) {
      search.addEventListener('input', function () { renderMobileContacts(); setTimeout(function () { var s = document.getElementById('mcSearch'); if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); } }, 0); });
    }
    mount.querySelectorAll('.mccard').forEach(function (card) {
      card.addEventListener('click', function () {
        var id = card.getAttribute('data-cid');
        var c = (list.concat((state && state.contacts) || [])).find(function (x) { return String(x.id) === String(id); });
        if (c) { try { openContactModal(c); } catch (e) {} }
      });
    });
    var addBtn = mount.querySelector('[data-newcontact]');
    if (addBtn) addBtn.addEventListener('click', function () { try { openContactModal(null, { stage: (typeof STAGES !== 'undefined' ? STAGES[0] : 'New') }); } catch (e) {} });
  }

  /* ------------------------------------------------ observers / wiring */
  function afterRender() {
    if (!isMobile()) return;
    syncActive();
    var tab = (state && state.tab);
    if (tab === 'dashboard') renderMobileDash();
    else if (tab === 'contacts') renderMobileContacts();
  }

  function watch() {
    // Re-sync the bottom bar whenever the native tab bar's active state changes.
    var navTabs = document.getElementById('navTabs');
    if (navTabs) {
      new MutationObserver(function () { syncActive(); }).observe(navTabs, { attributes: true, subtree: true, attributeFilter: ['class'] });
    }
    // When the app re-renders a view's contents, re-apply our mobile version.
    ['view-dashboard', 'view-contacts'].forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      new MutationObserver(function () {
        if (building || !isMobile()) return;
        if (el.classList.contains('hidden')) return;
        if (id === 'view-dashboard' && !document.getElementById('mDash')) renderMobileDash();
        if (id === 'view-contacts' && !document.getElementById('mContacts')) renderMobileContacts();
      }).observe(el, { childList: true });
    });
    // Toggle bottom bar visibility with login state (#app gains/loses .hidden).
    var appEl = document.getElementById('app');
    if (appEl) {
      var sync = function () { document.body.classList.toggle('app-live', !appEl.classList.contains('hidden')); };
      new MutationObserver(sync).observe(appEl, { attributes: true, attributeFilter: ['class'] });
      sync();
    }
  }

  function init() {
    buildNav();
    watch();
    afterRender();
    // Nudge after initial data loads settle.
    setTimeout(afterRender, 400);
    setTimeout(afterRender, 1200);
    MQ.addEventListener && MQ.addEventListener('change', afterRender);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
