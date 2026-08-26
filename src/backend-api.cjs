/**
 * Calls the same Express auth APIs as the web app.
 * Runs in the main process so the renderer never talks to the backend directly.
 */
const config = require('./config.cjs');

async function postJson(pathname, body) {
  const base = config.resolveApiUrl();
  const url = `${base}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) {
      return {
        success: false,
        status: res.status,
        message: data.message || `Request failed (${res.status})`,
      };
    }
    return { success: true, status: res.status, data };
  } catch (err) {
    return {
      success: false,
      message: err.message || 'Cannot reach the API. Check ELECTRON_API_URL.',
    };
  }
}

function login(email, password) {
  return postJson('/api/users/login', { email, password });
}

function verifyLoginOtp(email, otp) {
  return postJson('/api/users/verify-login-otp', { email, otp });
}

function cloneJson(value) {
  if (value == null) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

function pickAuth(body) {
  const root = body && typeof body === 'object' ? body : {};
  const nested = root.data && typeof root.data === 'object' ? root.data : {};
  return {
    token: String(root.token || root.accessToken || nested.token || nested.accessToken || '').trim(),
    refreshToken: String(root.refreshToken || nested.refreshToken || '').trim(),
    user: cloneJson(root.user || nested.user || null),
  };
}

async function getMe(accessToken) {
  const base = config.resolveApiUrl();
  const url = `${base}/api/users/me`;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) return null;
    return cloneJson(data.user || data.data || null);
  } catch (err) {
    console.warn('[desktop] getMe failed', err.message);
    return null;
  }
}

module.exports = { login, verifyLoginOtp, getMe, pickAuth, cloneJson };
