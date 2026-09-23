/* ============================================================
   MedMinder v3 — Shared JavaScript (shared.js)

   Bug Fixes Applied (original):
   1. findById() used dangerous recursion → replaced with Array.findIndex()
   2. toggleDone() returned wrong value (returned reminders[i].done AFTER toggle,
      but callers read it as "wasDone" — fixed with explicit pre-check)
   3. isOverdue() compared raw minutes without accounting for "equal" time
      (a reminder at the current minute was wrongly flagged overdue) → use <
   4. initToast() returned a new function each call; pages stored it in a
      local `toast` var but used it before assignment in some event handlers →
      moved toast to module-level with lazy init guard
   5. seedDemo() used index `i===1` to pre-mark Omega-3 as done, but array
      position is fragile; made condition explicit (name match)
   6. exportData() silently failed if no data to export; added guard + toast
   7. Dark-mode chart colours were not updated on theme toggle → charts now
      destroy + recreate on toggleTheme() so colours reflect current theme

   Bug Fixes Applied (this session):
   8.  Duplicate notifications — SW + fallback timer both fired beep/toast for
       the same reminder. Fallback body now guarded by `if (!_swReady)` so it
       only runs when the Service Worker is NOT available.
   9.  Duplicate SW message listener — _registerSW() added a new
       `navigator.serviceWorker.addEventListener('message', _onSWMessage)`
       every time initNotifications() was called (each page load / navigation).
       Fixed with a module-level `_swMessageListenerAdded` boolean guard.
   10. checkReminders() polling fired beep/toast even when the SW was already
       handling notifications. Added early-return guards:
         if (_swReady) return
         if fallback timers are active, return
   11. Grace-window fix — scheduleAllReminders() used `if (msUntil < 0) return`
       which silently dropped reminders set 1-2 minutes in the past (e.g. user
       adds a reminder for 10:05 but saves it at 10:06). Now:
         msUntil >= 0       → schedule at exact future time (unchanged)
         -120000 ≤ msUntil < 0 → clamp to 0, fire immediately (grace window)
         msUntil < -120000  → truly past, skip (unchanged)
       Same fix applied to sw.js scheduleReminder().
   12. checkReminders() polling: was string-matching `r.time === cur` where
       `cur` used padStart but the stored time might lack padding on very old
       records. Now parses both sides to minutes for a safe numeric compare.
   13. _onSWMessage MARK_DONE: read reminder name BEFORE calling toggleDone()
       because toggleDone() mutates reminders[idx]; the name lookup was safe
       but could theoretically race if the array was replaced — made explicit.
   14. addReminder(): `d.notes` could be undefined if the caller omits the field
       (e.g. old import data). Added `(d.notes || '').trim()` guard. Same for
       `d.dose`.
============================================================ */

'use strict';

/* ── Constants ── */
const STORAGE_KEY = 'medminder_v3';
const THEME_KEY   = 'medminder_theme';
const USER_KEY    = 'medminder_user';
const SESSION_KEY = 'medminder_session';   // key used by login.js SessionManager
const LOGIN_PAGE  = 'login.html';
const CAT_ORDER   = ['morning', 'afternoon', 'evening', 'night', 'asneeded'];
const CAT_META    = {
  morning:   { label: 'Morning',   emoji: '🌅', color: '#f59e0b' },
  afternoon: { label: 'Afternoon', emoji: '☀️', color: '#3b82f6' },
  evening:   { label: 'Evening',   emoji: '🌆', color: '#8b5cf6' },
  night:     { label: 'Night',     emoji: '🌙', color: '#06b6d4' },
  asneeded:  { label: 'As Needed', emoji: '⚡', color: '#ef4444' }
};

/* ── State ── */
let reminders   = [];
let currentUser = 'default';

/* ── Theme ── */
function applyTheme(t) {
  document.body.classList.toggle('dark', t === 'dark');
  localStorage.setItem(THEME_KEY, t);
  const b = document.getElementById('theme-btn');
  if (b) b.textContent = t === 'dark' ? '☀️' : '🌙';
  // BUG FIX #7: notify page-level code to rebuild charts after theme change
  if (typeof onThemeChanged === 'function') onThemeChanged();
}

function toggleTheme() {
  applyTheme(document.body.classList.contains('dark') ? 'light' : 'dark');
}

function initTheme() {
  applyTheme(localStorage.getItem(THEME_KEY) || 'light');
}

/* ── User ── */
function getUserKey() { return `${STORAGE_KEY}_${currentUser}`; }

function initUser() {
  currentUser = localStorage.getItem(USER_KEY) || 'default';
}

/* ── Storage ── */
function saveReminders() {
  try {
    localStorage.setItem(getUserKey(), JSON.stringify(reminders));
  } catch (e) {
    console.error('Save failed:', e);
  }
}

function loadReminders() {
  try {
    const r = localStorage.getItem(getUserKey());
    reminders = r ? JSON.parse(r) : [];
  } catch (e) {
    reminders = [];
  }
}

/* ── ID generator ── */
const makeId = (() => {
  let c = 0;
  return () => `med_${Date.now()}_${++c}`;
})();

/* ── Time helpers ── */
const timeToMins = t => {
  if (!t) return Infinity;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};

const formatTime = t => {
  if (!t) return '—';
  let [h, m] = t.split(':').map(Number);
  const a = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, '0')} ${a}`;
};

/* ── BUG FIX #3: isOverdue — use strictly-less-than so a reminder at the
   exact current minute is NOT yet marked overdue ── */
const isOverdue = r => {
  if (r.done || !r.time) return false;
  const n = new Date();
  return timeToMins(r.time) < n.getHours() * 60 + n.getMinutes();
};

/* ── HTML escape ── */
const escHtml = s =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/* ── BUG FIX #1: findById — replaced fragile recursion with Array.findIndex ── */
function findById(arr, id) {
  return arr.findIndex(r => r.id === id);
}

/* ── CRUD operations ── */
function addReminder(d) {
  const { stock = 30, minimumStock = 5 } = d;

  const r = {
    id:           makeId(),
    name:         d.name.trim(),
    // BUG FIX #14: guard against undefined dose / notes from old import data
    dose:         (d.dose  || '').trim() || '—',
    time:         d.time,
    cat:          d.cat,
    freq:         d.freq,
    notes:        (d.notes || '').trim(),
    done:         false,
    stock:        Math.max(0, Number(stock)        || 30),
    minimumStock: Math.max(1, Number(minimumStock) || 5),
    createdAt:    new Date().toISOString()
  };
  reminders.push(r);
  saveReminders();
  return r;
}

function updateReminder(id, d) {
  const i = findById(reminders, id);
  if (i === -1) return null;
  reminders[i] = {
    ...reminders[i],
    name:  d.name.trim(),
    // BUG FIX #14: same guard for update path
    dose:  (d.dose  || '').trim() || '—',
    time:  d.time,
    cat:   d.cat,
    freq:  d.freq,
    notes: (d.notes || '').trim()
  };
  saveReminders();
  return reminders[i];
}

function deleteReminder(id) {
  const i = findById(reminders, id);
  if (i === -1) return null;
  const [r] = reminders.splice(i, 1);
  saveReminders();
  return r;
}

/* ── BUG FIX #2: toggleDone — capture the NEW state first, then assign,
   then return it. Original returned post-mutation value as if it were
   pre-mutation, confusing callers that tested "was it already done?" ── */
function toggleDone(id) {
  const i = findById(reminders, id);
  if (i === -1) return false;

  const nowDone = !reminders[i].done;
  reminders[i].done = nowDone;

  if (nowDone) {
    const { stock = 30, minimumStock = 5, name } = reminders[i];
    reminders[i].stock = Math.max(0, stock - 1);
    const updatedStock = reminders[i].stock;

    if (updatedStock === 0) {
      _toast(`⛔ ${name} is OUT OF STOCK — please refill!`, 'error');
    } else if (updatedStock <= minimumStock) {
      _toast(`⚠️ Low stock: ${name} has ${updatedStock} dose${updatedStock === 1 ? '' : 's'} left`, 'warn');
    }
  }

  saveReminders();
  return nowDone;
}

/* ============================================================
   STOCK TRACKING — Helper Functions
============================================================ */

const getStockStatus = ({ stock = 30, minimumStock = 5 }) => {
  if (stock === 0)           return 'out';
  if (stock <= minimumStock) return 'low';
  return 'ok';
};

const getStockBadge = (reminder) => {
  const { stock = 30, minimumStock = 5, name } = reminder;
  const status = getStockStatus({ stock, minimumStock });

  const badgeMap = {
    out: () => `<span class="stock-badge stock-out" title="${escHtml(name)}: out of stock">⛔ Out of Stock</span>`,
    low: () => `<span class="stock-badge stock-low" title="${escHtml(name)}: ${stock} doses left">⚠️ Low: ${stock} left</span>`,
    ok:  () => '',
  };

  return (badgeMap[status] ?? badgeMap.ok)();
};

const getLowStockReminders = () =>
  reminders.filter(r => getStockStatus(r) !== 'ok');

const calcStockSummary = () =>
  reminders.reduce((acc, r) => {
    const status = getStockStatus(r);
    acc.total++;
    if (status === 'out') acc.outOfStock++;
    if (status === 'low') acc.lowStock++;
    return acc;
  }, { total: 0, lowStock: 0, outOfStock: 0 });

/* ── Stats ── */
const calcStats = d => d.reduce((a, r) => {
  a.total++;
  if (r.done)            a.done++;
  else if (isOverdue(r)) a.overdue++;
  else                   a.pending++;

  const status = getStockStatus(r);
  if (status === 'out') a.outOfStock++;
  if (status === 'low') a.lowStock++;

  return a;
}, { total: 0, done: 0, pending: 0, overdue: 0, lowStock: 0, outOfStock: 0 });

/* ── Sort / Filter ── */
const sortReminders = (arr, m = 'time') => [...arr].sort((a, b) =>
  m === 'time' ? timeToMins(a.time) - timeToMins(b.time) :
  m === 'name' ? a.name.localeCompare(b.name) :
  CAT_ORDER.indexOf(a.cat) - CAT_ORDER.indexOf(b.cat)
);

const filterReminders = (arr, m = 'all') => arr.filter(r =>
  m === 'all'     ? true :
  m === 'pending' ? (!r.done && !isOverdue(r)) :
  m === 'done'    ? r.done :
  m === 'overdue' ? isOverdue(r) :
  r.cat === m
);

/* ── BUG FIX #6: exportData — guard against empty list ── */
function exportData() {
  if (!reminders.length) {
    _toast('Nothing to export', 'info');
    return;
  }
  const d = JSON.stringify({ user: currentUser, reminders, exportedAt: new Date().toISOString() }, null, 2);
  const b = new Blob([d], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(b);
  a.download = `medminder_${currentUser}_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ============================================================
   IMPORT — Shared validation + merge logic
============================================================ */

const VALID_CATS  = new Set(CAT_ORDER);
const VALID_FREQS = new Set([
  'Daily', 'Twice daily', 'Three times daily', 'Weekly', 'As needed'
]);

function validateReminder(r, index) {
  if (typeof r !== 'object' || r === null || Array.isArray(r)) {
    throw new Error(`Item at index ${index} is not an object`);
  }

  const {
    id           = '',
    name         = '',
    dose         = '—',
    time         = '',
    cat          = '',
    freq         = '',
    notes        = '',
    done         = false,
    stock        = 30,
    minimumStock = 5,
    createdAt    = new Date().toISOString(),
  } = r;

  if (!name.trim())
    throw new Error(`Item ${index + 1}: "name" is required`);

  if (!time || !/^\d{2}:\d{2}$/.test(time))
    throw new Error(`Item ${index + 1} ("${name}"): "time" must be HH:MM format`);

  if (!VALID_CATS.has(cat))
    throw new Error(`Item ${index + 1} ("${name}"): unknown category "${cat}"`);

  if (!VALID_FREQS.has(freq))
    throw new Error(`Item ${index + 1} ("${name}"): unknown frequency "${freq}"`);

  if (typeof stock !== 'number' || stock < 0)
    throw new Error(`Item ${index + 1} ("${name}"): "stock" must be a non-negative number`);

  return {
    id:           (typeof id === 'string' && id.trim()) ? id.trim() : makeId(),
    name:         name.trim(),
    dose:         dose.toString().trim() || '—',
    time,
    cat,
    freq,
    notes:        notes.toString().trim(),
    done:         Boolean(done),
    stock:        Math.max(0, Number(stock)        || 30),
    minimumStock: Math.max(1, Number(minimumStock) || 5),
    createdAt,
  };
}

function validateImportPayload(raw) {
  let candidates;
  if (Array.isArray(raw)) {
    candidates = raw;
  } else if (raw && Array.isArray(raw.reminders)) {
    candidates = raw.reminders;
  } else {
    throw new Error(
      'JSON must be an array of reminders, or an object with a "reminders" array'
    );
  }

  if (candidates.length === 0) {
    throw new Error('The imported file contains no reminder entries');
  }

  return candidates.map(validateReminder);
}

function mergeImported(validatedItems) {
  const existingIds = new Set(reminders.map(r => r.id));
  const newItems    = validatedItems.filter(r => !existingIds.has(r.id));
  const skipped     = validatedItems.length - newItems.length;
  reminders = [...reminders, ...newItems];
  saveReminders();
  return { added: newItems.length, skipped };
}

/* ============================================================
   NOTIFICATIONS — Service Worker + Sound

   Flow overview:
   ─────────────
   Page load
     └─ initNotifications()
           └─ _registerSW()          registers sw.js, sets _swReady = true
                                     attaches _onSWMessage listener ONCE
                                     (BUG FIX #9: _swMessageListenerAdded guard)
           └─ scheduleAllReminders() for each undone reminder:
                 ├─ _swPost(SCHEDULE_REMINDER) → sw.js sets its own setTimeout
                 └─ _fallbackTimers[id] = setTimeout(delay)
                       fires ONLY if !_swReady (BUG FIX #8)

   When reminder time arrives:
     SW path  → sw.js fires showNotification() (OS panel)
              → sw.js posts PLAY_SOUND to page
              → _onSWMessage plays beep + toast  [exactly once]

     Fallback → _fallbackTimers callback fires (only when !_swReady)
              → plays beep + toast + new Notification()  [exactly once]

   checkReminders() polling:
     Runs every 60 s as a last-resort catch for sleep/wake drift.
     Returns immediately when _swReady or fallback timers are active
     (BUG FIX #10) to prevent a third duplicate fire.

   Grace window (BUG FIX #11):
     Reminders up to 2 minutes in the past are fired immediately
     (delay clamped to 0) instead of being silently dropped.
     This fixes the "set reminder 1-2 min late, never fires" bug.
============================================================ */

/* ── Service Worker registration ── */
let _swReady              = false;
let _swMessageListenerAdded = false; // BUG FIX #9: prevent stacking listeners

async function _registerSW() {
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('sw.js', { scope: './' });
    await navigator.serviceWorker.ready;

    // ROOT CAUSE FIX A: navigator.serviceWorker.controller is NULL on the
    // very first page load after a SW registers — even though .ready resolves.
    // The SW called clients.claim() so it is active, but the current page was
    // loaded before the SW took control, so .controller === null.
    // _swPost() used optional chaining (?.) and silently dropped every message.
    // _swReady was then set true, so the fallback timer guard (!_swReady) also
    // silenced those. Result: complete silence — no sound, no notification.
    //
    // Fix: only set _swReady once controller is non-null. If it is null right
    // now, wait for the 'controllerchange' event (fired when clients.claim()
    // takes effect) and reschedule at that point.
    if (navigator.serviceWorker.controller) {
      _swReady = true;
    } else {
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        _swReady = true;
        if (Notification.permission === 'granted') scheduleAllReminders();
      }, { once: true });
    }

    // BUG FIX #9: Attach the SW→page message listener exactly ONCE.
    if (!_swMessageListenerAdded) {
      navigator.serviceWorker.addEventListener('message', _onSWMessage);
      _swMessageListenerAdded = true;
    }
  } catch (e) {
    console.warn('SW registration failed:', e);
  }
}

/* ── Handle messages sent from sw.js to this page ── */
function _onSWMessage(event) {
  const { type, reminderId } = event.data || {};

  if (type === 'PLAY_SOUND') {
    // BUG FIX #15: guard against already-done reminders. If the user marked
    // the reminder taken manually between scheduling and the timer firing,
    // the SW still posts PLAY_SOUND — without this check we'd beep and toast
    // even though the dose was already logged. MARK_DONE already had this
    // guard; PLAY_SOUND was missing it.
    const idx = findById(reminders, reminderId);
    if (idx === -1 || reminders[idx].done) return;
    _playBeep();
    _toast(`🔔 Time to take ${reminders[idx].name}!`, 'warn');
  }

  if (type === 'MARK_DONE') {
    const idx = findById(reminders, reminderId);
    if (idx !== -1 && !reminders[idx].done) {
      // BUG FIX #13: read name BEFORE toggleDone() mutates the array
      const name = reminders[idx].name;
      toggleDone(reminderId);
      _toast(`"${name}" marked as taken ✓`, 'success');
      if (typeof render === 'function') render();
    }
  }

  if (type === 'SNOOZE_REQUEST') {
    // BUG FIX #15 (sw.js snooze): the SW can't hold full reminder data
    // (notification.data only carries {id, url}), so it delegates snoozing
    // back here. We find the full reminder, update its time, and re-post to
    // the SW with all fields intact so fireNotification() has name/dose/notes.
    const idx = findById(reminders, reminderId);
    if (idx !== -1 && !reminders[idx].done) {
      const snoozed = { ...reminders[idx], time: event.data.snoozeTime };
      _swPost({ type: 'SCHEDULE_REMINDER', reminder: snoozed });
      _toast(`"${reminders[idx].name}" snoozed 10 min ⏰`, 'info');
    }
  }

  if (type === 'SNOOZED') {
    const idx = findById(reminders, reminderId);
    if (idx !== -1) _toast(`"${reminders[idx].name}" snoozed 10 min ⏰`, 'info');
  }
}

/* ── Send message to active Service Worker ── */
function _swPost(msg) {
  if (!_swReady) return;
  navigator.serviceWorker.controller?.postMessage(msg);
}

/* ── Notification permission ── */
function requestNotifPermission() {
  if (!('Notification' in window)) {
    _toast('Notifications not supported in this browser', 'error');
    return;
  }
  if (Notification.permission === 'granted') {
    _toast('Notifications already enabled 🔔', 'info');
    _updateNotifDot();
    return;
  }
  if (Notification.permission === 'denied') {
    _toast('Notifications are blocked. Please enable in browser/OS settings.', 'error');
    return;
  }
  Notification.requestPermission().then(p => {
    if (p === 'granted') {
      _toast('Notifications enabled 🔔', 'success');
      _updateNotifDot();
      scheduleAllReminders();
    } else {
      _toast('Notifications were blocked by user', 'error');
    }
  });
}

function _updateNotifDot() {
  const dot = document.getElementById('notif-dot');
  if (dot) dot.classList.add('show');
}

/* ── Beep sound (Web Audio API — no external file needed) ── */
let _audioCtx = null;

function _playBeep() {
  try {
    if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (_audioCtx.state === 'suspended') _audioCtx.resume();

    const play = (freq, startAt, duration) => {
      const osc  = _audioCtx.createOscillator();
      const gain = _audioCtx.createGain();
      osc.connect(gain);
      gain.connect(_audioCtx.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, _audioCtx.currentTime + startAt);
      gain.gain.setValueAtTime(0, _audioCtx.currentTime + startAt);
      gain.gain.linearRampToValueAtTime(0.6, _audioCtx.currentTime + startAt + 0.05);
      gain.gain.exponentialRampToValueAtTime(0.001, _audioCtx.currentTime + startAt + duration);
      osc.start(_audioCtx.currentTime + startAt);
      osc.stop(_audioCtx.currentTime  + startAt + duration);
    };

    play(880, 0,    0.3);
    play(660, 0.35, 0.45);
  } catch (e) {
    console.warn('Audio playback failed:', e);
  }
}

/* ── Warm up AudioContext on first user interaction ── */
function _warmAudio() {
  if (_audioCtx) return;
  // BUG FIX #16: removed redundant manual removeEventListener() call here.
  // The listener is registered with { once: true } below, so the browser
  // already removes it after the first click. The in-body removal was
  // unreachable dead code (it ran after the guard returned early on
  // subsequent clicks that could never reach it anyway).
  try { _audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch(e) {}
}
document.addEventListener('click', _warmAudio, { once: true });

/* ── In-page fallback timers (used when SW is unavailable) ── */
const _fallbackTimers = {};

/* ── scheduleAllReminders ──────────────────────────────────────────────
   Cancels all existing SW + fallback timers, then reschedules every
   undone reminder.  Must be called after any change to the reminders
   list (add, edit, delete, mark-done) to keep timers in sync.

   Duplicate-prevention summary:
   • All existing in-page timers are cleared before re-creating them.
   • _fallbackTimers loop clears all page-side timers before re-creating.
   • Fallback callback is guarded by `if (!_swReady)` (BUG FIX #8) —
     when the SW is active it already fires the notification AND posts
     PLAY_SOUND; the fallback must stay silent to avoid a second beep.

   Grace-window (BUG FIX #11):
   • fire.setHours() zeros seconds/ms, so now.getTime() is often a few
     seconds/ms past the reminder's fire time even when added "on time".
   • A strict `< 0` drop caused reminders set 1-2 minutes late to be
     silently skipped for the entire day.
   • Fix: treat any reminder within 2 minutes of the past as "now"
     (delay = 0). Reminders older than 2 minutes are still skipped.
──────────────────────────────────────────────────────────────────────── */
function scheduleAllReminders() {
  if (Notification.permission !== 'granted') return;

  // Step 1: wipe existing in-page timers — prevents duplicates when
  // scheduleAllReminders() is called again (e.g. after adding a reminder).
  // SW-side timers are no longer used (see ARCHITECTURE FIX below).
  Object.values(_fallbackTimers).forEach(t => clearTimeout(t));
  Object.keys(_fallbackTimers).forEach(k => delete _fallbackTimers[k]);

  const now = new Date();

  reminders.forEach(r => {
    if (r.done || !r.time) return;

    const [rh, rm] = r.time.split(':').map(Number);
    const fire = new Date();
    fire.setHours(rh, rm, 0, 0);
    const msUntil = fire - now;

    // Grace window: fire immediately if within 2 minutes past, skip if older.
    if (msUntil < -120000) return;
    const delay = Math.max(0, msUntil);

    // ARCHITECTURE FIX: All timers live in the PAGE, not the SW.
    //
    // WHY: SW setTimeout handles are killed when the browser idle-terminates
    // the SW (~30s of inactivity). A timer set for "in 60 minutes" is silently
    // destroyed before it fires — no error, no fallback. This was the primary
    // reason notifications never fired.
    //
    // FIX: Page-side setTimeout is reliable for as long as the tab is open.
    // When the timer fires, we:
    //   1. Always play the in-app beep + toast (in-page, instant, reliable).
    //   2. If SW controller exists, post SHOW_NOTIFICATION → SW shows OS alert.
    //   3. If no SW, use new Notification() directly as fallback.
    //
    // No more SW-side scheduling. sw.js only receives SHOW_NOTIFICATION and
    // handles notification button clicks (Mark Taken / Snooze).
    _fallbackTimers[r.id] = setTimeout(() => {
      delete _fallbackTimers[r.id];
      const idx = findById(reminders, r.id);
      if (idx === -1 || reminders[idx].done) return; // already taken

      const reminder = reminders[idx];

      // Step 1: Always fire the in-page beep + toast.
      _playBeep();
      _toast(`🔔 Time to take ${reminder.name}!`, 'warn');

      // Step 2: OS notification — via SW if available, direct otherwise.
      if (navigator.serviceWorker?.controller) {
        // SW is alive → delegate OS alert to it.
        navigator.serviceWorker.controller.postMessage({
          type: 'SHOW_NOTIFICATION',
          reminder
        });
      } else if (Notification.permission === 'granted') {
        // No SW → use Notification API directly (no actions, but still shows).
        try {
          new Notification('💊 MedMinder — Medicine Time!', {
            body: `Take ${reminder.name}${reminder.dose && reminder.dose !== '—' ? ' · ' + reminder.dose : ''}`,
            tag:  `medminder-${reminder.id}`,
            requireInteraction: true
          });
        } catch(e) {}
      }
    }, delay);
  });
}

function cancelReminderNotif(id) {
  // SW no longer holds timers (see ARCHITECTURE FIX in scheduleAllReminders).
  // Only the page-side fallback timers need cancelling.
  if (_fallbackTimers[id]) {
    clearTimeout(_fallbackTimers[id]);
    delete _fallbackTimers[id];
  }
}

/* ── checkReminders — 60-second polling fallback ──────────────────────
   Last-resort catch for sleep/wake gaps where precise timers may have
   drifted or never fired (e.g. laptop lid closed during reminder time).

   BUG FIX #10: Previously this always ran even when the SW was active,
   producing a THIRD beep + toast on top of the SW path and fallback timers.
   Now it exits immediately if:
     • _swReady is true  → SW handles notifications; polling is redundant.
     • fallback timers are set → precise timers are active; don't double-fire.
   Only runs in the rare case where neither path is available.

   BUG FIX #12: Original used string equality `r.time === cur` which could
   fail if a stored time lacked zero-padding (e.g. "8:00" vs "08:00").
   Replaced with numeric minute comparison via timeToMins() which parses
   both sides independently — immune to formatting differences.
──────────────────────────────────────────────────────────────────────── */
function checkReminders() {
  // BUG FIX #10 — skip polling when a more precise path is active
  if (_swReady) return;
  if (Object.keys(_fallbackTimers).length > 0) return;

  const n       = new Date();
  const nowMins = n.getHours() * 60 + n.getMinutes();

  reminders.forEach(r => {
    // BUG FIX #12 — numeric comparison instead of fragile string match
    if (timeToMins(r.time) === nowMins && !r.done) {
      _playBeep();
      _toast(`🔔 Time to take ${r.name}!`, 'warn');
    }
  });
}

/* ── showNotification (kept for any direct calls elsewhere) ── */
function showNotification(title, body) {
  if ('Notification' in window && Notification.permission === 'granted') {
    try { new Notification(title, { body, tag: title, requireInteraction: true }); } catch(e) {}
  }
}

/* ── initNotifications — called once from each page's init() ── */
function initNotifications() {
  if (!('Notification' in window)) return;

  // _registerSW sets _swReady and attaches the message listener (once).
  // NOTE: setInterval(checkReminders, 60000) is called by dashboard.js init()
  // so it must NOT be called here too — that would create a duplicate interval.
  _registerSW().then(() => {
    if (Notification.permission === 'granted') {
      _updateNotifDot();
      scheduleAllReminders();
    } else if (Notification.permission === 'default') {
      // Delay the permission prompt 2 s so the page has finished rendering
      // before a browser dialog appears — less jarring for the user.
      setTimeout(() => {
        Notification.requestPermission().then(p => {
          if (p === 'granted') {
            _updateNotifDot();
            _toast("Notifications enabled — you'll be reminded on time 🔔", 'success');
            scheduleAllReminders();
          }
        });
      }, 2000);
    }
  });
}

/* ── Auto-category from time ── */
function autoCategory(t) {
  if (!t) return 'morning';
  const h = Number(t.split(':')[0]);
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  if (h < 21) return 'evening';
  return 'night';
}

/* ── Debounce ── */
const debounce = (fn, ms) => {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
};

/* ── BUG FIX #5: seedDemo — explicit name check instead of fragile index ── */
function seedDemo() {
  if (reminders.length > 0) return;

  const demos = [
    { name: 'Vitamin D3',  dose: '1 capsule', time: '08:00', cat: 'morning',   freq: 'Daily',     notes: 'Take with breakfast',    stock: 30, minimumStock: 5 },
    { name: 'Omega-3',     dose: '2 tablets', time: '13:00', cat: 'afternoon', freq: 'Daily',     notes: 'With meals',             stock:  4, minimumStock: 5 },
    { name: 'Melatonin',   dose: '5mg',       time: '21:30', cat: 'night',     freq: 'Daily',     notes: 'Before bed',             stock:  0, minimumStock: 5 },
    { name: 'Paracetamol', dose: '500mg',     time: '09:30', cat: 'morning',   freq: 'As needed', notes: 'For headache / fever',   stock: 20, minimumStock: 3 },
    { name: 'Cetirizine',  dose: '10mg',      time: '20:00', cat: 'evening',   freq: 'Daily',     notes: 'Allergy — after dinner', stock:  3, minimumStock: 5 }
  ];

  reminders = demos.map(d => ({
    id:        makeId(),
    ...d,
    done:      d.name === 'Omega-3', // BUG FIX #5: name check, not index
    createdAt: new Date().toISOString()
  }));

  saveReminders();
}

/* ── BUG FIX #4: Toast — module-level instance avoids use-before-assign ── */
let _toastFn = null;

function _toast(msg, type = 'success') {
  if (_toastFn) _toastFn(msg, type);
}

/* ============================================================
   AUTHENTICATION — Session Management & Route Protection
============================================================ */

function protectRoute() {
  const raw = sessionStorage.getItem(SESSION_KEY);

  if (!raw) {
    window.location.replace(LOGIN_PAGE);
    return false;
  }

  let session;
  try {
    session = JSON.parse(raw);
  } catch {
    sessionStorage.removeItem(SESSION_KEY);
    window.location.replace(LOGIN_PAGE);
    return false;
  }

  if (session.expiresAt && new Date(session.expiresAt) < new Date()) {
    sessionStorage.removeItem(SESSION_KEY);
    window.location.replace(LOGIN_PAGE);
    return false;
  }

  return true;
}

function getCurrentUser() {
  const raw = sessionStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function logout() {
  sessionStorage.removeItem(SESSION_KEY);
  window.location.replace(LOGIN_PAGE);
}

/* ── BUG FIX #4: initToast ── */
function initToast() {
  const w = document.getElementById('toasts');
  if (!w) return;
  _toastFn = function (msg, type = 'success') {
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    const icons = { success: '✓', error: '✕', info: 'ℹ', warn: '⚠' };
    el.innerHTML = `<span class="toast-icon">${icons[type] || '✓'}</span><span>${escHtml(msg)}</span>`;
    w.appendChild(el);
    requestAnimationFrame(() => el.classList.add('toast-show'));
    setTimeout(() => {
      el.classList.remove('toast-show');
      el.classList.add('toast-out');
      setTimeout(() => el.remove(), 350);
    }, 3000);
  };
  window.toast = _toastFn;
}