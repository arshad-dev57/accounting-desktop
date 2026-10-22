/**
 * Desktop alerts via own backend SSE — login, kitchen orders, and inbox items.
 */
const { Notification } = require('electron');
const { connectNotificationStream } = require('./notification-stream.cjs');
const { playOrderBell } = require('./order-bell.cjs');
const posApi = require('./pos-api.cjs');

const RECENT_MS = 120000;

let disconnectStream = null;
let webContents = null;
let mainWindow = null;
let getAuth = null;
let seenIds = new Set();
let seeding = false;
let activeToken = null;
const activeNotifications = [];

function parseData(notification) {
  const raw = notification?.data;
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return raw;
}

function isKitchenOrderNotification(notification) {
  const data = parseData(notification);
  if (data.type !== 'restaurant_order') return false;
  if (data.status && data.status !== 'SENT') return false;
  if (data.app === 'kitchen' || data.screen === 'kitchen') return true;
  const title = String(notification.title || '').toLowerCase();
  return notification.category === 'Restaurant' && title.includes('kitchen');
}

function shouldShowOnDesktop(notification) {
  if (isAuthNotification(notification)) return false;

  const data = parseData(notification);
  if (data.type === 'restaurant_order') {
    if (data.app === 'order_picker' || data.screen === 'orders') return false;
    if (data.status && data.status !== 'SENT') return false;
    return isKitchenOrderNotification(notification);
  }

  return false;
}

function isAuthNotification(notification) {
  return parseData(notification).type === 'auth';
}

function isRecent(notification, maxMs = RECENT_MS) {
  if (!notification?.createdAt) return true;
  const created = new Date(notification.createdAt).getTime();
  if (Number.isNaN(created)) return true;
  return Date.now() - created <= maxMs;
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
  if (!Notification.isSupported()) return;

  const data = parseData(notification);
  const kitchen = isKitchenOrderNotification(notification);
  const native = new Notification({
    title: notification.title || 'Bisonstechs',
    body: notification.message || '',
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
  webContents.send('kitchen:new-order', {
    id: notification.id,
    title: notification.title,
    message: notification.message,
    data: parseData(notification),
  });
}

function deliverNotification(notification, { allowOlder = false, playBell = false } = {}) {
  if (!notification?.id) return;
  if (!shouldShowOnDesktop(notification)) {
    seenIds.add(notification.id);
    return;
  }
  if (seenIds.has(notification.id)) return;
  if (!allowOlder && !isRecent(notification)) {
    seenIds.add(notification.id);
    return;
  }

  seenIds.add(notification.id);
  const kitchen = isKitchenOrderNotification(notification);
  showNativeNotification(notification);
  emitKitchenBadge(notification);
  if (playBell && kitchen) {
    playOrderBell(webContents);
  }
}

async function seedRecentNotifications() {
  if (seeding || !getAuth) return;
  seeding = true;
  try {
    const auth = getAuth();
    if (!auth?.ok || !auth.session?.accessToken) return;
    if (auth.session.accessToken !== activeToken) return;

    const res = await posApi.getNotifications(auth.session.accessToken, {
      unreadOnly: 'true',
      limit: 15,
    });
    if (!res?.success || !Array.isArray(res.data)) return;

    for (const notification of res.data) {
      seenIds.add(notification.id);
    }
  } finally {
    seeding = false;
  }
}

function connectLiveStream() {
  const token = activeToken;
  if (!token) return;

  disconnectStream = connectNotificationStream(token, {
    onEvent: (event) => {
      if (getAuth?.()?.session?.accessToken !== token) return;
      if (event?.event === 'notification' && event.notification) {
        deliverNotification(event.notification, { allowOlder: true, playBell: true });
      }
    },
    onError: () => {},
    onClose: () => {},
  });
}

async function start(wc, authFn, win) {
  stop(true);

  webContents = wc?.webContents || wc;
  mainWindow = win || null;
  getAuth = authFn;

  const auth = getAuth?.();
  activeToken = auth?.ok ? auth.session?.accessToken || null : null;
  if (!activeToken) return;

  await seedRecentNotifications();
  connectLiveStream();
}

function stop(clearRefs = true) {
  if (disconnectStream) {
    disconnectStream();
    disconnectStream = null;
  }
  clearNativeNotifications();
  seenIds.clear();
  activeToken = null;
  seeding = false;

  if (webContents && !webContents.isDestroyed()) {
    webContents.send('desktop:notifications-cleared');
  }

  if (clearRefs) {
    webContents = null;
    mainWindow = null;
    getAuth = null;
  }
}

module.exports = { start, stop };
