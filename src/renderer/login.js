const api = window.bisonDesktop;
const form = document.getElementById('login-form');
const emailEl = document.getElementById('email');
const passwordEl = document.getElementById('password');
const togglePasswordBtn = document.getElementById('toggle-password');
const submitBtn = document.getElementById('submit');
const errorEl = document.getElementById('error');
const blockedBanner = document.getElementById('blocked-banner');

function showError(message) {
  errorEl.textContent = message || 'Login failed';
  errorEl.style.display = 'block';
}

if (togglePasswordBtn && passwordEl) {
  togglePasswordBtn.addEventListener('click', () => {
    const showing = passwordEl.type === 'text';
    passwordEl.type = showing ? 'password' : 'text';
    const openIcon = togglePasswordBtn.querySelector('.eye-open');
    const closedIcon = togglePasswordBtn.querySelector('.eye-closed');
    openIcon?.classList.toggle('hidden', !showing);
    closedIcon?.classList.toggle('hidden', showing);
    const label = showing ? 'Show password' : 'Hide password';
    togglePasswordBtn.setAttribute('aria-label', label);
    togglePasswordBtn.title = label;
  });
}

(function showBlockedReason() {
  const params = new URLSearchParams(window.location.search);
  const msg = params.get('msg');
  if (!msg) return;
  if (blockedBanner) {
    blockedBanner.textContent = msg;
    blockedBanner.style.display = 'block';
  } else {
    showError(msg);
  }
})();

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorEl.style.display = 'none';
  const email = emailEl.value.trim();
  const password = passwordEl.value;
  if (!email || password.length < 6) {
    showError('Enter a valid email and password (min 6 characters).');
    return;
  }
  submitBtn.disabled = true;
  submitBtn.textContent = 'Signing in…';
  try {
    const result = await api.auth.login(email, password);
    if (!result || !result.success) {
      showError(result?.message || 'Invalid email or password');
      return;
    }
    // Login IPC returns after session bind; main process navigates away.
    submitBtn.textContent = 'Opening…';
  } catch (err) {
    showError(err.message || 'Network error');
  } finally {
    // If still on this page, re-enable (navigation may have already replaced it).
    if (document.getElementById('submit') === submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Sign in';
    }
  }
});

emailEl.focus();
