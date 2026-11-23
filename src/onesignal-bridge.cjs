/**
 * Hidden BrowserWindow that loads OneSignal Web SDK and maps pushes → main process.
 * Uses the Next.js origin (http://127.0.0.1:3000) so service worker can register.
 */
const path = require('path');
const { BrowserWindow, session } = require('electron');
const config = require('./config.cjs');

let bridgeWin = null;
let currentExternalId = null;

function resolveOnesignalConfig() {
  const appId = String(process.env.ONESIGNAL_APP_ID || '').trim();
  const env = String(process.env.ONESIGNAL_ENV || process.env.NOTIFICATION_ENV || 'dev').trim() || 'dev';
  return { appId, env };
}

function buildExternalId(userId) {
  const { env } = resolveOnesignalConfig();
  return `${env}:${String(userId || '').trim()}`;
}

function bridgeUrl(appId, externalId) {
  const origin = config.originOf(config.resolveAppUrl(false));
  const url = new URL('/onesignal-desktop-bridge.html', `${origin}/`);
  url.searchParams.set('appId', appId);
  url.searchParams.set('externalId', externalId);
  return url.toString();
}

function stop() {
  currentExternalId = null;
  if (bridgeWin && !bridgeWin.isDestroyed()) {
    try {
      bridgeWin.close();
    } catch {
      /* ignore */
    }
  }
  bridgeWin = null;
}

/**
 * Start (or restart) the OneSignal bridge for the logged-in user.
 * @param {{ userId: string, preloadPath: string, parent?: Electron.BrowserWindow }} opts
 */
async function start({ userId, preloadPath, parent } = {}) {
  const { appId } = resolveOnesignalConfig();
  if (!appId) {
    console.warn(
      '[onesignal-bridge] ONESIGNAL_APP_ID missing — desktop will not receive OneSignal push'
    );
    stop();
    return { ok: false, reason: 'missing_app_id' };
  }
  if (!userId) {
    console.warn('[onesignal-bridge] no userId — skip');
    stop();
    return { ok: false, reason: 'missing_user' };
  }

  const externalId = buildExternalId(userId);
  if (bridgeWin && !bridgeWin.isDestroyed() && currentExternalId === externalId) {
    return { ok: true, externalId, reused: true };
  }

  stop();
  currentExternalId = externalId;

  const ses = session.fromPartition('persist:onesignal-bridge');
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    if (permission === 'notifications') {
      callback(true);
      return;
    }
    callback(false);
  });

  bridgeWin = new BrowserWindow({
    width: 420,
    height: 320,
    show: false,
    parent: parent || undefined,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      session: ses,
      backgroundThrottling: false,
    },
  });

  bridgeWin.on('closed', () => {
    bridgeWin = null;
  });

  const url = bridgeUrl(appId, externalId);
  console.log('[onesignal-bridge] loading', url.replace(appId, '***'));
  try {
    await bridgeWin.loadURL(url);
  } catch (err) {
    console.error('[onesignal-bridge] load failed:', err?.message || err);
    stop();
    return { ok: false, reason: 'load_failed', error: err?.message };
  }

  return { ok: true, externalId, appIdPresent: true };
}

function getStatus() {
  const { appId, env } = resolveOnesignalConfig();
  return {
    mode: 'onesignal',
    appIdConfigured: Boolean(appId),
    env,
    externalId: currentExternalId,
    bridgeOpen: Boolean(bridgeWin && !bridgeWin.isDestroyed()),
  };
}

module.exports = {
  start,
  stop,
  getStatus,
  buildExternalId,
  resolveOnesignalConfig,
};
