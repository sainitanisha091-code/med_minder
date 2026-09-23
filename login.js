'use strict';

/* ─────────────────────────────────────────────────────────────
   Constants
───────────────────────────────────────────────────────────── */
const SESSION_KEY  = 'medminder_session';
const REMEMBER_KEY = 'medminder_remember';
const THEME_KEY    = 'medminder_theme';
const USERS_KEY    = 'medminder_users';
const REDIRECT_URL = 'MedMinder_Dashboard.html';

/* ─────────────────────────────────────────────────────────────
   Demo user (personal only)
───────────────────────────────────────────────────────────── */
const DEMO_USERS = Object.freeze([
  {
    email:    'user@medminder.app',
    password: 'User@1234',
    type:     'personal',
    name:     'Demo User',
    avatar:   'U',
    role:     'Personal User',
  },
]);

/* ─────────────────────────────────────────────────────────────
   User Registry — localStorage-backed personal accounts
───────────────────────────────────────────────────────────── */
const UserRegistry = (() => {
  function _load() {
    try { return JSON.parse(localStorage.getItem(USERS_KEY)) || []; }
    catch { return []; }
  }
  function _save(users) { localStorage.setItem(USERS_KEY, JSON.stringify(users)); }

  return {
    findByEmail(email) {
      return _load().find(u => u.email === email.toLowerCase());
    },

    register({ name, email, password }) {
      const users = _load();
      if (users.find(u => u.email === email.toLowerCase())) {
        return 'An account with this email already exists.';
      }
      users.push({
        email:    email.toLowerCase(),
        password,
        name,
        type:     'personal',
        avatar:   name.charAt(0).toUpperCase(),
        role:     'Personal User',
      });
      _save(users);
      return null; // success
    },

    authenticate(email, password) {
      const user = this.findByEmail(email);
      if (!user || user.password !== password) return null;
      return user;
    },
  };
})();

/* ─────────────────────────────────────────────────────────────
   Session Manager
───────────────────────────────────────────────────────────── */
const SessionManager = (() => {
  let _current = null;

  const _build = ({ email, name, type, avatar, role }) => ({
    email, name, type, avatar, role,
    loggedInAt: new Date().toISOString(),
    expiresAt:  new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  });

  return {
    save(user)   { _current = _build(user); sessionStorage.setItem(SESSION_KEY, JSON.stringify(_current)); return _current; },
    get()        { if (_current) return _current; try { _current = JSON.parse(sessionStorage.getItem(SESSION_KEY)); return _current; } catch { return null; } },
    isActive()   { const s = this.get(); return !!(s && new Date(s.expiresAt) > new Date()); },
    clear()      { _current = null; sessionStorage.removeItem(SESSION_KEY); },
  };
})();

/* ─────────────────────────────────────────────────────────────
   Validation helpers
───────────────────────────────────────────────────────────── */
function validateEmail(email) {
  return new Promise((resolve, reject) => {
    const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!email.trim())           reject('Email is required');
    else if (!regex.test(email)) reject('Enter a valid email address');
    else                         resolve(email.trim().toLowerCase());
  });
}

function validatePassword(password) {
  return new Promise((resolve, reject) => {
    if (!password)              { reject('Password is required'); return; }
    if (password.length < 6)   { reject('Password must be at least 6 characters'); return; }
    resolve(password);
  });
}

function getPasswordStrength(password) {
  const rules = [
    { test: pw => pw.length >= 8           },
    { test: pw => /[A-Z]/.test(pw)         },
    { test: pw => /[0-9]/.test(pw)         },
    { test: pw => /[^A-Za-z0-9]/.test(pw) },
  ];
  const score = rules.reduce((t, { test }) => t + (test(password) ? 1 : 0), 0);
  const levels = [
    { label: 'Very Weak',  color: '#ef4444', width: '15%'  },
    { label: 'Weak',       color: '#f97316', width: '35%'  },
    { label: 'Fair',       color: '#f59e0b', width: '55%'  },
    { label: 'Strong',     color: '#10b981', width: '80%'  },
    { label: 'Very Strong',color: '#059669', width: '100%' },
  ];
  return { score, ...levels[score] };
}

/* ─────────────────────────────────────────────────────────────
   UI helpers
───────────────────────────────────────────────────────────── */
function setFieldError(fieldGroupEl, message = '') {
  const errEl = fieldGroupEl.querySelector('.field-error');
  if (message) { fieldGroupEl.classList.add('has-error'); if (errEl) errEl.textContent = '⚠ ' + message; }
  else         { fieldGroupEl.classList.remove('has-error'); if (errEl) errEl.textContent = ''; }
}

function clearErrors(prefix) {
  document.querySelectorAll(`#${prefix} .field-group.has-error`).forEach(el => setFieldError(el));
}

function showAlert(message, type = 'error') {
  const al   = document.getElementById('login-alert');
  const icon = al.querySelector('.alert-icon');
  const text = al.querySelector('.alert-text');
  al.className = `login-alert ${type} show`;
  al.style.cssText = '';
  icon.textContent = type === 'error' ? '🚨' : '✅';
  text.textContent = message;
  if (type === 'success') setTimeout(() => al.classList.remove('show'), 2500);
}

function hideAlert() {
  const al = document.getElementById('login-alert');
  al.classList.remove('show');
  al.style.cssText = '';
}

/* ─────────────────────────────────────────────────────────────
   Auth — login
───────────────────────────────────────────────────────────── */
async function authenticate(email, password) {
  await new Promise(r => setTimeout(r, 500 + Math.random() * 400));

  // Check demo accounts
  const demo = DEMO_USERS.find(u => u.email === email.toLowerCase() && u.password === password);
  if (demo) return demo;

  // Check registered accounts
  const reg = UserRegistry.authenticate(email, password);
  if (reg) return reg;

  // Better error messages
  const emailKnown = !!DEMO_USERS.find(u => u.email === email.toLowerCase()) || !!UserRegistry.findByEmail(email);
  if (emailKnown) throw new Error('Incorrect password. Please try again.');
  throw new Error('No account found with that email. Click "Back" and choose "I\'m new here" to register.');
}

/* ─────────────────────────────────────────────────────────────
   Login form handler
───────────────────────────────────────────────────────────── */
async function handleLogin(event) {
  event.preventDefault();
  clearErrors('panel-login');
  hideAlert();

  const emailInput = document.getElementById('email');
  const pwdInput   = document.getElementById('password');
  const rememberEl = document.getElementById('remember');

  const [emailRes, pwdRes] = await Promise.allSettled([
    validateEmail(emailInput.value),
    validatePassword(pwdInput.value),
  ]);

  let emailVal = null, passwordVal = null;
  if (emailRes.status === 'rejected') setFieldError(emailInput.closest('.field-group'), emailRes.reason);
  else emailVal = emailRes.value;

  if (pwdRes.status === 'rejected') setFieldError(pwdInput.closest('.field-group'), pwdRes.reason);
  else passwordVal = pwdRes.value;

  if (!emailVal || !passwordVal) return;

  const btn = document.getElementById('btn-login');
  btn.disabled = true; btn.classList.add('loading');
  btn.querySelector('.btn-text').textContent = 'Signing in…';

  try {
    const user = await authenticate(emailVal, passwordVal);
    rememberEl?.checked ? localStorage.setItem(REMEMBER_KEY, emailVal) : localStorage.removeItem(REMEMBER_KEY);
    const session = SessionManager.save(user);
    showAlert(`Welcome back, ${session.name}! Redirecting…`, 'success');
    await new Promise(r => setTimeout(r, 900));
    window.location.href = REDIRECT_URL;
  } catch (err) {
    showAlert(err.message);
    pwdInput.value = '';
    pwdInput.focus();
  } finally {
    btn.disabled = false; btn.classList.remove('loading');
    btn.querySelector('.btn-text').textContent = 'Sign In';
  }
}

/* ─────────────────────────────────────────────────────────────
   Register form handler
───────────────────────────────────────────────────────────── */
async function handleRegisterSubmit(event) {
  event.preventDefault();
  clearErrors('panel-register');
  hideAlert();

  const name     = document.getElementById('rg-name').value.trim();
  const email    = document.getElementById('rg-email').value.trim();
  const password = document.getElementById('rg-password').value;
  const confirm  = document.getElementById('rg-confirm').value;

  let hasError = false;

  if (!name) {
    setFieldError(document.getElementById('rg-fg-name'), 'Full name is required');
    hasError = true;
  }

  let emailVal = null;
  try   { emailVal = await validateEmail(email); }
  catch (e) { setFieldError(document.getElementById('rg-fg-email'), e); hasError = true; }

  let pwdOk = false;
  try   { await validatePassword(password); pwdOk = true; }
  catch (e) { setFieldError(document.getElementById('rg-fg-password'), e); hasError = true; }

  if (pwdOk && password !== confirm) {
    setFieldError(document.getElementById('rg-fg-confirm'), 'Passwords do not match');
    hasError = true;
  }

  if (hasError) return;

  const btn = document.getElementById('btn-register');
  btn.disabled = true; btn.classList.add('loading');
  btn.querySelector('.btn-text').textContent = 'Creating account…';

  await new Promise(r => setTimeout(r, 600)); // simulate network

  const regError = UserRegistry.register({ name, email: emailVal, password });
  if (regError) {
    showAlert(regError);
    btn.disabled = false; btn.classList.remove('loading');
    btn.querySelector('.btn-text').textContent = 'Create Account';
    return;
  }

  // Success — switch to login panel with fields pre-filled
  showAlert(`Account created! Welcome, ${name}. Please sign in below.`, 'success');
  btn.disabled = false; btn.classList.remove('loading');
  btn.querySelector('.btn-text').textContent = 'Create Account';

  setTimeout(() => {
    document.getElementById('email').value    = emailVal;
    document.getElementById('password').value = '';
    // Switch to login panel
    document.querySelectorAll('.panel').forEach(p => { p.classList.add('hidden'); p.classList.remove('panel-enter'); });
    const lp = document.getElementById('panel-login');
    lp.classList.remove('hidden');
    requestAnimationFrame(() => lp.classList.add('panel-enter'));
    document.getElementById('password').focus();
  }, 1200);
}

/* ─────────────────────────────────────────────────────────────
   Password strength (exposed globally for inline script)
───────────────────────────────────────────────────────────── */
window.getPasswordStrength = getPasswordStrength;

/* ─────────────────────────────────────────────────────────────
   Demo credentials panel
───────────────────────────────────────────────────────────── */
function makeAutoFill(user) {
  return function () {
    document.getElementById('email').value    = user.email;
    document.getElementById('password').value = user.password;
    // Switch to login panel
    document.querySelectorAll('.panel').forEach(p => { p.classList.add('hidden'); p.classList.remove('panel-enter'); });
    const lp = document.getElementById('panel-login');
    lp.classList.remove('hidden');
    requestAnimationFrame(() => lp.classList.add('panel-enter'));
    hideAlert();
  };
}

window.makeAutoFill = makeAutoFill;
window.hideAlert    = hideAlert;

function renderDemoPanel() {
  const container = document.getElementById('demo-credentials');
  if (!container) return;
  container.innerHTML = DEMO_USERS.map(user => `
    <div class="demo-cred">
      <span class="demo-key">${user.role}</span>
      <span class="demo-val" data-autofill="${user.type}" title="Click to auto-fill">${user.email}</span>
    </div>
  `).join('');
  container.addEventListener('click', event => {
    const target = event.target.closest('.demo-val');
    if (!target) return;
    const user = DEMO_USERS.find(u => u.type === target.dataset.autofill);
    if (user) makeAutoFill(user)();
  });
}

/* ─────────────────────────────────────────────────────────────
   Theme
───────────────────────────────────────────────────────────── */
function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const isDark = saved ? saved === 'dark' : prefersDark;
  if (isDark) document.body.classList.add('dark');
  const btn = document.getElementById('theme-toggle');
  if (btn) btn.textContent = isDark ? '☀️' : '🌙';
}

function toggleTheme() {
  const isDark = document.body.classList.toggle('dark');
  localStorage.setItem(THEME_KEY, isDark ? 'dark' : 'light');
  const btn = document.getElementById('theme-toggle');
  if (btn) btn.textContent = isDark ? '☀️' : '🌙';
}

/* ─────────────────────────────────────────────────────────────
   Init
───────────────────────────────────────────────────────────── */
(function init() {
  if (SessionManager.isActive()) { window.location.href = REDIRECT_URL; return; }

  initTheme();
  renderDemoPanel();

  // Restore remembered email
  const remembered = localStorage.getItem(REMEMBER_KEY);
  if (remembered) {
    const emailInput = document.getElementById('email');
    const rememberEl = document.getElementById('remember');
    if (emailInput) emailInput.value = remembered;
    if (rememberEl) rememberEl.checked = true;
  }

  // Login form
  const form = document.getElementById('login-form');
  if (form) form.addEventListener('submit', handleLogin);

  // Login password toggle
  const pwdToggle = document.getElementById('pwd-toggle');
  const pwdInput  = document.getElementById('password');
  if (pwdToggle && pwdInput) {
    pwdToggle.addEventListener('click', () => {
      const isText = pwdInput.type === 'text';
      pwdInput.type = isText ? 'password' : 'text';
      pwdToggle.textContent = isText ? '👁️' : '🙈';
    });
  }

  // Theme button
  const themeBtn = document.getElementById('theme-toggle');
  if (themeBtn) themeBtn.addEventListener('click', toggleTheme);

  // Clear errors on input
  document.querySelectorAll('.field-input').forEach(input => {
    input.addEventListener('input', () => {
      const group = input.closest('.field-group');
      if (group) setFieldError(group);
      hideAlert();
    });
  });
})();

/* ─────────────────────────────────────────────────────────────
   Public auth API (for dashboard logout etc.)
───────────────────────────────────────────────────────────── */
window.MedMinderAuth = {
  logout()     { SessionManager.clear(); window.location.href = 'login.html'; },
  getSession() { return SessionManager.get(); },
  isLoggedIn() { return SessionManager.isActive(); },
};