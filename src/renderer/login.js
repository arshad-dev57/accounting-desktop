const api = window.bisonDesktop;
const form = document.getElementById('login-form');
const emailEl = document.getElementById('email');
const passwordEl = document.getElementById('password');
const submitBtn = document.getElementById('submit');
const errorEl = document.getElementById('error');
const blockedBanner = document.getElementById('blocked-banner');

function showError(message) {
  errorEl.textContent = message || 'Login failed';
  errorEl.style.display = 'block';
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
  } catch (err) {
    showError(err.message || 'Network error');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Sign in';
  }
});

emailEl.focus();
