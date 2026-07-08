/* RenewEQ CRM — service worker (installability + web push + app badge).
 * Deliberately does NOT cache app.js/styles.css so updates are never stale;
 * it's network-passthrough with a tiny offline fallback for navigations. */
'use strict';

const OFFLINE_MSG = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<body style="font-family:system-ui;background:#0b1020;color:#fff;display:grid;place-items:center;height:100vh;margin:0">' +
  '<div style="text-align:center"><h2>RenewEQ CRM</h2><p>You appear to be offline. Reconnect and reopen.</p></div></body>';

self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });

// Network passthrough; if a navigation fails offline, show a friendly page.
self.addEventListener('fetch', function (event) {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(function () {
      return new Response(OFFLINE_MSG, { headers: { 'Content-Type': 'text/html' } });
    }));
  }
});

// Web push → show a notification + update the app badge.
self.addEventListener('push', function (event) {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch (e) { data = { body: event.data ? event.data.text() : '' }; }
  const title = data.title || 'RenewEQ CRM';
  const opts = {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.tag || undefined,
    renotify: !!data.tag,
    data: { url: data.url || '/' },
  };
  event.waitUntil((async function () {
    await self.registration.showNotification(title, opts);
    if (typeof data.badge === 'number' && self.navigator && self.navigator.setAppBadge) {
      try { data.badge > 0 ? await self.navigator.setAppBadge(data.badge) : await self.navigator.clearAppBadge(); } catch (e) {}
    }
  })());
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async function () {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) { if ('focus' in c) { try { await c.navigate(url); } catch (e) {} return c.focus(); } }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});
