
const config = require('./config.cjs');

async function postJson(pathname, body, timeoutMs = 45000) {
  const base = config.resolveApiUrl();
  const url = `${base}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => controller.abort(), Math.max(5000, Number(timeoutMs) || 45000))
    : null;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller ? controller.signal : undefined,
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
    const aborted = err && (err.name === 'AbortError' || /aborted/i.test(String(err.message || '')));
    return {
      success: false,
      message: aborted
        ? 'Server took too long to respond. Check your internet / API URL.'
        : (err.message || 'Cannot reach the API. Check ELECTRON_API_URL.'),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function login(email, password) {
  // Desktop POS: password-only login (no OTP). Mobile keeps OTP by default.
  return postJson('/api/users/login', {
    email,
    password,
    directLogin: true,
    client: 'desktop',
  });
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

async function authGet(accessToken, pathname, companyId) {
  const base = config.resolveApiUrl();
  const url = `${base}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
  try {
    const headers = {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
    };
    if (companyId) headers['X-Company-Id'] = String(companyId);
    const res = await fetch(url, { method: 'GET', headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) {
      return { success: false, status: res.status, message: data.message || `Request failed (${res.status})`, data: null };
    }
    return { success: true, data };
  } catch (err) {
    return { success: false, message: err.message || 'Cannot reach the API', data: null };
  }
}

async function getMe(accessToken, companyId) {
  const result = await authGet(accessToken, '/api/users/me', companyId);
  if (!result.success) return null;
  const data = result.data;
  return cloneJson(data.user || data.data || null);
}

async function listMyCompanies(accessToken) {
  const result = await authGet(accessToken, '/api/companies/mine');
  if (!result.success) {
    return { success: false, message: result.message || 'Failed to load companies', companies: [] };
  }
  const payload = result.data?.data || result.data || {};
  const companies = Array.isArray(payload.companies) ? payload.companies : [];
  const preferred = String(payload.preferredCompanyId || '').trim();
  const active = String(payload.activeCompanyId || '').trim();
  return {
    success: true,
    companies,
    // Prefer DB-persisted primary (ERP switch) over request-scoped active
    activeCompanyId: preferred || active,
    preferredCompanyId: preferred || active,
  };
}

async function setPrimaryCompany(accessToken, companyId) {
  const base = config.resolveApiUrl();
  const url = `${base}/api/companies/active`;
  try {
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'X-Company-Id': String(companyId || ''),
      },
      body: JSON.stringify({ companyId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) {
      return { success: false, message: data.message || `Request failed (${res.status})` };
    }
    return { success: true, data: data.data };
  } catch (err) {
    return { success: false, message: err.message || 'Cannot reach the API' };
  }
}

module.exports = {
  login,
  getMe,
  listMyCompanies,
  setPrimaryCompany,
  pickAuth,
  cloneJson,
};
