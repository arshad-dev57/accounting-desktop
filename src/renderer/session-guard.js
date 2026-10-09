/**
 * Live account gate for POS screens.
 * Polls session-status (deactivate + subscription) and shows a blocking dialog, then logs out.
 */
(function () {
  const api = window.bisonDesktop;
  if (!api?.auth || window.__btSessionGuardBound) return;
  window.__btSessionGuardBound = true;

  let shown = false;

  function titleFor(code) {
    if (code === 'USER_INACTIVE') return 'Account deactivated';
    if (code === 'COMPANY_INACTIVE') return 'Company deactivated';
    if (code === 'SUBSCRIPTION_EXPIRED' || code === 'SUBSCRIPTION_REQUIRED') {
      return 'Subscription ended';
    }
    return 'Access denied';
  }

  function ensureStyles() {
    if (document.getElementById('bt-access-guard-style')) return;
    const style = document.createElement('style');
    style.id = 'bt-access-guard-style';
    style.textContent = `
      #bt-access-guard {
        position: fixed; inset: 0; z-index: 99999;
        background: rgba(15, 23, 42, 0.55);
        display: flex; align-items: center; justify-content: center;
        padding: 24px;
      }
      #bt-access-guard .bt-card {
        width: min(420px, 100%);
        background: #fff;
        border-radius: 16px;
        padding: 24px 22px 18px;
        box-shadow: 0 24px 60px rgba(1, 69, 130, 0.22);
        font-family: Inter, system-ui, sans-serif;
      }
      #bt-access-guard h2 {
        margin: 0 0 8px; font-size: 18px; color: #0f172a;
      }
      #bt-access-guard p {
        margin: 0 0 18px; font-size: 14px; line-height: 1.5; color: #475569;
      }
      #bt-access-guard button {
        width: 100%; height: 42px; border: 0; border-radius: 10px;
        background: #014582; color: #fff; font-weight: 700; font-size: 14px;
        cursor: pointer;
      }
    `;
    document.head.appendChild(style);
  }

  function logoutNow(payload) {
    if (api.auth.logout) api.auth.logout(payload || null);
  }

  function showDialog(payload) {
    if (shown) return;
    shown = true;
    const code = payload?.code || 'SESSION_INVALID';
    const message =
      payload?.message ||
      'Your access has been revoked. Please contact support.';
    ensureStyles();

    const root = document.createElement('div');
    root.id = 'bt-access-guard';
    root.innerHTML =
      '<div class="bt-card" role="alertdialog" aria-modal="true">' +
      '<h2></h2><p></p><button type="button">OK, sign out</button></div>';
    root.querySelector('h2').textContent = titleFor(code);
    root.querySelector('p').textContent = message;
    const btn = root.querySelector('button');
    const go = () => logoutNow({ code, message });
    btn.addEventListener('click', go);
    document.body.appendChild(root);
    setTimeout(go, 4000);
  }

  async function check() {
    if (shown || !api.auth.checkAccess) return;
    try {
      const res = await api.auth.checkAccess();
      if (res && res.ok === false && res.code !== 'OFFLINE' && res.code !== 'NO_SESSION') {
        showDialog(res);
      }
    } catch (_) {
      /* ignore network */
    }
  }

  if (api.auth.onAccessDenied) {
    api.auth.onAccessDenied((payload) => showDialog(payload || {}));
  }
  if (api.auth.onExpired) {
    api.auth.onExpired(() =>
      showDialog({
        code: 'SESSION_INVALID',
        message: 'Your session expired. Please sign in again.',
      })
    );
  }
  if (api.auth.onCompanyInactive) {
    api.auth.onCompanyInactive(() =>
      showDialog({
        code: 'COMPANY_INACTIVE',
        message: 'Your company account has been deactivated. Please contact support.',
      })
    );
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', check);
  } else {
    check();
  }
  setInterval(check, 15_000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check();
  });
})();
