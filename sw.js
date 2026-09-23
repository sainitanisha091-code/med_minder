/* ============================================================
   MedMinder v3 — Service Worker (sw.js)

   ARCHITECTURE (final):
   ─────────────────────
   All scheduling timers live in the PAGE (shared.js).
   Page-side setTimeout is reliable for as long as the page is open.
   The SW's only job is to show the OS notification panel alert
   when the page posts a SHOW_NOTIFICATION message, and to handle
   notification action clicks (Mark Taken / Snooze).

   WHY this architecture instead of SW-side timers?
   • Browsers idle-terminate SWs after ~30 s of inactivity.
   • An SW setTimeout set for "in 60 minutes" is killed long before
     it fires — silently, with no error, no fallback.
   • Page-side timers survive as long as the tab is open.
   • For background notifications (tab closed), you need the Push API
     with a server — that is out of scope here.

   Message types the SW handles:
     SHOW_NOTIFICATION  — show OS alert for the given reminder
     CANCEL_ALL         — (no-op now; kept for API compatibility)
     SCHEDULE_REMINDER  — (no-op now; kept for API compatibility)
     CANCEL_REMINDER    — (no-op now; kept for API compatibility)
============================================================ */

const SW_VERSION = 'medminder-sw-v2';

/* ── Install & activate ── */
self.addEventListener('install',  () => self.skipWaiting());
self.addEventListener('activate', e  => e.waitUntil(self.clients.claim()));

/* ── Listen for messages from the page ── */
self.addEventListener('message', event => {
  const { type, reminder } = event.data || {};

  if (type === 'SHOW_NOTIFICATION') {
    fireNotification(reminder);
  }

  // Legacy message types kept for API compatibility — no-ops now.
  // Scheduling is handled entirely by the page (shared.js).
  // if (type === 'SCHEDULE_REMINDER') { /* no-op */ }
  // if (type === 'CANCEL_REMINDER')   { /* no-op */ }
  // if (type === 'CANCEL_ALL')        { /* no-op */ }
});

/* ── fireNotification — show OS notification ── */
function fireNotification(r) {
  if (!r || !r.name) return;

  const title = '💊 MedMinder — Medicine Time!';
  const body  = `Take ${r.name}${r.dose && r.dose !== '—' ? ' · ' + r.dose : ''}${r.notes ? '\n' + r.notes : ''}`;

  self.registration.showNotification(title, {
    body,
    icon:    '/favicon.ico',
    badge:   '/favicon.ico',
    tag:     `medminder-${r.id}`,   // collapses duplicate OS alerts
    renotify: true,
    requireInteraction: true,
    silent:  false,
    vibrate: [200, 100, 200],
    data:    { id: r.id, url: '/MedMinder_Dashboard.html' },
    actions: [
      { action: 'done',   title: '✅ Mark Taken' },
      { action: 'snooze', title: '⏰ Snooze 10min' }
    ]
  });
}

/* ── Notification click ── */
self.addEventListener('notificationclick', event => {
  const { action, notification } = event;
  notification.close();

  if (action === 'done') {
    event.waitUntil(
      self.clients.matchAll({ type: 'window' }).then(clients => {
        clients.forEach(c => c.postMessage({
          type: 'MARK_DONE',
          reminderId: notification.data?.id
        }));
        if (clients.length) return clients[0].focus();
        return self.clients.openWindow(notification.data?.url || '/MedMinder_Dashboard.html');
      })
    );

  } else if (action === 'snooze') {
    // Delegate snooze to the page — it holds the full reminder object.
    // The SW only has { id, url } in notification.data, not name/dose/notes.
    self.clients.matchAll({ type: 'window' }).then(clients => {
      clients.forEach(c => c.postMessage({
        type: 'SNOOZE_REQUEST',
        reminderId: notification.data?.id,
        snoozeTime: snoozeTime(10)
      }));
    });

  } else {
    event.waitUntil(
      self.clients.matchAll({ type: 'window' }).then(clients => {
        const match = clients.find(c => c.url.includes('MedMinder'));
        if (match) return match.focus();
        return self.clients.openWindow(notification.data?.url || '/MedMinder_Dashboard.html');
      })
    );
  }
});

/* ── Helper: HH:MM string N minutes from now ── */
function snoozeTime(mins) {
  const d = new Date(Date.now() + mins * 60000);
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}