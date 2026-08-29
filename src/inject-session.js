/**
 * Injected into the Next.js POS after login.
 * Skipped on native file:// login/OTP screens.
 */
(function () {
  if (window.location.protocol === 'file:') return;
  const api = window.bisonDesktop;
  if (!api || window.__bisonDesktopSessionBound) return;
  window.__bisonDesktopSessionBound = true;

  function pathOf() {
    return window.location.pathname || '/';
  }

  function isPosPath(p) {
    return p === '/pos' || p.indexOf('/pos/') === 0;
  }

  function applySession(session) {
    if (!session || !session.accessToken) return;
    localStorage.setItem('auth_token', session.accessToken);
    if (session.refreshToken) localStorage.setItem('refresh_token', session.refreshToken);
    if (session.user) {
      localStorage.setItem(
        'user',
        typeof session.user === 'string' ? session.user : JSON.stringify(session.user)
      );
    }
    localStorage.setItem('has_subscription_access', '1');
  }

  function enforceRoute() {
    const p = pathOf();
    if (p.indexOf('/_next') === 0 || p.indexOf('/api') === 0) return;
    if (p === '/login' || p.indexOf('/login') === 0) {
      api.auth.openLogin();
      return;
    }
    const token = localStorage.getItem('auth_token');
    if (!token) {
      api.auth.openLogin();
      return;
    }
    if (!isPosPath(p)) {
      window.location.replace('/pos');
    }
  }

  api.auth.onExpired(function () {
    try {
      localStorage.removeItem('auth_token');
      localStorage.removeItem('refresh_token');
      localStorage.removeItem('user');
    } catch (_) {}
    api.auth.openLogin();
  });

  api.auth.onCompanyInactive(function () {
    try {
      localStorage.removeItem('auth_token');
      localStorage.removeItem('refresh_token');
      localStorage.removeItem('user');
    } catch (_) {}
    api.auth.openLogin();
  });

  api.auth.getSession().then(function (session) {
    applySession(session);
    enforceRoute();
  });

  function persist() {
    const accessToken = localStorage.getItem('auth_token');
    const refreshToken = localStorage.getItem('refresh_token') || '';
    const userRaw = localStorage.getItem('user');
    if (!accessToken) return;
    let user = null;
    try {
      user = userRaw ? JSON.parse(userRaw) : null;
    } catch (_) {
      user = null;
    }
    api.auth.saveSession({ accessToken: accessToken, refreshToken: refreshToken, user: user });
  }

  window.addEventListener('storage', persist);
  setInterval(persist, 2000);
})();
