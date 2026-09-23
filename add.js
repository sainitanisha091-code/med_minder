/* ============================================================
   MedMinder v3 — Add / Edit Page Logic (add.js)
============================================================ */

'use strict';

let editId       = null;
let selectedCat  = 'morning';
let selectedFreq = 'Daily';

/* ── Live preview ── */
function renderPreview() {
  const name  = document.getElementById('in-name').value.trim() || 'Medicine Name';
  const dose  = document.getElementById('in-dose').value.trim() || '—';
  const time  = document.getElementById('in-time').value;
  const notes = document.getElementById('in-notes').value.trim();
  const meta  = CAT_META[selectedCat] || { emoji: '💊', label: selectedCat };

  document.getElementById('preview-box').innerHTML = `
    <div class="med-card cat-${escHtml(selectedCat)}" style="animation:none;pointer-events:none;margin:0">
      <div class="check-box">·</div>
      <div class="med-info">
        <div class="med-name">${escHtml(name)}</div>
        <div class="med-meta">
          <span class="tag tag-time">⏰ ${time ? formatTime(time) : '—'}</span>
          <span class="tag tag-dose">💊 ${escHtml(dose)}</span>
          <span class="tag tag-cat">${meta.emoji} ${escHtml(meta.label)}</span>
          <span class="tag tag-freq">🔁 ${escHtml(selectedFreq)}</span>
        </div>
        ${notes ? `<div class="med-notes">${escHtml(notes)}</div>` : ''}
      </div>
    </div>`;
}

/* ── Smart category suggestion ── */
function onTimeInput() {
  const t   = document.getElementById('in-time').value;
  const sug = autoCategory(t);
  const div = document.getElementById('cat-suggest');
  if (!t) { div.style.display = 'none'; renderPreview(); return; }
  const meta = CAT_META[sug];
  div.style.display = 'block';
  div.innerHTML = `<span class="suggest-badge" onclick="applyAutocat('${sug}')">🤖 Auto-suggest: ${meta.emoji} ${meta.label} — click to apply</span>`;
  renderPreview();
}

function applyAutocat(cat) {
  selectedCat = cat;
  document.querySelectorAll('.cat-opt').forEach(o => o.classList.toggle('selected', o.dataset.cat === cat));
  renderPreview();
  _toast(`Category auto-set to ${CAT_META[cat].label}`, 'info');
}

/* ── Voice input ── */
function startVoice() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) { _toast('Voice input not supported in this browser', 'error'); return; }
  const recognition = new SpeechRecognition();
  recognition.lang = 'en-US';
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;

  const btn    = document.getElementById('voice-btn');
  const status = document.getElementById('voice-status');

  recognition.onstart = () => {
    btn.classList.add('listening');
    status.style.display = 'block';
    _toast('🎤 Listening… speak the medicine name', 'info');
  };
  recognition.onresult = e => {
    const transcript = e.results[0][0].transcript;
    document.getElementById('in-name').value = transcript;
    renderPreview();
    _toast(`Voice captured: "${transcript}"`, 'success');
  };
  recognition.onerror = e => {
    _toast(`Voice error: ${e.error}`, 'error');
  };
  recognition.onend = () => {
    btn.classList.remove('listening');
    status.style.display = 'none';
  };
  recognition.start();
}

/* ── Category & Frequency pickers ── */
document.getElementById('cat-picker').addEventListener('click', e => {
  const opt = e.target.closest('.cat-opt');
  if (!opt) return;
  selectedCat = opt.dataset.cat;
  document.querySelectorAll('.cat-opt').forEach(o => o.classList.remove('selected'));
  opt.classList.add('selected');
  renderPreview();
});

document.getElementById('freq-picker').addEventListener('click', e => {
  const opt = e.target.closest('.freq-opt');
  if (!opt) return;
  selectedFreq = opt.dataset.freq;
  document.querySelectorAll('.freq-opt').forEach(o => o.classList.remove('selected'));
  opt.classList.add('selected');
  renderPreview();
});

['in-name', 'in-dose', 'in-notes'].forEach(id => {
  document.getElementById(id).addEventListener('input', renderPreview);
});

/* ── Submit ── */
function handleSubmit() {
  const name  = document.getElementById('in-name').value;
  const dose  = document.getElementById('in-dose').value;
  const time  = document.getElementById('in-time').value;
  const notes = document.getElementById('in-notes').value;

  if (!name.trim()) { _toast('⚠️ Medicine name is required', 'error'); document.getElementById('in-name').focus(); return; }
  if (!time)        { _toast('⚠️ Please set a reminder time', 'error'); document.getElementById('in-time').focus(); return; }

  const data = { name, dose, time, cat: selectedCat, freq: selectedFreq, notes };

  if (editId) {
    const updated = updateReminder(editId, data);
    if (updated) {
      scheduleAllReminders();
      _toast(`"${updated.name}" updated ✓`, 'success');
      sessionStorage.removeItem('editId');
      setTimeout(() => location.href = 'MedMinder_Dashboard.html', 800);
    }
  } else {
  // ── NEW REMINDER FLOW ──
  // 1. Save the reminder to localStorage via shared.js addReminder()
  const added = addReminder(data);

  // 2. Reschedule all notifications so the new reminder is included.
  //    scheduleAllReminders() cancels any existing SW timers first
  //    (via CANCEL_ALL message) then re-posts each undone reminder —
  //    preventing duplicate schedules from the previous timer set.
  scheduleAllReminders();

  // 3. Show a success toast. The toast auto-dismisses in 3 s (see initToast).
  //    We redirect AFTER the toast has had time to show (~800 ms) so the
  //    user sees confirmation before the page changes.
  _toast(`"${added.name}" added ✓`, 'success');

  // 4. Redirect to Dashboard after a short delay.
  //    setTimeout keeps the toast visible for ~800 ms before navigating.
  //    No clearForm() needed because we're leaving the page entirely.
  setTimeout(() => location.href = 'MedMinder_Dashboard.html', 800);
}
}

function clearForm() {
  ['in-name', 'in-dose', 'in-time', 'in-notes'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('cat-suggest').style.display = 'none';
  selectedCat  = 'morning';
  selectedFreq = 'Daily';
  document.querySelectorAll('.cat-opt').forEach(o  => o.classList.toggle('selected', o.dataset.cat === 'morning'));
  document.querySelectorAll('.freq-opt').forEach(o => o.classList.toggle('selected', o.dataset.freq === 'Daily'));
  if (!editId) renderPreview();
}

function handleDeleteEdit() {
  if (!editId) return;
  const idx = findById(reminders, editId);
  if (idx === -1) return;
  const name = reminders[idx].name;
  if (!confirm(`Delete "${name}"?`)) return;
  deleteReminder(editId);
  _toast(`Deleted "${name}"`, 'error');
  sessionStorage.removeItem('editId');
  setTimeout(() => location.href = 'MedMinder_Dashboard.html', 800);
}

/* ── Enter key to submit ── */
document.querySelectorAll('input').forEach(inp =>
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') handleSubmit(); })
);

/* ── Init ── */
(function init() {
  if (!protectRoute()) return;
  initTheme();
  initToast();
  initUser();
  loadReminders();
  seedDemo();
  initNotifications(); // auto-request permission + schedule precise timers
  document.querySelectorAll('.nav-link').forEach(a =>
    a.classList.toggle('active', a.getAttribute('href').includes('Add'))
  );
  document.getElementById('nav-date').textContent =
    new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

  editId = sessionStorage.getItem('editId');
  if (editId) {
    const idx = findById(reminders, editId);
    if (idx !== -1) {
      const r = reminders[idx];
      document.getElementById('in-name').value  = r.name;
      document.getElementById('in-dose').value  = r.dose !== '—' ? r.dose : '';
      document.getElementById('in-time').value  = r.time;
      document.getElementById('in-notes').value = r.notes;
      selectedCat  = r.cat;
      selectedFreq = r.freq;
      document.querySelectorAll('.cat-opt').forEach(o  => o.classList.toggle('selected', o.dataset.cat === r.cat));
      document.querySelectorAll('.freq-opt').forEach(o => o.classList.toggle('selected', o.dataset.freq === r.freq));
      document.getElementById('page-title').textContent      = 'Edit Reminder';
      document.getElementById('page-sub').textContent        = `Editing: ${r.name}`;
      document.getElementById('edit-banner').classList.add('show');
      document.getElementById('edit-banner-text').textContent = `Editing: "${r.name}" — changes saved on submit.`;
      document.getElementById('submit-label').textContent    = 'Update Reminder';
      document.getElementById('btn-delete').style.display    = 'inline-flex';
    } else {
      sessionStorage.removeItem('editId');
      editId = null;
    }
  }
  renderPreview();
})();
