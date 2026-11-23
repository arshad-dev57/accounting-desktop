/**
 * Desktop alerts via OneSignal (not SSE).
 * Renderer registers OneSignal with external_id `ENV:userId` (same as Flutter/backend).
 * When a push arrives, renderer IPC → this module shows Electron Notification + kitchen bell.
 */
const { Notification } = require('electron');
const { playOrderBell } = require('./order-bell.cjs');

let webContents = null;
let mainWindow = null;
let getAuth = null;
let seenIds = new Set();
const activeNotifications = [];

function parseData(notification) {
  const raw = notification?.data ?? notification;
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return typeof raw === 'object' ? raw : {};
}

function isKitchenOrderNotification(notification) {
  const data = parseData(notification?.data || notification);
  if (data.type !== 'restaurant_order') return false;
  if (data.status && data.status !== 'SENT') return false;
  if (data.app === 'kitchen' || data.screen === 'kitchen') return true;
  const title = String(notification.title || notification.headings?.en || '').toLowerCase();
  return notification.category === 'Restaurant' || title.includes('kitchen');
}

function shouldShowOnDesktop(notification) {
  const data = parseData(notification?.data || notification);
  if (data.type === 'auth') return false;
  if (data.type === 'restaurant_order' || notification.category === 'Restaurant') return true;
  // OneSignal payload often only has data + title/body
  if (notification.title || notification.body || notification.message) return true;
  return false;
}

function clearNativeNotifications() {
  for (const native of activeNotifications) {
    try {
      native.close();
    } catch {
      /* ignore */
    }
  }
  activeNotifications.length = 0;
}

function showNativeNotification(notification) {
  if (!Notification.isSupported()) {
    console.warn('[desktop-notifications] Electron Notification not supported');
    return;
  }

  const data = parseData(notification?.data || notification);
  const kitchen = isKitchenOrderNotification(notification);
  const title =
    notification.title ||
    notification.headings?.en ||
    data.title ||
    'Bisonstechs';
  const body =
    notification.message ||
    notification.body ||
    notification.contents?.en ||
    data.message ||
    '';

  const native = new Notification({
    title,
    body,
    silent: kitchen,
  });

  activeNotifications.push(native);
  native.on('close', () => {
    const idx = activeNotifications.indexOf(native);
    if (idx >= 0) activeNotifications.splice(idx, 1);
  });

  native.on('click', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
    if (webContents && !webContents.isDestroyed()) {
      webContents.send('desktop:notification-click', {
        orderId: data.orderId || null,
        type: data.type || null,
        screen: data.screen || null,
      });
      if (kitchen) {
        webContents.send('kitchen:notification-click', { orderId: data.orderId || null });
      }
    }
  });

  native.show();
}

function emitKitchenBadge(notification) {
  if (!webContents || webContents.isDestroyed()) return;
  if (!isKitchenOrderNotification(notification)) return;
  const data = parseData(notification?.data || notification);
  webContents.send('kitchen:new-order', {
    id: notification.id || data.notificationId || null,
    title: notification.title || notification.headings?.en,
    message: notification.message || notification.body || notification.contents?.en,
    data,
  });
}

/**
 * Called when OneSignal delivers a push to the desktop renderer.
 */
function handleOneSignalPush(payload = {}) {
  const notification = {
    id:
      payload.notificationId ||
      payload.id ||
      payload.data?.notificationId ||
      `os-${Date.now()}`,
    title: payload.title || payload.headings?.en,
    message: payload.message || payload.body || payload.contents?.en,
    category: payload.category || payload.data?.category || 'Restaurant',
    data: payload.data || payload,
  };

  if (!shouldShowOnDesktop(notification)) {
    seenIds.add(notification.id);
    return { shown: false, reason: 'filtered' };
  }
  if (seenIds.has(notification.id)) {
    return { shown: false, reason: 'duplicate' };
  }
  seenIds.add(notification.id);

  const kitchen = isKitchenOrderNotification(notification);
  showNativeNotification(notification);
  emitKitchenBadge(notification);
  if (kitchen) playOrderBell(webContents);

  return { shown: true, kitchen };
}

function start(wc, authFn, win) {
  stop(true);
  webContents = wc?.webContents || wc;
  mainWindow = win || null;
  getAuth = authFn;
  console.log('[desktop-notifications] OneSignal delivery mode (no SSE)');
}

function stop(clearRefs = true) {
  clearNativeNotifications();
  seenIds.clear();

  if (webContents && !webContents.isDestroyed()) {
    webContents.send('desktop:notifications-cleared');
  }

  if (clearRefs) {
    webContents = null;
    mainWindow = null;
    getAuth = null;
  }
}

function getStatus() {
  const auth = getAuth?.();
  return {
    mode: 'onesignal',
    loggedIn: Boolean(auth?.ok && auth.session?.accessToken),
    userId: auth?.session?.user?.id || null,
  };
}

module.exports = {
  start,
  stop,
  handleOneSignalPush,
  getStatus,
};
