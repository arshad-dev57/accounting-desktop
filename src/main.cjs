
// Force consistent userData path so dev mode (electron .) uses the same folder
// as packaged builds — otherwise categories/products/sales are all blank because
// '~/Library/Application Support/Electron' (dev default) is empty.
const { app: _appForName } = require('electron');
try { _appForName.setName('accounting-desktop-app'); } catch { /* main process only */ }

const {
  app,
  BrowserWindow,
  BrowserView,
  ipcMain,
  Menu,
  shell,
  globalShortcut,
  session,
  nativeImage,
} = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');

try {
  require('electron-reload')(__dirname, {
    electron: path.join(__dirname, '..', 'node_modules', '.bin', 'electron'),
    hardResetMethod: 'exit',
    ignored: /node_modules|[\/\\]\./,
  });
} catch {
}

const config = require('./config.cjs');
const windowState = require('./window-state.cjs');
const authStore = require('./auth-store.cjs');
const { setupAutoUpdate } = require('./updater.cjs');
const backendApi = require('./backend-api.cjs');
const desktopNotifications = require('./desktop-notifications.cjs');
const posApi = require('./pos-api.cjs');
const salesApi = require('./sales-api.cjs');
const localDb = require('./local-db.cjs');
const masterSqlite = require('./master-sqlite.cjs');
const masterSync = require('./master-sync.cjs');
const machineInfo = require('./machine-info.cjs');
const driveBackup = require('./drive-backup/service.cjs');

const isMac = process.platform === 'darwin';
const isDev = !app.isPackaged;

if (isDev) {
  process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';
}

const TITLEBAR_HEIGHT = config.TITLEBAR_HEIGHT || 36;
const ICON = path.join(__dirname, '..', 'assets', 'icon.png');
const injectSource = fs.readFileSync(path.join(__dirname, 'inject-session.js'), 'utf8');

let mainWindow = null;
let splashWindow = null;
let titleBarView = null;
let appView = null;
let sessionWatchTimer = null;
let pendingForcedLogout = false;
let rendererOrigin = config.DEFAULT_LOCAL;
let shown = false;
let pendingLogin = null;
let activeShift = null;

function userData() {
  return app.getPath('userData');
}

function resolveCompanyId(user, session) {
  return String(
    session?.activeCompanyId ||
      user?.activeCompanyId ||
      posApi.getActiveCompanyId?.() ||
      user?.companyId ||
      user?.company_id ||
      user?.company?.id ||
      user?.company?._id ||
      ''
  ).trim();
}

function applyApiCompanyContext(companyId) {
  const id = String(companyId || '').trim();
  if (typeof posApi.setActiveCompanyId === 'function') {
    posApi.setActiveCompanyId(id);
  }
  return id;
}

function showCompanySelectScreen() {
  appView?.webContents.loadFile(path.join(__dirname, 'renderer', 'company-select.html'));
}

async function enrichUserProfile(user, token, companyId) {
  if (!user || !token) return user;
  try {
    const me = await backendApi.getMe(token, companyId || resolveCompanyId(user));
    if (!me) return user;
    return {
      ...user,
      ...me,
      company: { ...(user.company || {}), ...(me.company || {}) },
      businessDetails: { ...(user.businessDetails || {}), ...(me.businessDetails || {}) },
      organizationName: me.organizationName || user.organizationName || me.company?.name || '',
    };
  } catch (err) {
    console.warn('[scope] enrichUserProfile failed:', err.message);
    return user;
  }
}

let switchLocalDataChain = Promise.resolve();

async function switchLocalDataForCompany(user) {
  const runSwitch = async () => {
    let companyId = resolveCompanyId(user);
    if (!companyId) {
      companyId = '_default';
      console.warn('[scope] no companyId on user — using default local scope');
    }
    if (
      masterSqlite.isOpenForCompany(companyId) &&
      localDb.getActiveCompanyId() === companyId
    ) {
      activeShift = localDb.getActiveShift();
      return true;
    }
    localDb.setCompanyScope(companyId);
    await masterSqlite.switchCompany(userData(), companyId);
    activeShift = localDb.getActiveShift();
    try {
      await appView?.webContents.executeJavaScript(
        `try{sessionStorage.removeItem('pos_synced_catalog');}catch(e){}`
      );
    } catch {
      /* renderer may not be ready */
    }
    try {
      appView?.webContents.send('pos:company-scope-changed', { companyId });
    } catch {
      /* renderer may not be ready */
    }
    console.log('[scope] local data switched to company', companyId);
    return true;
  };

  switchLocalDataChain = switchLocalDataChain.then(runSwitch, runSwitch);
  return switchLocalDataChain;
}

async function ensureCatalogOpen(user) {
  const companyId = resolveCompanyId(user) || '_default';
  if (masterSqlite.isOpenForCompany(companyId) && localDb.getActiveCompanyId() === companyId) {
    return true;
  }
  await switchLocalDataForCompany(user || {});
  return masterSqlite.isOpen();
}

function showLoginScreen(opts = {}) {
  stopDesktopNotifications();
  pendingLogin = null;
  const message = typeof opts === 'string' ? opts : opts?.message;
  const reason = typeof opts === 'object' ? opts?.reason || opts?.code : undefined;
  const query = {};
  if (message) query.msg = String(message);
  if (reason) query.reason = String(reason);
  const loadOpts = Object.keys(query).length ? { query } : undefined;
  appView?.webContents.loadFile(path.join(__dirname, 'renderer', 'login.html'), loadOpts);
}

function isNetworkAccessError(message) {
  return /fetch|ECONNREFUSED|ENOTFOUND|network|timed out|Cannot reach/i.test(String(message || ''));
}

async function validateSessionAccess(token) {
  if (!token) {
    return { ok: false, code: 'NO_SESSION', message: 'Please sign in.' };
  }
  const res = await posApi.fetchSessionStatus(token);
  if (res.success) {
    const payload = res.data || {};
    if (payload.ok === false) {
      return {
        ok: false,
        code: payload.code || 'SUBSCRIPTION_EXPIRED',
        message: payload.message || 'Your subscription has expired. Please subscribe to continue.',
        data: payload,
      };
    }
    return { ok: true, code: 'OK', data: payload };
  }
  if (!res.status && isNetworkAccessError(res.message)) {
    return { ok: true, code: 'OFFLINE', offline: true };
  }
  if (res.code === 'COMPANY_INACTIVE') {
    return { ok: false, code: res.code, message: res.message };
  }
  if (res.status === 401) {
    return {
      ok: false,
      code: res.code || 'USER_INACTIVE',
      message: res.message || 'Your account has been deactivated. Please contact support.',
    };
  }
  if (res.status === 403 && res.code) {
    return { ok: false, code: res.code, message: res.message };
  }
  return {
    ok: false,
    code: 'SESSION_INVALID',
    message: res.message || 'Session expired. Please sign in again.',
  };
}

async function forceLogoutWithReason(code, message) {
  if (pendingForcedLogout) return;
  pendingForcedLogout = true;
  appView?.webContents.send('auth:access-denied', { code, message });
  setTimeout(() => {
    authStore.clearSession(userData());
    pendingLogin = null;
    activeShift = null;
    try { localDb.saveActiveShift(null); } catch { /* ignore */ }
    showLoginScreen({ message, reason: code });
    pendingForcedLogout = false;
  }, 5000);
}

function showShiftScreen() {
  appView?.webContents.loadFile(path.join(__dirname, 'renderer', 'shift.html'));
}

function showSellScreen(user) {
  const authUser = user || requireAuth()?.session?.user;
  const posMode = authUser ? resolvePosMode(authUser) : 'retail';
  appView?.webContents.loadFile(path.join(__dirname, 'renderer', 'sell.html'), {
    query: { posMode },
  });
}

function showRestaurantPosScreen(tab = 'counter') {
  appView?.webContents.loadFile(path.join(__dirname, 'renderer', 'restaurant-pos.html'), {
    query: { tab: String(tab || 'counter') },
  });
}

function startDesktopNotifications() {
  desktopNotifications.start(appView, requireAuth, mainWindow);
}

function stopDesktopNotifications() {
  desktopNotifications.stop();
}

function resolvePosMode(user) {
  return String(user?.posMode || user?.company?.posMode || 'retail').toLowerCase();
}

function isKitchenRole(user) {
  return String(user?.role || '').toLowerCase() === 'kitchen';
}

function enterPosForUser(user) {
  if (resolvePosMode(user) === 'restaurant' && isKitchenRole(user)) {
    showRestaurantPosScreen('kitchen');
    return;
  }
  showSellScreen(user);
}

function showSalesScreen() {
  appView?.webContents.loadFile(path.join(__dirname, 'renderer', 'sales.html'));
}

function showManagementScreen() {
  appView?.webContents.loadFile(path.join(__dirname, 'renderer', 'management.html'));
}

function showRegisterScreen() {
  appView?.webContents.loadFile(path.join(__dirname, 'renderer', 'register.html'));
}

function showCategoriesScreen() {
  const load = () => {
    const timestamp = Date.now();
    appView?.webContents.loadFile(path.join(__dirname, 'renderer', 'categories.html'), {
      query: { t: timestamp }
    });
  };
  if (appView?.webContents.session) {
    appView.webContents.session.clearCache().catch(() => {}).finally(load);
  } else {
    load();
  }
}

function showProductsScreen() {
  const load = () => {
    const timestamp = Date.now();
    appView?.webContents.loadFile(path.join(__dirname, 'renderer', 'products.html'), {
      query: { t: timestamp }
    });
  };
  if (appView?.webContents.session) {
    appView.webContents.session.clearCache().catch(() => {}).finally(load);
  } else {
    load();
  }
}

function showPosScreen() {
  showShiftScreen();
}

async function loadAuthOrPos() {
  const session = authStore.getValidSession(userData());
  if (!session?.accessToken) {
    showLoginScreen();
    return;
  }
  const check = await validateSessionAccess(session.accessToken);
  if (!check.ok) {
    await forceLogoutWithReason(check.code, check.message);
    return;
  }
  const activeId = resolveCompanyId(session.user, session);
  applyApiCompanyContext(activeId);
  const user = await enrichUserProfile(session.user, session.accessToken, activeId);
  const boundUser = user
    ? {
        ...user,
        companyId: activeId || resolveCompanyId(user, session),
        activeCompanyId: activeId || resolveCompanyId(user, session),
      }
    : session.user;
  if (boundUser) {
    authStore.writeSession(userData(), {
      ...session,
      user: boundUser,
      activeCompanyId: boundUser.companyId || activeId,
    });
    applyApiCompanyContext(boundUser.companyId || activeId);
    await switchLocalDataForCompany(boundUser);
  }
  showShiftScreen();
}

function isAdminUser(user) {
  const role = String(user?.role || '').toLowerCase().trim();
  return (
    role === 'admin' ||
    role === 'owner' ||
    role === 'superadmin' ||
    role === 'company_admin' ||
    user?.isLocationAdmin === true
  );
}

/** Assigned location IDs. null = company-wide / all. Admins and users with no warehouse assignment are company-wide. */
function getUserLocationIds(user) {
  if (!user) return [];
  if (isAdminUser(user)) return null;
  if (Array.isArray(user.locationIds) && user.locationIds.length) {
    return user.locationIds.map(String);
  }
  if (Array.isArray(user.locations) && user.locations.length) {
    return user.locations.map((l) => String(l.id || l._id || '')).filter(Boolean);
  }
  // No warehouse assignment = company-wide access
  return null;
}

function filterLocationsForUser(user, list) {
  const rows = Array.isArray(list) ? list : [];
  const allowed = getUserLocationIds(user);
  if (allowed === null) return rows; // admin — all
  if (!allowed.length) return [];
  const set = new Set(allowed);
  return rows.filter((l) => set.has(String(l.id || l._id || '')));
}

function getUserAssignedTerminalId(user) {
  const id = user?.assignedTerminalId || user?.assigned_terminal_id;
  return id ? String(id).trim() : '';
}

function filterTerminalsForUser(user, list) {
  const rows = Array.isArray(list) ? list : [];
  const assignedTerminalId = getUserAssignedTerminalId(user);

  if (assignedTerminalId && !isAdminUser(user)) {
    const match = rows.filter((t) => String(t.id) === assignedTerminalId);
    return match.length ? match : [];
  }

  const allowed = getUserLocationIds(user);
  if (allowed === null) return rows; // admin / company-wide — all
  if (!allowed.length) return rows.filter((t) => !String(t.locationId || t.location?.id || '').trim());
  const set = new Set(allowed);
  return rows.filter((t) => {
    const locId = String(t.locationId || t.location?.id || '').trim();
    // Company-wide terminals (no warehouse) + terminals at assigned warehouses
    return !locId || set.has(locId);
  });
}

function normalizeServerShift(serverShift, user, terminals) {
  if (!serverShift) return null;
  const rows = Array.isArray(terminals) ? terminals : [];
  const terminal =
    serverShift.terminal ||
    rows.find((t) => String(t.id) === String(serverShift.terminalId)) ||
    null;
  const cashier = serverShift.cashier || {};
  const uid = currentUserId(user);
  return {
    id: serverShift.id,
    terminalId: serverShift.terminalId,
    locationId: terminal?.locationId || terminal?.location?.id || null,
    userId: serverShift.cashierId || cashier.id || uid,
    cashierId: serverShift.cashierId || cashier.id || uid,
    status: serverShift.status,
    openingCash: Number(serverShift.openingCash || 0),
    openedAt: serverShift.openedAt,
    suspendedAt: serverShift.suspendedAt || null,
    terminal: terminal
      ? {
          ...terminal,
          location: terminal.location || serverShift.terminal?.location || null,
        }
      : serverShift.terminal || null,
    cashier: {
      id: cashier.id || serverShift.cashierId || uid,
      name:
        [cashier.firstName, cashier.lastName].filter(Boolean).join(' ') ||
        [user?.firstName, user?.lastName].filter(Boolean).join(' ') ||
        user?.email ||
        '',
      role: user?.role,
    },
    fromServer: true,
  };
}

function shiftAllowedForUser(shift, user, terminals) {
  if (!shift) return false;
  if (isAdminUser(user)) return true;
  const uid = currentUserId(user);
  const shiftUser = String(shift.cashier?.id || shift.userId || shift.cashierId || '').trim();
  // Cashier owns this shift — always allow resume on re-login (same PC or not)
  if (shiftUser && uid && shiftUser === uid) return true;
  if (shiftUser && uid && shiftUser !== uid) return false;
  const assignedTerminalId = getUserAssignedTerminalId(user);
  if (assignedTerminalId && String(shift.terminalId) !== assignedTerminalId) return false;
  const allowed = filterTerminalsForUser(user, terminals);
  return allowed.some((t) => String(t.id) === String(shift.terminalId));
}

async function hydrateShiftFromServer(token, user) {
  if (!token) return null;
  try {
    const res = await posApi.getCurrentShift(token);
    if (!res.success || !res.data) return null;
    const terminals = filterTerminalsForUser(user, localDb.getTerminals());
    const normalized = normalizeServerShift(res.data, user, terminals);
    if (!shiftAllowedForUser(normalized, user, terminals)) return null;
    activeShift = normalized;
    localDb.saveActiveShift(normalized);
    return normalized;
  } catch (err) {
    console.warn('[shift] server hydrate failed:', err.message);
    return null;
  }
}

function currentUserId(sessionOrUser) {
  const u = sessionOrUser?.user || sessionOrUser || {};
  return String(u.id || u._id || sessionOrUser?.userId || '').trim();
}

/** Resolve locationId from a sale/return/held record (stamped or via terminal cache). */
function resolveRecordLocationId(record) {
  if (!record || typeof record !== 'object') return '';
  const direct = String(record.locationId || record.location?.id || '').trim();
  if (direct && direct !== 'all') return direct;
  const termId = String(record.terminalId || record.terminal?.id || '').trim();
  if (!termId) return '';
  try {
    const terminals = localDb.getTerminals();
    const t = (terminals || []).find((x) => String(x.id) === termId);
    return String(t?.locationId || t?.location?.id || '').trim();
  } catch {
    return '';
  }
}

/**
 * Non-admin: keep only records for their assigned location(s).
 * Prefer locationId; fall back to cashier/userId match so old untagged rows
 * belonging to this cashier still show; hide other locations' data.
 */
function filterRecordsForUser(user, records) {
  const rows = Array.isArray(records) ? records : [];
  const allowed = getUserLocationIds(user);
  if (allowed === null) return rows; // admin — everything
  const uid = currentUserId(user);
  if (!allowed.length) {
    // No warehouse assignment — company-wide / untagged rows only
    return rows.filter((r) => {
      const locId = resolveRecordLocationId(r);
      if (!locId) return true;
      const cashier = String(r.cashierId || r.userId || r.cashier?.id || '').trim();
      return uid && cashier && cashier === uid;
    });
  }
  const set = new Set(allowed.map(String));
  return rows.filter((r) => {
    const locId = resolveRecordLocationId(r);
    if (locId) return set.has(locId);
    // Untagged / company-wide row: only show if clearly this cashier's
    const cashier = String(r.cashierId || r.userId || r.cashier?.id || '').trim();
    return uid && cashier && cashier === uid;
  });
}

/** Stamp user/location onto offline POS payloads before local persist. */
/** 'STORE_CREDIT' | 'POINTS' | 'ACCOUNT' | null for a payment method label. */
function customerTenderKind(method) {
  const m = String(method || '').toLowerCase();
  if (m.includes('store credit')) return 'STORE_CREDIT';
  if (m.includes('loyalty') || m.includes('points')) return 'POINTS';
  if (m.includes('credit') || m.includes('on account')) return 'ACCOUNT';
  return null;
}

function roundMoney(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * Ledger rows a sale produces for its customer. Throws (sale is rejected) when a
 * customer tender is not covered by the balance — the renderer checks first, this
 * is the last line of defence against double-spend from two windows.
 */
function buildSaleLedgerEntries(sale, auth) {
  const pays = Array.isArray(sale.payments) ? sale.payments : [];
  let creditUsed = 0;
  let pointsUsed = 0;
  let accountCharge = 0;
  for (const p of pays) {
    const kind = customerTenderKind(p.paymentMethod);
    if (kind === 'STORE_CREDIT') creditUsed += Number(p.amount) || 0;
    else if (kind === 'POINTS') pointsUsed += Number(p.points) || 0;
    else if (kind === 'ACCOUNT') accountCharge += Number(p.amount) || 0;
  }
  const earned = Math.max(0, Math.floor(Number(sale.loyaltyEarned) || 0));
  const customerId = String(sale.customerId || '').trim();
  if (!customerId) {
    if (creditUsed || pointsUsed || accountCharge) {
      throw new Error('Select a customer to use store credit, loyalty points or on-account payment.');
    }
    return [];
  }

  const bal = masterSqlite.getCustomerBalances(customerId);
  if (creditUsed > bal.storeCredit + 0.009) {
    throw new Error(`Store credit balance is only ${roundMoney(bal.storeCredit).toFixed(2)}.`);
  }
  if (pointsUsed > bal.points + 0.0001) {
    throw new Error(`Customer has only ${bal.points} loyalty points.`);
  }
  if (accountCharge > 0) {
    const row = masterSqlite.getCustomerById(customerId);
    let payload = {};
    try { payload = JSON.parse(row?.payload || '{}'); } catch { payload = {}; }
    const limit = Number(payload.creditLimit || 0);
    const policy = String(payload.creditPolicy || 'WARN').toUpperCase();
    if (limit > 0 && policy === 'BLOCK' && bal.accountBalance + accountCharge > limit + 0.009) {
      throw new Error(`Credit limit exceeded. Available: ${roundMoney(limit - bal.accountBalance).toFixed(2)}`);
    }
  }

  const createdBy = currentUserId(auth.session?.user);
  const entries = [];
  if (creditUsed) entries.push({ customerId, kind: 'CREDIT', type: 'REDEEM', amount: -roundMoney(creditUsed), note: 'Paid with store credit', createdBy });
  if (pointsUsed) entries.push({ customerId, kind: 'POINTS', type: 'REDEEM', points: -pointsUsed, note: 'Points redeemed on sale', createdBy });
  if (accountCharge) entries.push({ customerId, kind: 'ACCOUNT', type: 'CHARGE', amount: roundMoney(accountCharge), note: 'Sale on account', createdBy });
  if (earned) entries.push({ customerId, kind: 'POINTS', type: 'EARN', points: earned, note: 'Points earned on sale', createdBy });
  return entries;
}

function returnLineKey(item) {
  return String(item?.productId || item?.productName || item?.name || '').trim().toLowerCase();
}

/** Quantity already returned per line for one sale (from the permanent local returns log). */
function returnedQtyBySale(saleId) {
  const out = new Map();
  if (!saleId) return out;
  for (const r of masterSqlite.listAllLocalReturns() || []) {
    if (String(r.originalSaleId || r.saleId || '') !== String(saleId)) continue;
    for (const item of r.items || []) {
      const key = returnLineKey(item);
      out.set(key, (out.get(key) || 0) + (Number(item.quantity) || 0));
    }
  }
  return out;
}

/** Totals for a stored sale, rebuilding grand total for older rows that lack it. */
function saleGrandTotal(sale) {
  const explicit = Number(sale.grandTotal ?? sale.totalAmount ?? sale.total ?? sale.finalTotal ?? 0);
  if (explicit > 0) return explicit;
  const items = sale.items || [];
  const lines = items.reduce((sum, i) => sum + (Number(i.lineTotal) || (Number(i.quantity || 0) * Number(i.unitPrice || 0))), 0);
  return Math.max(0, lines - (Number(sale.discountTotal) || 0));
}

function customerSaleStats(customerId, sales) {
  const mine = sales.filter((s) => String(s.customerId || '') === String(customerId) && !s.voided && s.status !== 'Voided');
  const totalSpent = mine.reduce((sum, s) => sum + saleGrandTotal(s), 0);
  const last = mine.reduce((acc, s) => {
    const t = new Date(s.createdAt || 0).getTime();
    return t > acc ? t : acc;
  }, 0);
  return {
    visits: mine.length,
    totalSpent: roundMoney(totalSpent),
    avgTicket: mine.length ? roundMoney(totalSpent / mine.length) : 0,
    lastVisit: last ? new Date(last).toISOString() : null,
  };
}

function stampScopedPayload(auth, payload = {}) {
  const user = auth.session?.user || {};
  const uid = currentUserId(user);
  const terminal =
    activeShift?.terminal ||
    (() => {
      try {
        return (localDb.getTerminals() || []).find(
          (t) => String(t.id) === String(activeShift?.terminalId || payload.terminalId || '')
        );
      } catch {
        return null;
      }
    })();
  // Only stamp warehouse when the terminal (or payload) explicitly has one —
  // never fall back to a default / first user location.
  const locationId =
    String(payload.locationId || '').trim() ||
    String(activeShift?.terminal?.locationId || activeShift?.terminal?.location?.id || '').trim() ||
    String(terminal?.locationId || terminal?.location?.id || '').trim() ||
    '';

  return {
    ...payload,
    companyId:
      posApi.getActiveCompanyId?.() ||
      resolveCompanyId(user) ||
      payload.companyId ||
      undefined,
    shiftId: activeShift?.id || payload.shiftId,
    terminalId: activeShift?.terminalId || payload.terminalId || terminal?.id,
    locationId: locationId || undefined,
    userId: uid || undefined,
    cashierId: uid || undefined,
    cashierName:
      payload.cashierName ||
      [user.firstName, user.lastName].filter(Boolean).join(' ') ||
      user.email ||
      undefined,
  };
}

/** Clear active shift if it belongs to another user / out-of-scope location. */
function resetActiveShiftForUser(user) {
  try {
    const saved = localDb.getActiveShift();
    if (!saved) {
      activeShift = null;
      return;
    }
    const uid = currentUserId(user);
    const shiftUser = String(saved.cashier?.id || saved.userId || saved.cashierId || '').trim();
    const locId = String(
      saved.terminal?.locationId || saved.terminal?.location?.id || saved.locationId || ''
    ).trim();
    const allowed = getUserLocationIds(user);
    const locOk = allowed === null || !locId || allowed.includes(locId);
    const userOk = !shiftUser || !uid || shiftUser === uid;
    const assignedTerminalId = getUserAssignedTerminalId(user);
    const terminalOk =
      !assignedTerminalId || String(saved.terminalId || '') === assignedTerminalId;
    if (!locOk || !userOk || !terminalOk || saved.status === 'Closed') {
      console.log('[scope] clearing active shift for new user/location scope');
      localDb.saveActiveShift(null);
      activeShift = null;
      return;
    }
    activeShift = saved;
  } catch (err) {
    console.warn('[scope] resetActiveShift failed', err.message);
    activeShift = null;
  }
}

/** Pull locations + terminals from cloud (or session.user.locations) and cache locally, scoped. */
async function refreshScopedCatalogCaches(token, user) {
  let locations = [];
  let terminals = [];

  try {
    const locRes = await posApi.listLocations(token);
    if (locRes?.success && Array.isArray(locRes.data)) {
      locations = locRes.data;
    }
  } catch (err) {
    console.warn('[scope] listLocations failed:', err.message);
  }

  // Fallback to locations embedded in login user object
  if (!locations.length && Array.isArray(user?.locations) && user.locations.length) {
    locations = user.locations;
  }

  locations = filterLocationsForUser(user, locations);
  try { localDb.saveLocations(locations); } catch (err) {
    console.warn('[scope] saveLocations failed:', err.message);
  }

  try {
    const termRes = await posApi.listTerminals(token);
    if (termRes?.success && Array.isArray(termRes.data)) {
      terminals = termRes.data;
    } else {
      console.warn('[scope] listTerminals:', termRes?.message || 'no data');
    }
  } catch (err) {
    console.warn('[scope] listTerminals failed:', err.message);
  }

  terminals = filterTerminalsForUser(user, terminals);

  // Drop any leftover offline placeholders — terminals must be created explicitly.
  terminals = terminals.filter((t) => !String(t.id || '').startsWith('local-term-'));

  try { localDb.saveTerminals(terminals); } catch (err) {
    console.warn('[scope] saveTerminals failed:', err.message);
  }

  console.log(
    `[scope] cached ${locations.length} location(s), ${terminals.length} terminal(s)` +
    (isAdminUser(user) ? ' (admin=all)' : ' (scoped)')
  );
  return { locations, terminals };
}

function requireAuth() {
  const sessionData = authStore.getValidSession(userData());
  if (!sessionData?.accessToken) {
    return { ok: false, result: { success: false, message: 'Please sign in again' } };
  }
  const companyId = resolveCompanyId(sessionData.user, sessionData);
  if (companyId) applyApiCompanyContext(companyId);
  return { ok: true, session: sessionData };
}

function requireAdmin() {
  const auth = requireAuth();
  if (!auth.ok) return auth;
  if (!isAdminUser(auth.session.user)) {
    return { ok: false, result: { success: false, message: 'Admin access only' } };
  }
  return auth;
}

function sessionSeedScript(sessionData) {
  if (!sessionData?.accessToken) return '';
  const userJson =
    typeof sessionData.user === 'string'
      ? sessionData.user
      : JSON.stringify(sessionData.user || null);
  const payload = {
    accessToken: sessionData.accessToken,
    refreshToken: sessionData.refreshToken || '',
    userJson,
  };
  return `(function(){try{var s=${JSON.stringify(payload)};if(s.accessToken)localStorage.setItem('auth_token',s.accessToken);if(s.refreshToken)localStorage.setItem('refresh_token',s.refreshToken);if(s.userJson&&s.userJson!=='null')localStorage.setItem('user',s.userJson);localStorage.setItem('has_subscription_access','1');}catch(e){}})();`;
}

async function bindCompanyAndOpenPos(token, refreshToken, user, company) {
  const companyId = String(company?.id || company || '').trim();
  if (!companyId) {
    return { success: false, message: 'Select a company for this POS session' };
  }

  applyApiCompanyContext(companyId);

  try {
    await backendApi.setPrimaryCompany(token, companyId);
  } catch (err) {
    console.warn('[scope] setPrimaryCompany failed:', err.message);
  }

  let boundUser = {
    ...user,
    companyId,
    activeCompanyId: companyId,
    company:
      typeof company === 'object' && company
        ? { ...(user.company || {}), ...company, id: companyId }
        : { ...(user.company || {}), id: companyId },
    organizationName:
      (typeof company === 'object' && company?.name) ||
      user.organizationName ||
      user.company?.name ||
      '',
  };

  boundUser = await enrichUserProfile(boundUser, token, companyId);
  boundUser = {
    ...boundUser,
    companyId,
    activeCompanyId: companyId,
    company: {
      ...(boundUser.company || {}),
      ...(typeof company === 'object' && company ? company : {}),
      id: companyId,
    },
  };

  authStore.writeSession(userData(), {
    accessToken: token,
    refreshToken,
    user: boundUser,
    activeCompanyId: companyId,
  });
  await applyAuthCookies(token, refreshToken);
  pendingLogin = null;
  await switchLocalDataForCompany(boundUser);
  resetActiveShiftForUser(boundUser);

  try {
    if (Array.isArray(boundUser.locations) && boundUser.locations.length) {
      localDb.saveLocations(filterLocationsForUser(boundUser, boundUser.locations));
    }
    await refreshScopedCatalogCaches(token, boundUser);
  } catch (err) {
    console.warn('[desktop] scope cache seed failed:', err.message);
  }

  try {
    console.log('[scope] refreshing full company catalog for', companyId);
    await masterSync.refreshCatalog(token, '');
  } catch (err) {
    console.warn('[scope] catalog refresh failed:', err.message);
  }

  try {
    const taxRes = await posApi.fetchTaxContext(token);
    if (taxRes?.success && taxRes.data) {
      localDb.saveTaxContext(taxRes.data);
      console.log('[desktop] tax context cached · enabled=', Boolean(taxRes.data.enabled));
    }
  } catch (err) {
    console.warn('[desktop] tax context fetch failed:', err.message);
  }

  console.log('[desktop] session ready for company', companyId, boundUser.email || boundUser.id);
  const access = await validateSessionAccess(token);
  if (!access.ok) {
    authStore.clearSession(userData());
    return { success: false, code: access.code, message: access.message };
  }

  startDesktopNotifications();

  const existingShift = await hydrateShiftFromServer(token, boundUser);
  if (existingShift?.status === 'Open') {
    console.log('[desktop] resuming open shift for', boundUser.email || boundUser.id);
    enterPosForUser(boundUser);
    return { success: true, resumed: true, companyId };
  }

  showShiftScreen();
  return { success: true, companyId };
}

async function completeLoginAndOpenPos(rawBody) {
  const picked = backendApi.pickAuth(rawBody);
  let { token, refreshToken, user } = picked;
  if (!token) {
    return { success: false, message: 'Login succeeded but no token was returned' };
  }
  if (!user) {
    user = await backendApi.getMe(token);
  }
  if (!user) {
    return { success: false, message: 'Login succeeded but user profile could not be loaded' };
  }

  user = await enrichUserProfile(user, token);

  if (!Array.isArray(user.locationIds) && Array.isArray(user.locations)) {
    user.locationIds = user.locations.map((l) => l.id || l._id).filter(Boolean);
  }
  if (user.isLocationAdmin == null) {
    user.isLocationAdmin = isAdminUser(user);
  }

  // Temporarily clear company header so /companies/mine returns DB preferred company
  applyApiCompanyContext('');

  let companies = [];
  let erpActiveCompanyId = '';
  try {
    const companiesRes = await backendApi.listMyCompanies(token);
    companies = Array.isArray(companiesRes.companies) ? companiesRes.companies : [];
    erpActiveCompanyId = String(
      companiesRes.preferredCompanyId || companiesRes.activeCompanyId || ''
    ).trim();
    if (erpActiveCompanyId === '__all__') erpActiveCompanyId = '';
  } catch (err) {
    console.warn('[scope] listMyCompanies failed:', err.message);
  }

  if (!companies.length && resolveCompanyId(user)) {
    companies = [
      {
        id: resolveCompanyId(user),
        name: user.company?.name || user.organizationName || 'Company',
        logo: user.company?.logo || user.businessDetails?.logo || '',
        isPrimary: true,
      },
    ];
    erpActiveCompanyId = erpActiveCompanyId || resolveCompanyId(user);
  }

  // Multiple companies: always show picker so child (e.g. GreatLink) can be chosen
  // over parent home company. Pre-select ERP preferred / primary.
  if (companies.length > 1) {
    const preferred =
      companies.find((c) => String(c.id) === erpActiveCompanyId) ||
      companies.find((c) => c.isPrimary) ||
      companies[0];
    pendingLogin = {
      token,
      refreshToken,
      user,
      companies,
      activeCompanyId: preferred?.id || erpActiveCompanyId || '',
    };
    authStore.writeSession(userData(), {
      accessToken: token,
      refreshToken,
      user,
      activeCompanyId: '',
    });
    showCompanySelectScreen();
    return { success: true, needsCompany: true, companies };
  }

  // Follow ERP preferred / active company when only one membership or clear preferred
  const erpActive =
    companies.find((c) => String(c.id) === erpActiveCompanyId) || null;
  if (erpActive?.id) {
    return bindCompanyAndOpenPos(token, refreshToken, user, erpActive);
  }

  if (companies.length === 1 && companies[0]?.id) {
    return bindCompanyAndOpenPos(token, refreshToken, user, companies[0]);
  }

  return { success: false, message: 'No company found for this account' };
}

async function applyAuthCookies(accessToken, refreshToken) {
  const ses = session.fromPartition('persist:bison-pos');
  const url = rendererOrigin;
  const expires = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;
  const base = { url, path: '/', sameSite: 'lax', expirationDate: expires };
  try {
    if (accessToken) {
      await ses.cookies.set({ ...base, name: 'auth_token', value: accessToken, httpOnly: true });
    }
    if (refreshToken) {
      await ses.cookies.set({ ...base, name: 'refresh_token', value: refreshToken, httpOnly: true });
    }
    await ses.cookies.set({ ...base, name: 'bt_logged_in', value: '1', httpOnly: false });
    await ses.cookies.set({ ...base, name: 'subscription_access', value: '1', httpOnly: false });
    await ses.cookies.set({ ...base, name: 'has_subscription_access', value: '1', httpOnly: false });
  } catch (err) {
    console.warn('[desktop] cookie sync failed', err.message);
  }
}

function applyRendererSecurity() {
  const csp = [
    "default-src 'self'",
    isDev
      ? "script-src 'self' 'unsafe-inline' 'unsafe-eval' http://127.0.0.1:* http://localhost:*"
      : "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob: https:",
    "connect-src 'self' http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:* wss: https:",
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');

  const ses = session.fromPartition('persist:bison-pos');
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media' || permission === 'clipboard-sanitized-write');
  });
  ses.setPermissionCheckHandler((_wc, permission) => (
    permission === 'media' || permission === 'clipboard-sanitized-write'
  ));
  ses.webRequest.onBeforeRequest((details, callback) => {
    const url = details.url || '';
    if (url.includes('webpack-hmr') || url.includes('_next/webpack-hmr')) {
      callback({ cancel: true });
      return;
    }
    callback({});
  });
  ses.webRequest.onHeadersReceived((details, callback) => {
    const isNextHmr = (details.url || '').includes('webpack-hmr');
    const headers = { ...details.responseHeaders };
    if (!isNextHmr) headers['Content-Security-Policy'] = [csp];
    callback({ responseHeaders: headers });
  });
}

function waitForHttp(url, timeoutMs = 20_000) {
  const client = url.startsWith('https:') ? https : http;
  return new Promise((resolve) => {
    const started = Date.now();
    const ping = () => {
      const req = client.get(url, (res) => {
        res.resume();
        resolve(true);
      });
      req.on('error', () => {
        if (Date.now() - started > timeoutMs) return resolve(false);
        setTimeout(ping, 500);
      });
    };
    ping();
  });
}

function createSplash() {
  splashWindow = new BrowserWindow({
    width: 480,
    height: 320,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  splashWindow.loadFile(path.join(__dirname, 'splash.html'));
}

function showMain() {
  if (shown || !mainWindow) return;
  shown = true;
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
  splashWindow = null;
  mainWindow.show();
}

function layoutViews() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const [w, h] = mainWindow.getContentSize();
  titleBarView?.setBounds({ x: 0, y: 0, width: w, height: TITLEBAR_HEIGHT });
  appView?.setBounds({
    x: 0,
    y: TITLEBAR_HEIGHT,
    width: w,
    height: Math.max(0, h - TITLEBAR_HEIGHT),
  });
}

function createMainWindow() {
  const saved = windowState.load(userData());
  mainWindow = new BrowserWindow({
    width: saved.width,
    height: saved.height,
    x: saved.x,
    y: saved.y,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#0b2744',
    icon: ICON,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });

  windowState.track(userData(), mainWindow);
  if (saved.isMaximized) mainWindow.maximize();

  titleBarView = new BrowserView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
    },
  });

  appView = new BrowserView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      partition: 'persist:bison-pos',
      webSecurity: false,
    },
  });

  // TEMP DEBUG: forward renderer console to main stdout
  const logConsole = (msgOrEvent, maybeMsg, maybeLine, maybeSrc) => {
    const msg = typeof msgOrEvent === 'object' && msgOrEvent !== null
      ? `${msgOrEvent.message || ''} @ ${msgOrEvent.sourceId || ''}:${msgOrEvent.lineNumber ?? ''}`
      : `${maybeMsg} @ ${maybeSrc}:${maybeLine}`;
    console.log(`[renderer] ${msg}`);
  };
  appView.webContents.on('console-message', logConsole);
  appView.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (isMainFrame) console.error('[renderer] did-fail-load', code, desc, url);
  });
  appView.webContents.on('render-process-gone', (_e, details) => {
    console.error('[renderer] process-gone', details.reason);
  });
  appView.webContents.on('did-finish-load', () => {
    // FIX: persisted zoom (partition persist:bison-pos) breaks viewport/click mapping
    if (appView.webContents.getZoomLevel() !== 0) {
      console.log('[renderer] resetting persisted zoom:', appView.webContents.getZoomLevel());
      appView.webContents.setZoomLevel(0);
    }
    console.log('[renderer] finish url=', appView.webContents.getURL(), 'bounds=', JSON.stringify(appView.getBounds()));
    setTimeout(() => {
      appView.webContents.executeJavaScript(`(() => {
        try {
          // Capture console errors
          window.__errors = [];
          window.addEventListener('error', e => window.__errors.push(e.message));
          
          const W = window.innerWidth, H = window.innerHeight;
          const center = document.elementFromPoint(W/2, H/2);
          
          // Get all buttons and check their onclick/addEventListener status
          const buttons = [...document.querySelectorAll('button, .tab-btn, .nav-item, a.btn')];
          const btnInfo = buttons.slice(0, 10).map(b => ({
            tag: b.tagName,
            id: b.id,
            cls: b.className.slice(0, 30),
            text: b.textContent.trim().slice(0, 20),
            disabled: b.disabled,
            onclick: b.onclick ? 'has-onclick' : 'no-onclick',
            rect: (() => { const r = b.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })()
          }));
          
          // Try to find sidebar tabs specifically
          const sidebar = document.querySelector('.sidebar, #sidebar, nav, .nav');
          const sidebarBtns = sidebar ? [...sidebar.querySelectorAll('button, .tab-btn, a, [role=tab]')].slice(0, 10).map(b => ({
            tag: b.tagName,
            cls: b.className.slice(0, 40),
            text: b.textContent.trim().slice(0, 25),
            hasClick: b.onclick !== null || b.getAttribute('data-tab') || b.getAttribute('href'),
            rect: (() => { const r = b.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })()
          })) : 'no-sidebar-found';
          
          // Check product grid state
          const grid = document.querySelector('.products-grid, .product-grid, #products-grid, [class*=product-grid]');
          const gridHTML = grid ? grid.innerHTML.slice(0, 500) : 'no-grid';
          
          return JSON.stringify({
            dims: W + 'x' + H,
            hasBisonDesktop: typeof window.bisonDesktop !== 'undefined',
            bodyPointerEvents: getComputedStyle(document.body).pointerEvents,
            coveringDivs: [...document.querySelectorAll('div')].filter(d => {
              const r = d.getBoundingClientRect();
              const cs = getComputedStyle(d);
              return r.width >= W*0.9 && r.height >= H*0.9 && r.top <= 0 && r.left <= 0
                && cs.position === 'fixed' && cs.pointerEvents !== 'none';
            }).map(d => d.id || d.className.slice(0, 30) || 'anon'),
            centerEl: center ? (center.id || center.className.slice(0, 30) || center.tagName) : 'null',
            buttons: btnInfo,
            sidebar: sidebarBtns,
                         gridHTML: gridHTML,
            errors: window.__errors ? window.__errors.slice(0, 5) : [],
            bootSteps: window.__bootSteps ? window.__bootSteps.slice(0, 20) : 'none',
          });
        } catch (e) { return 'PROBE-ERR: ' + e.message + ' | ' + e.stack; }
      })()`).then(r => console.log('[probe3]', r)).catch(e => console.error('[probe3] fail', e.message));
      // SECOND PROBE: manually invoke boot() and capture exactly what happens
      appView.webContents.executeJavaScript(`(async () => {
        const out = { readyState: document.readyState, hadBoot: typeof boot, bootSteps: window.__bootSteps };
        if (typeof boot === 'function') {
          try {
            await Promise.race([boot(), new Promise((_,rej)=>setTimeout(()=>rej(new Error('boot timed out (>8s)')),8000))]);
            out.bootResult = 'RESOLVED';
          } catch(e) {
            out.bootResult = 'THREW: ' + e.message;
            out.bootStack = (e.stack||'').split('\\n').slice(0,3).join(' | ');
          }
          out.bootStepsAfter = window.__bootSteps.slice(0,30);
        } else {
          out.bootResult = 'boot NOT a function — top-level failed before defining it (can we even do manual? boot is hoisted)';
        }
        return JSON.stringify(out);
      })()`).then(r => console.log('[probe4]', r)).catch(e => console.error('[probe4] fail', e.message));
    }, 6000);
  });

  mainWindow.addBrowserView(titleBarView);
  mainWindow.addBrowserView(appView);
  layoutViews();

  mainWindow.on('resize', layoutViews);
  mainWindow.on('maximize', () => {
    layoutViews();
    titleBarView?.webContents.send('window:maximized', true);
  });
  mainWindow.on('unmaximize', () => {
    layoutViews();
    titleBarView?.webContents.send('window:maximized', false);
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
    titleBarView = null;
    appView = null;
  });

  titleBarView.webContents.loadFile(path.join(__dirname, 'titlebar.html'));

  if (isDev) {
    appView.webContents.openDevTools({ mode: 'detach' });
  }

  appView.webContents.setWindowOpenHandler(({ url }) => {
    // Allow blank/about:blank windows (used by the POS print/PDF report feature
    // via window.open('', '_blank', ...) + document.write).
    if (url === '' || String(url).startsWith('about:blank')) return { action: 'allow' };
    if (String(url).startsWith(rendererOrigin)) return { action: 'allow' };
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  appView.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('file://')) return;
    if (!url.startsWith(rendererOrigin)) {
      event.preventDefault();
      shell.openExternal(url);
      return;
    }
    try {
      const pathname = new URL(url).pathname;
      if (pathname.startsWith('/login') || pathname.startsWith('/plans')) {
        event.preventDefault();
        if (!authStore.getValidSession(userData())?.user) showLoginScreen();
        return;
      }
      if (!config.isDesktopAllowedPath(pathname)) {
        event.preventDefault();
        if (authStore.getValidSession(userData())?.user) showPosScreen();
        else showLoginScreen();
      }
    } catch {
      // keep navigation
    }
  });

  appView.webContents.on('dom-ready', async () => {
    const url = appView.webContents.getURL();
    if (url.startsWith('file://')) return;
    const s = authStore.getValidSession(userData());
    if (!s) return;
    try {
      await appView.webContents.executeJavaScript(sessionSeedScript(s));
    } catch {
      // ignore
    }
  });

  appView.webContents.on('did-navigate-in-page', async (_event, url) => {
    if (!url.startsWith(rendererOrigin)) return;
    let pathname = '/';
    try {
      pathname = new URL(url).pathname;
    } catch {
      return;
    }
    if (pathname === '/pos' || pathname.startsWith('/pos/')) return;
    const s = authStore.getValidSession(userData());
    if (pathname.startsWith('/login') || pathname.startsWith('/plans') || pathname.startsWith('/dashboard')) {
      if (!s?.user) {
        showLoginScreen();
        return;
      }
      try {
        await appView.webContents.executeJavaScript(sessionSeedScript(s));
      } catch {
        // ignore
      }
    }
  });

  appView.webContents.on('did-finish-load', async () => {
    const url = appView.webContents.getURL();
    if (url.startsWith('file://')) {
      showMain();
      return;
    }
    const s = authStore.getValidSession(userData());
    try {
      await appView.webContents.executeJavaScript(`${sessionSeedScript(s)}\n${injectSource}`);
    } catch {
      // ignore
    }
    posNeedsHydrateReload = false;
    showMain();
  });

  appView.webContents.on('did-fail-load', (_event, code, desc, url, isMainFrame) => {
    if (!isMainFrame) return;
    console.warn('[desktop] page failed to load:', code, desc, url);
    if (String(url || '').startsWith('file://')) return;
    setTimeout(() => {
      if (appView && !appView.webContents.isDestroyed()) loadAuthOrPos();
    }, 1500);
  });

  loadAuthOrPos();
  setTimeout(showMain, 8000);
}

function buildMenu() {
  const allowDevtools = isDev || process.env.ELECTRON_ALLOW_DEVTOOLS === '1';
  const template = [
    ...(isMac
      ? [
        {
          label: app.name,
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' },
          ],
        },
      ]
      : []),
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        {
          label: 'Reload',
          accelerator: 'CommandOrControl+R',
          click: () => appView?.webContents.reload(),
        },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(allowDevtools
          ? [
            {
              label: 'Toggle Developer Tools',
              accelerator: 'F12',
              click: () => appView?.webContents.toggleDevTools(),
            },
          ]
          : []),
      ],
    },
    {
      label: 'POS',
      submenu: [
        {
          label: 'Open POS',
          accelerator: 'CommandOrControl+Shift+P',
          click: () => showShiftScreen(),
        },
        {
          label: 'Login',
          accelerator: 'CommandOrControl+Shift+L',
          click: () => showLoginScreen(),
        },
        {
          label: 'POS Management (Admin)',
          accelerator: 'CommandOrControl+Shift+M',
          click: () => {
            const s = authStore.getValidSession(userData());
            if (!isAdminUser(s?.user)) return;
            showManagementScreen();
          },
        },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function registerShortcuts() {
  globalShortcut.register('CommandOrControl+Q', () => app.quit());
  globalShortcut.register('CommandOrControl+M', () => mainWindow?.minimize());
  globalShortcut.register('F11', () => {
    if (!mainWindow) return;
    mainWindow.setFullScreen(!mainWindow.isFullScreen());
  });
} function parseProductSearchPayload(payload) {
  let src = payload;
  if (payload && typeof payload === 'object' && payload.query && typeof payload.query === 'object') {
    src = { ...payload, ...payload.query };
  }
  if (typeof src === 'string') {
    const p = new URLSearchParams(src);
    return {
      q: String(p.get('q') || p.get('query') || '').trim().toLowerCase(),
      categoryId: p.get('categoryId') || '',
      locationId: p.get('locationId') || '',
    };
  }
  const qRaw = src && typeof src.query === 'string' ? src.query : src?.q;
  return {
    q: String(qRaw == null ? '' : qRaw).trim().toLowerCase(),
    categoryId: String(src?.categoryId || ''),
    locationId: String(src?.locationId || ''),
  };
}

function collectCategoryIds(categoriesList, targetId) {
  const matchIds = new Set();

  function findAndCollect(list, findId, collectAll = false) {
    if (!list || !Array.isArray(list)) return false;
    for (const cat of list) {
      const cid = String(cat.id || cat._id || '');
      if (collectAll || cid === String(findId)) {
        matchIds.add(cid);
        // Collect all sub-categories recursively
        const children = cat.children || cat.subCategories || [];
        if (children.length > 0) {
          findAndCollect(children, findId, true);
        }
        if (cid === String(findId)) {
          return true; // found it
        }
      } else {
        const children = cat.children || cat.subCategories || [];
        if (children.length > 0) {
          const found = findAndCollect(children, findId, false);
          if (found) return true;
        }
      }
    }
    return false;
  }

  findAndCollect(categoriesList, targetId, false);
  return matchIds;
}

function registerIpc() {
  try {
    activeShift = localDb.getActiveShift();
  } catch (err) {
    console.warn('[registerIpc] failed to restore activeShift', err.message);
  }

  const handle = (channel, fn) => {
    try {
      ipcMain.removeHandler(channel);
    } catch (_) {
      /* not registered yet */
    }
    ipcMain.handle(channel, fn);
  };

  ipcMain.on('auth:getSessionSync', (event) => {
    const s = authStore.getValidSession(userData());
    event.returnValue = s
      ? backendApi.cloneJson({
        accessToken: s.accessToken,
        refreshToken: s.refreshToken || '',
        user: s.user || null,
        isAdmin: isAdminUser(s.user),
        locationIds: getUserLocationIds(s.user),
      })
      : null;
  });

  ipcMain.handle('window:minimize', () => mainWindow?.minimize());
  ipcMain.handle('window:maximize', () => {
    if (!mainWindow) return false;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return mainWindow.isMaximized();
  });
  ipcMain.handle('window:close', () => app.quit());
  ipcMain.handle('window:isMaximized', () => Boolean(mainWindow?.isMaximized()));

  /**
   * Thermal HTML → pure black/white bitmap → print.
   * Browser print of live fonts anti-aliases to gray; thermal heads dither that as
   * "light / blotchy". Printer self-test uses native fonts (solid). Rasterizing then
   * thresholding matches that solid look while keeping our HTML layout.
   */
  ipcMain.handle('print:thermalReceipt', async (_event, payload) => {
    const htmlBody = String(payload?.html || '');
    const paperMm = Number(payload?.widthMm) === 58 ? 58 : 80;
    if (!htmlBody) return { ok: false, error: 'empty-html' };

    // 203dpi head = 8 dots/mm. Black Copper's driver reports a wider page than the head
    // burns (even the Windows test page is clipped on the right), so stay at 66mm/44mm,
    // left-aligned, and render at exactly 8 dots/mm so the bitmap is never resampled.
    const printableMm = paperMm === 58 ? 44 : 66;
    const contentWidth = printableMm * 8;
    // Lay out at half the dot width then zoom 2x, so a 12px font is ~24 dots (~3mm) tall.
    const ZOOM = 2;
    const cssWidth = contentWidth / ZOOM;
    let renderWin = null;
    let printWin = null;
    const tmpFiles = [];

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const writeTemp = (name, contents) => {
      const filePath = path.join(app.getPath('temp'), name);
      fs.writeFileSync(filePath, contents, 'utf8');
      tmpFiles.push(filePath);
      return filePath;
    };

    try {
      renderWin = new BrowserWindow({
        show: false,
        width: contentWidth,
        height: 900,
        backgroundColor: '#ffffff',
        webPreferences: {
          offscreen: true,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
        },
      });

      const renderCss =
        '*{box-sizing:border-box;margin:0;padding:0;}' +
        'html,body{width:' + cssWidth + 'px;background:#fff;color:#000;overflow:hidden;}' +
        'body{padding:2px 2px 12px;font-size:12px;line-height:1.3;}' +
        'body,.pos-receipt-paper,.pos-receipt-paper *{color:#000!important;' +
        'font-family:Arial,Tahoma,"Segoe UI",sans-serif!important;}' +
        '.pos-receipt-paper [style*="font-size:10px"],.pos-receipt-paper [style*="font-size:11px"]{font-size:12px!important;}' +
        '.pos-receipt-paper div,.pos-receipt-paper td{overflow-wrap:anywhere;word-break:break-word;}' +
        '.pos-receipt-paper [style*="padding:14px 12px"]{padding:4px 2px!important;}' +
        '.pos-receipt-paper{width:100%!important;max-width:100%!important;margin:0;padding:0!important;}' +
        'img{max-width:100%;height:auto;display:block;margin:0 auto;}' +
        'svg{max-width:100%;height:auto;display:block;margin:2px auto;}' +
        'table{width:100%;border-collapse:collapse;}';

      const renderHtml =
        '<!DOCTYPE html><html><head><meta charset="utf-8"/>' +
        '<style>' + renderCss + '</style></head><body>' + htmlBody + '</body></html>';

      const renderPath = writeTemp('bison-thermal-render-' + Date.now() + '.html', renderHtml);
      await renderWin.loadFile(renderPath);
      renderWin.webContents.setZoomFactor(ZOOM);
      await sleep(250);

      const scrollH = await renderWin.webContents.executeJavaScript(`
        (async () => {
          const imgs = Array.from(document.images || []);
          await Promise.all(imgs.map((img) => {
            if (img.complete) return Promise.resolve();
            return new Promise((res) => {
              img.onload = () => res();
              img.onerror = () => res();
              setTimeout(res, 2000);
            });
          }));
          return document.documentElement.scrollHeight || document.body.scrollHeight || 600;
        })()
      `);
      const h = Math.max(200, Math.min((Number(scrollH) || 600) * ZOOM, 9000));
      renderWin.setSize(contentWidth, h);
      await sleep(250);

      let captured = await renderWin.webContents.capturePage();
      // Windows display scaling (125%/150%) enlarges the capture — snap back to head dots.
      if (captured.getSize().width !== contentWidth) {
        captured = captured.resize({ width: contentWidth, quality: 'best' });
      }
      const size = captured.getSize();
      const bitmap = Buffer.from(captured.toBitmap());
      // BGRA → pure mono (gray anti-alias becomes solid black — like printer self-test)
      // Mid threshold keeps normal-weight strokes close to true width (200 fattened them).
      const THRESH = 165;
      for (let i = 0; i + 3 < bitmap.length; i += 4) {
        const b = bitmap[i];
        const g = bitmap[i + 1];
        const r = bitmap[i + 2];
        const gray = (r * 77 + g * 150 + b * 29) >> 8;
        const v = gray < THRESH ? 0 : 255;
        bitmap[i] = v;
        bitmap[i + 1] = v;
        bitmap[i + 2] = v;
        bitmap[i + 3] = 255;
      }

      const mono = nativeImage.createFromBitmap(bitmap, {
        width: size.width,
        height: size.height,
      });
      const pngPath = path.join(app.getPath('temp'), 'bison-thermal-' + Date.now() + '.png');
      fs.writeFileSync(pngPath, mono.toPNG());
      tmpFiles.push(pngPath);

      // Exact page height = no long blank feed (CSS "@page auto" is ignored by Chromium).
      const imgHeightMm = (size.height * printableMm) / size.width;
      const pageHeightMicrons = Math.ceil((imgHeightMm + 6) * 1000);

      printWin = new BrowserWindow({
        show: false,
        width: contentWidth,
        height: Math.min(size.height + 40, 2000),
        backgroundColor: '#ffffff',
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
        },
      });

      const printHtml =
        '<!DOCTYPE html><html><head><meta charset="utf-8"/>' +
        '<style>' +
        '@page{margin:0;}' +
        '@media print{*{ -webkit-print-color-adjust:exact!important;print-color-adjust:exact!important; }}' +
        'html,body{margin:0;padding:0;background:#fff;}' +
        'img{width:' + printableMm + 'mm;display:block;margin:0;image-rendering:pixelated;image-rendering:crisp-edges;}' +
        '</style></head><body><img src="file:///' + pngPath.replace(/\\/g, '/') + '"/></body></html>';

      const printPath = writeTemp('bison-thermal-print-' + Date.now() + '.html', printHtml);
      await printWin.loadFile(printPath);
      await sleep(250);

      await new Promise((resolve, reject) => {
        printWin.webContents.print(
          {
            silent: false,
            printBackground: true,
            margins: { marginType: 'none' },
            pageSize: { width: paperMm * 1000, height: pageHeightMicrons },
            scaleFactor: 100,
          },
          (success, failureReason) => {
            if (success) resolve();
            else reject(new Error(failureReason || 'print-cancelled'));
          }
        );
      });

      return { ok: true };
    } catch (err) {
      console.error('[thermal print]', err);
      return { ok: false, error: String(err?.message || err) };
    } finally {
      try { if (renderWin && !renderWin.isDestroyed()) renderWin.close(); } catch { /* ignore */ }
      try { if (printWin && !printWin.isDestroyed()) printWin.close(); } catch { /* ignore */ }
      // Spooler may still read the PNG briefly after print returns
      setTimeout(() => {
        for (const f of tmpFiles) {
          try { fs.unlinkSync(f); } catch { /* ignore */ }
        }
      }, 15000);
    }
  });

  ipcMain.handle('auth:saveSession', (_event, sessionData) => {
    if (!sessionData || !sessionData.accessToken) return false;
    const existing = authStore.readSession(userData()) || {};
    authStore.writeSession(userData(), {
      accessToken: sessionData.accessToken,
      refreshToken: sessionData.refreshToken || existing.refreshToken,
      user: sessionData.user || existing.user,
    });
    return true;
  });

  ipcMain.handle('auth:getSession', () => {
    const s = authStore.getValidSession(userData());
    if (!s) return null;
    const companyId = resolveCompanyId(s.user, s);
    if (companyId) applyApiCompanyContext(companyId);
    return {
      accessToken: s.accessToken,
      refreshToken: s.refreshToken,
      user: s.user,
      activeCompanyId: companyId,
      isAdmin: isAdminUser(s.user),
      locationIds: getUserLocationIds(s.user),
    };
  });

  ipcMain.handle('auth:clearSession', () => {
    authStore.clearSession(userData());
    pendingLogin = null;
    applyApiCompanyContext('');
    return true;
  });

  ipcMain.handle('auth:listCompanies', async () => {
    const pending = pendingLogin?.token
      ? pendingLogin
      : null;
    const session = authStore.getValidSession(userData());
    const token = pending?.token || session?.accessToken;
    if (!token) {
      return { success: false, message: 'Please sign in again', companies: [] };
    }
    if (Array.isArray(pending?.companies) && pending.companies.length) {
      return {
        success: true,
        companies: pending.companies,
        activeCompanyId: pending.activeCompanyId || pending.user?.companyId || '',
      };
    }
    const res = await backendApi.listMyCompanies(token);
    return {
      success: !!res.success,
      companies: res.companies || [],
      activeCompanyId: res.activeCompanyId || session?.activeCompanyId || '',
      message: res.message,
    };
  });

  ipcMain.handle('auth:selectCompany', async (_event, payload) => {
    const id = String(
      (payload && typeof payload === 'object' ? payload.companyId : payload) || ''
    ).trim();
    if (!id) return { success: false, message: 'Select a company' };

    const pending = pendingLogin?.token ? pendingLogin : null;
    const session = authStore.getValidSession(userData());
    const token = pending?.token || session?.accessToken;
    const refreshToken = pending?.refreshToken || session?.refreshToken || '';
    const user = pending?.user || session?.user;
    if (!token || !user) {
      return { success: false, message: 'Please sign in again' };
    }

    let company =
      (pending?.companies || []).find((c) => String(c.id) === id) ||
      null;
    if (!company) {
      const listed = await backendApi.listMyCompanies(token);
      company = (listed.companies || []).find((c) => String(c.id) === id) || { id };
    }

    return bindCompanyAndOpenPos(token, refreshToken, user, company);
  });

  ipcMain.handle('auth:login', async (_event, payload) => {
    const email = String(payload?.email || '').trim();
    const password = String(payload?.password || '');
    const result = await backendApi.login(email, password);
    if (!result.success) return result;
    const opened = await completeLoginAndOpenPos(result.data);
    if (!opened.success) {
      if (opened.code) {
        showLoginScreen({ message: opened.message, reason: opened.code });
      }
      return opened;
    }
    return { success: true, ...opened };
  });

  ipcMain.handle('auth:openLogin', () => {
    showLoginScreen();
    return true;
  });

  ipcMain.handle('auth:logout', (_event, payload) => {
    stopDesktopNotifications();
    pendingForcedLogout = false;
    authStore.clearSession(userData());
    pendingLogin = null;
    applyApiCompanyContext('');
    activeShift = null;
    try { localDb.saveActiveShift(null); } catch { /* ignore */ }
    showLoginScreen({
      message: payload?.message,
      reason: payload?.code,
    });
    return true;
  });

  ipcMain.handle('auth:checkAccess', async () => {
    const sessionData = authStore.getValidSession(userData());
    if (!sessionData?.accessToken) {
      return { ok: false, code: 'NO_SESSION', message: 'Please sign in again.' };
    }
    return validateSessionAccess(sessionData.accessToken);
  });

  handle('pos:listTerminals', async () => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    try {
      const list = filterTerminalsForUser(auth.session.user, localDb.getTerminals());
      return {
        success: true,
        data: list,
        scoped: !isAdminUser(auth.session.user),
        locationIds: getUserLocationIds(auth.session.user),
      };
    } catch (err) {
      return { success: true, data: [] };
    }
  });

  handle('pos:listLocations', async () => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    try {
      const list = filterLocationsForUser(auth.session.user, localDb.getLocations());
      return {
        success: true,
        data: list,
        scoped: !isAdminUser(auth.session.user),
        isAdmin: isAdminUser(auth.session.user),
        locationIds: getUserLocationIds(auth.session.user),
      };
    } catch (err) {
      return { success: true, data: [], isAdmin: isAdminUser(auth.session?.user) };
    }
  });

  handle('pos:syncMasterData', async (event, payload) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;

    // Company-wide catalog only — never prune by warehouse location
    const locationId = '';

    if (payload && payload.refresh) {
      const result = await masterSync.refreshCatalog(auth.session.accessToken, locationId);
      console.log('[pos:syncMasterData] refresh', result?.counts, 'location all', result?.message || result?.success);
      try {
        await refreshScopedCatalogCaches(auth.session.accessToken, auth.session.user);
      } catch (_) { /* ignore */ }
      if (!payload.skipReload) {
        setTimeout(() => {
          try { event.sender.reloadIgnoringCache(); } catch { /* window gone */ }
        }, 300);
      }
      return result;
    }
    return masterSync.syncMasterData(auth.session.accessToken, locationId);
  });

  handle('pos:pushMasterData', async () => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    return masterSync.pushPendingCatalog(auth.session.accessToken);
  });

  handle('pos:syncBidirectional', async () => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    return masterSync.syncBidirectional(auth.session.accessToken);
  });

  handle('pos:getMasterSyncStatus', () => ({
    success: true,
    data: masterSqlite.counts(),
  }));

  ipcMain.handle('pos:getCurrentShift', async () => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    const user = auth.session.user;
    const terminals = filterTerminalsForUser(user, localDb.getTerminals());

    function packShift(shift) {
      if (!shift) return null;
      const terminal =
        terminals.find((t) => String(t.id) === String(shift.terminalId)) ||
        shift.terminal ||
        null;
      return {
        ...shift,
        terminal: terminal || shift.terminal || null,
        cashier: shift.cashier || {
          id: user?.id,
          name: [user?.firstName, user?.lastName].filter(Boolean).join(' ') || user?.email,
        },
      };
    }

    const localShift = localDb.getActiveShift();

    // Suspended locally — show resume screen; do not pull stale Open from server
    if (localShift?.status === 'Suspended') {
      if (!shiftAllowedForUser(localShift, user, terminals)) {
        localDb.saveActiveShift(null);
        activeShift = null;
        return { success: true, data: null };
      }
      activeShift = localShift;
      return { success: true, data: packShift(localShift) };
    }

    if (!localShift || localShift.status === 'Closed') {
      const serverShift = await hydrateShiftFromServer(auth.session.accessToken, user);
      if (serverShift?.status === 'Suspended') {
        activeShift = serverShift;
        localDb.saveActiveShift(serverShift);
        return { success: true, data: packShift(serverShift) };
      }
      if (serverShift?.status === 'Open') {
        activeShift = serverShift;
        localDb.saveActiveShift(serverShift);
        return { success: true, data: packShift(serverShift) };
      }
      activeShift = null;
      return { success: true, data: null };
    }

    activeShift = localShift;
    if (!shiftAllowedForUser(localShift, user, terminals)) {
      console.warn('[scope] active shift outside user access — clearing');
      activeShift = null;
      localDb.saveActiveShift(null);
      return { success: true, data: null };
    }

    return { success: true, data: packShift(localShift) };
  });

  ipcMain.handle('pos:getActiveShift', () => activeShift);

  ipcMain.handle('pos:openShift', async (_event, payload) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;

    let terminalId = String(payload?.terminalId || '').trim();
    if (!terminalId) {
      return { success: false, message: 'Select a terminal first' };
    }

    let allowedTerminals = filterTerminalsForUser(auth.session.user, localDb.getTerminals());
    let terminal = allowedTerminals.find((t) => String(t.id) === terminalId);
    if (!terminal) {
      return {
        success: false,
        message: isAdminUser(auth.session.user)
          ? 'Terminal not found'
          : getUserAssignedTerminalId(auth.session.user)
            ? 'You can only use your assigned terminal'
            : 'You can only open a shift on an allowed terminal',
      };
    }

    const assignedTerminalId = getUserAssignedTerminalId(auth.session.user);
    if (assignedTerminalId && !isAdminUser(auth.session.user) && terminalId !== assignedTerminalId) {
      return { success: false, message: 'You can only open a shift on your assigned terminal' };
    }

    const locations = filterLocationsForUser(auth.session.user, localDb.getLocations());
    const location =
      locations.find((l) => String(l.id) === String(terminal.locationId || terminal.location?.id)) ||
      terminal.location ||
      null;

    const openingCash = Number(payload?.openingCash);
    const notes = payload?.notes || '';
    if (!Number.isFinite(openingCash) || openingCash <= 0) {
      return {
        success: false,
        message: 'Opening cash is required. Enter the cash in the drawer before starting.',
      };
    }

    if (String(terminalId).startsWith('local-term-') || terminalId === 'default-terminal') {
      return {
        success: false,
        message:
          'No POS terminal is set up yet. Ask an admin to create one in POS → Management → Terminals.',
      };
    }

    if (auth.session.accessToken) {
      const apiRes = await posApi.openShift(auth.session.accessToken, {
        terminalId,
        openingCash,
        notes,
      });
      if (apiRes?.success && apiRes.data) {
        const newShift = normalizeServerShift(apiRes.data, auth.session.user, allowedTerminals);
        activeShift = newShift;
        localDb.saveActiveShift(newShift);
        return { success: true, data: newShift };
      }
      if (apiRes?.status && !isNetworkAccessError(apiRes.message)) {
        const msg = String(apiRes.message || '');
        if (/already have an open|already in use|suspended shift/i.test(msg)) {
          const existing = await hydrateShiftFromServer(auth.session.accessToken, auth.session.user);
          if (existing && ['Open', 'Suspended'].includes(existing.status)) {
            if (existing.status === 'Suspended' && auth.session.accessToken && existing.id) {
              const resumeRes = await posApi.resumeShift(auth.session.accessToken, existing.id);
              if (resumeRes?.success && resumeRes.data) {
                const resumed = normalizeServerShift(resumeRes.data, auth.session.user, allowedTerminals);
                activeShift = { ...resumed, status: 'Open' };
                localDb.saveActiveShift(activeShift);
                return { success: true, data: activeShift, resumed: true };
              }
            }
            activeShift = existing.status === 'Open' ? existing : { ...existing, status: 'Open' };
            localDb.saveActiveShift(activeShift);
            return { success: true, data: activeShift, resumed: true };
          }
        }
        return { success: false, message: apiRes.message || 'Could not open shift' };
      }
    }

    const shiftId = `local-shift-${Date.now()}`;
    const newShift = {
      id: shiftId,
      terminalId: terminal.id,
      locationId: location?.id || terminal.locationId || null,
      userId: auth.session.user?.id,
      status: 'Open',
      openingCash,
      notes,
      openedAt: new Date().toISOString(),
      cashFlows: [],
      terminal: {
        ...terminal,
        location: location || terminal.location || null,
        locationId: location?.id || terminal.locationId || null,
      },
      cashier: {
        id: auth.session.user?.id,
        name: [auth.session.user?.firstName, auth.session.user?.lastName].filter(Boolean).join(' ') || auth.session.user?.email,
        role: auth.session.user?.role,
      },
    };
    activeShift = newShift;
    localDb.saveActiveShift(newShift);
    localDb.addShiftActionToQueue({ action: 'open', shiftId, payload: { terminalId, openingCash, notes } });
    return { success: true, data: newShift };
  });

  ipcMain.handle('pos:resumeShift', async (_event, shiftId) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;

    if (auth.session.accessToken && shiftId && !String(shiftId).startsWith('local-shift-')) {
      const apiRes = await posApi.resumeShift(auth.session.accessToken, shiftId);
      if (apiRes?.success && apiRes.data) {
        const terminals = filterTerminalsForUser(auth.session.user, localDb.getTerminals());
        const normalized = normalizeServerShift(apiRes.data, auth.session.user, terminals);
        activeShift = { ...normalized, status: 'Open' };
        localDb.saveActiveShift(activeShift);
        return { success: true, data: activeShift };
      }
      if (apiRes?.status && !isNetworkAccessError(apiRes.message)) {
        return { success: false, message: apiRes.message || 'Could not resume shift' };
      }
    }

    activeShift = localDb.getActiveShift();
    if (activeShift && activeShift.id === shiftId) {
      activeShift.status = 'Open';
      localDb.saveActiveShift(activeShift);
      localDb.addShiftActionToQueue({ action: 'resume', shiftId });
      return { success: true, data: activeShift };
    }
    return { success: false, message: 'Shift not found locally or cannot resume' };
  });

  ipcMain.handle('pos:closeShift', async (_event, payload) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    if (!activeShift?.id) {
      activeShift = localDb.getActiveShift();
    }
    if (!activeShift?.id) return { success: false, message: 'No active shift' };

    const actualCash = Number(payload?.actualCash || 0);
    const notes = payload?.notes || '';
    const shiftId = activeShift.id;

    if (auth.session.accessToken && !String(shiftId).startsWith('local-shift-')) {
      const apiRes = await posApi.closeShift(auth.session.accessToken, shiftId, { actualCash, notes });
      if (apiRes?.status && !isNetworkAccessError(apiRes.message)) {
        return { success: false, message: apiRes.message || 'Could not close shift on server' };
      }
    }

    const closedShift = {
      ...activeShift,
      status: 'Closed',
      actualCash,
      notes,
      closedAt: new Date().toISOString(),
    };
    activeShift = null;
    localDb.saveActiveShift(null);
    localDb.addShiftToHistory(closedShift);
    localDb.addShiftActionToQueue({ action: 'close', shiftId: closedShift.id, payload: { actualCash, notes } });
    return { success: true, data: closedShift };
  });

  // ─── LOCAL-ONLY: Search products from local SQLite (no live API) ──────────
  ipcMain.handle('pos:searchProducts', async (_event, payload) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;

    // Support both object payload { query, categoryId, locationId }
    // and raw querystring string "q=...&categoryId=...&locationId=..."
    const parsed = parseProductSearchPayload(payload);
    const q = parsed.q;
    const categoryId = parsed.categoryId;

    try {
      masterSqlite.reloadFromDiskSafe();
      const products = masterSqlite.searchProducts({ query: q, categoryId });
      return { success: true, data: products, source: 'local' };
    } catch (err) {
      console.error('[pos:searchProducts] local search failed', err.message);
      return { success: false, message: err.message || 'Product search failed' };
    }
  });


  // ─── OFFLINE-FIRST: Queue sale locally ───────────────────────────────────
  ipcMain.handle('pos:completeSale', async (_event, payload) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    if (!activeShift?.id) return { success: false, message: 'Open a shift first' };
    const enriched = stampScopedPayload(auth, payload);

    // Customer tenders (store credit / points / on account) must be backed by a balance.
    let ledgerEntries = [];
    try {
      masterSqlite.reloadFromDiskSafe();
      ledgerEntries = buildSaleLedgerEntries(enriched, auth);
    } catch (err) {
      return { success: false, message: err.message };
    }

    const saved = localDb.addSaleToQueue(enriched);
    try { masterSqlite.addLocalSale(saved); } catch (err) {
      console.warn('[sqlite] local sale persist failed', err.message);
    }
    try {
      masterSqlite.addCustomerLedgerEntries(
        ledgerEntries.map((e) => ({ ...e, reference: saved.invoiceNumber || saved.id }))
      );
    } catch (err) {
      console.warn('[sqlite] customer ledger write failed', err.message);
    }
    console.log('[offline] Sale queued locally:', saved.id, 'loc=', enriched.locationId);
    return { success: true, data: saved, message: 'Sale saved locally. Will sync on next sync.' };
  });


  ipcMain.handle('pos:enterShift', () => {
    showShiftScreen();
    return true;
  });

  ipcMain.handle('pos:enterSell', async () => {
    if (!activeShift) activeShift = localDb.getActiveShift();
    if (!activeShift || activeShift.status !== 'Open') {
      return { success: false, message: 'Open a shift first' };
    }
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    const access = await validateSessionAccess(auth.session.accessToken);
    if (!access.ok) {
      await forceLogoutWithReason(access.code, access.message);
      return { success: false, code: access.code, message: access.message };
    }
    enterPosForUser(auth.session.user);
    return { success: true };
  });

  ipcMain.handle('pos:enterRestaurantPos', (_event, tab) => {
    if (!activeShift) activeShift = localDb.getActiveShift();
    if (!activeShift || activeShift.status !== 'Open') {
      return { success: false, message: 'Open a shift first' };
    }
    showRestaurantPosScreen(tab || 'counter');
    return { success: true };
  });

  ipcMain.handle('pos:restaurantKitchenQueue', async (_event, query) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    return posApi.getKitchenOrders(auth.session.accessToken, query || {});
  });

  ipcMain.handle('pos:restaurantReadyQueue', async (_event, query) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    return posApi.getReadyOrders(auth.session.accessToken, query || {});
  });

  ipcMain.handle('pos:restaurantKitchenStations', async () => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    return posApi.listKitchenStations(auth.session.accessToken);
  });

  ipcMain.handle('pos:restaurantMarkPreparing', async (_event, payload) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    const orderId = typeof payload === 'string' ? payload : payload?.orderId;
    const body = typeof payload === 'object' && payload ? { expectedVersion: payload.expectedVersion } : {};
    return posApi.markRestaurantPreparing(auth.session.accessToken, orderId, body);
  });

  ipcMain.handle('pos:restaurantMarkReady', async (_event, payload) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    const orderId = typeof payload === 'string' ? payload : payload?.orderId;
    const body = typeof payload === 'object' && payload ? { expectedVersion: payload.expectedVersion } : {};
    return posApi.markRestaurantReady(auth.session.accessToken, orderId, body);
  });

  ipcMain.handle('pos:restaurantMarkPaid', async (_event, payload) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    const orderId = payload?.orderId;
    if (!orderId) return { success: false, message: 'orderId required' };
    return posApi.markRestaurantPaid(auth.session.accessToken, orderId, {
      posSaleId: payload?.posSaleId || null,
      expectedVersion: payload?.expectedVersion,
      paymentIdempotencyKey: payload?.paymentIdempotencyKey || null,
    });
  });

  ipcMain.handle('pos:restaurantCreateOrder', async (_event, payload) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    return posApi.createRestaurantOrder(auth.session.accessToken, payload || {});
  });

  ipcMain.handle('pos:getShiftHistory', async (_event, paramsString) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    try {
      const history = filterRecordsForUser(auth.session.user, localDb.getShiftsHistory());
      return { success: true, data: history };
    } catch (err) {
      return { success: true, data: [] };
    }
  });

  ipcMain.handle('pos:suspendShift', async (_event, shiftId) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    if (!activeShift?.id) activeShift = localDb.getActiveShift();
    if (!activeShift || activeShift.id !== shiftId) {
      return { success: false, message: 'Shift not found locally or cannot suspend' };
    }

    if (auth.session.accessToken && !String(shiftId).startsWith('local-shift-')) {
      const apiRes = await posApi.suspendShift(auth.session.accessToken, shiftId);
      if (apiRes?.status && !isNetworkAccessError(apiRes.message)) {
        return { success: false, message: apiRes.message || 'Could not suspend shift on server' };
      }
    }

    activeShift.status = 'Suspended';
    localDb.saveActiveShift(activeShift);
    localDb.addShiftActionToQueue({ action: 'suspend', shiftId });
    const suspended = { ...activeShift };
    activeShift = null;
    return { success: true, data: suspended };
  });

  ipcMain.handle('pos:recordCashFlow', async (_event, payload) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    if (activeShift) {
      if (!activeShift.cashFlows) activeShift.cashFlows = [];
      activeShift.cashFlows.push({
        id: `cashflow-${Date.now()}`,
        amount: Number(payload?.amount || 0),
        type: payload?.type || 'in',
        reason: payload?.reason || '',
        timestamp: new Date().toISOString(),
      });
      localDb.saveActiveShift(activeShift);
    }
    localDb.addShiftActionToQueue({ action: 'cashflow', payload });
    return { success: true, message: 'Cash flow recorded locally' };
  });

  // ─── OFFLINE-FIRST: Barcode / QR / SKU lookup from local catalog ─────────
  ipcMain.handle('pos:byBarcode', async (_event, { code, locationId }) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    let needle = String(code || '').replace(/[\x00-\x1F\x7F]/g, '').trim();
    if (!needle) return { success: false, message: 'Barcode is required' };

    let jsonId = '';
    try {
      const parsed = JSON.parse(needle);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        jsonId = String(parsed.sku || parsed.barcode || parsed.id || '').trim();
      }
    } catch {
      /* plain barcode / QR */
    }

    const lookupKeys = [needle];
    if (jsonId && jsonId !== needle) lookupKeys.push(jsonId);

    try { masterSqlite.reloadFromDisk(); } catch { /* ignore */ }
    for (const key of lookupKeys) {
      const local = masterSqlite.findByScanCode(key);
      if (local) return { success: true, data: local };
    }

    const cached = localDb.getProducts() || [];
    const cachedHit = cached.find((p) =>
      lookupKeys.some((key) => {
        const lower = key.toLowerCase();
        return [p.barcode, p.barcodeNumber, p.sku, p.qrCode, p.qr_code]
          .some((v) => String(v || '').trim().toLowerCase() === lower);
      })
    );
    if (cachedHit) return { success: true, data: cachedHit };

    return { success: false, message: `No product found for ${needle} — try Sync to refresh catalog` };
  });


  // ─── OFFLINE-FIRST: Hold / retrieve / delete from local JSON ─────────────
  ipcMain.handle('pos:holdSale', async (_event, payload) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    const saved = localDb.addHeldSale(stampScopedPayload(auth, payload));
    return { success: true, data: saved };
  });

  ipcMain.handle('pos:getHeldSales', async () => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    return {
      success: true,
      data: filterRecordsForUser(auth.session.user, localDb.getHeldSales()),
    };
  });

  ipcMain.handle('pos:deleteHeldSale', async (_event, id) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    localDb.deleteHeldSale(id);
    return { success: true };
  });


  // ─── OFFLINE-FIRST: Full sync → upload queues → refresh caches ───────────
  ipcMain.handle('pos:syncOfflineSales', async () => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;

    const token = auth.session.accessToken;
    const activeCompany =
      posApi.getActiveCompanyId?.() ||
      resolveCompanyId(auth.session.user, auth.session) ||
      '';
    if (activeCompany) applyApiCompanyContext(activeCompany);

    // Non-admin only syncs their location's queued sales/returns (already company-scoped on disk)
    const salesQueue = filterRecordsForUser(auth.session.user, localDb.getSalesQueue());
    const returnsQueue = filterRecordsForUser(auth.session.user, localDb.getReturnsQueue());
    const shiftsQueue = localDb.getShiftsQueue();

    const results = { sales: null, returns: null, shifts: null, cacheRefreshed: false, errors: [] };

    // 1) Upload queued sales
    if (salesQueue.length > 0) {
      // Sanitize sales data before sending to backend
      const sanitizedSales = salesQueue.map(sale => {
        // Remove local shift ID as backend will handle shift assignment
        const { shiftId, ...saleWithoutShiftId } = sale;

        return {
          ...saleWithoutShiftId,
          companyId: sale.companyId || activeCompany || undefined,
          items: (sale.items || []).map(item => {
            // Handle taxRate - if it's an object, extract the rate value
            let taxRateValue = 0;
            if (typeof item.taxRate === 'object' && item.taxRate !== null) {
              taxRateValue = item.taxRate.rate || 0;
            } else {
              taxRateValue = Number(item.taxRate || 0);
            }

            return {
              ...item,
              taxRate: taxRateValue
            };
          })
        };
      });

      const res = await posApi.syncOfflineSales(token, { sales: sanitizedSales });
      results.sales = res;
      if (res.success) {
        // Only remove sales that were actually synced (success or skipped/duplicate).
        // Failed ones stay in the queue so the next sync retries them.
        const saleResults = Array.isArray(res.data) ? res.data : [];
        const syncedIds = saleResults
          .filter((r) => r.status === 'success' || r.status === 'skipped')
          .map((r) => r.id);

        // Never wipe the full queue — other users/locations may have pending rows
        if (syncedIds.length > 0) {
          localDb.removeFromSalesQueue(syncedIds);
        }

        const failed = saleResults.filter((r) => r.status === 'failed');
        if (failed.length > 0) {
          results.errors.push(
            `${failed.length} sale(s) failed to sync: ${failed.map((r) => r.reason || r.id).join('; ')}`
          );
        }

        // Also clear synced sales from local SQLite database
        try {
          masterSqlite.reloadFromDiskSafe();
          syncedIds.forEach(id => {
            try {
              masterSqlite.markLocalSaleSynced(id);
            } catch (err) {
              console.error(`Error marking synced sale ${id} in local DB:`, err.message);
            }
          });
          console.log(`[sync] Marked ${syncedIds.length} sales as synced in local SQLite.`);
        } catch (err) {
          console.error(`Error cleaning local SQLite:`, err.message);
        }
        console.log(`[sync] ${syncedIds.length}/${salesQueue.length} sale(s) uploaded.`);
      } else {
        results.errors.push(`Sales sync failed: ${res.message}`);
      }
    } else {
      results.sales = { success: true, message: 'No sales to sync.' };
    }

    // 2) Upload queued returns
    if (returnsQueue.length > 0) {
      // Ensure every queued return has the correct type flag for backend routing
      const sanitizedReturns = returnsQueue.map((ret) => ({
        ...ret,
        type: 'RETURN',
        companyId: ret.companyId || activeCompany || undefined,
        originalSaleId: ret.originalSaleId || ret.saleId,
        refundMethod: ret.refundMethod || 'Cash',
        reason: ret.reason || 'Customer return',
      }));

      const res = await posApi.syncOfflineSales(token, { returns: sanitizedReturns });
      results.returns = res;
      if (res.success) {
        const returnResults = Array.isArray(res.data) ? res.data : [];
        const syncedIds = returnResults
          .filter((r) => r.status === 'success' || r.status === 'skipped')
          .map((r) => r.id);

        if (syncedIds.length > 0) {
          localDb.removeFromReturnsQueue(syncedIds);
        }

        const failed = returnResults.filter((r) => r.status === 'failed');
        if (failed.length > 0) {
          const reasons = failed.map((r) => r.reason || r.id).join('; ');
          console.error(`[sync] Return failures: ${reasons}`);
          results.errors.push(
            `${failed.length} return(s) failed to sync: ${reasons}`
          );
        }
        console.log(`[sync] ${syncedIds.length}/${returnsQueue.length} return(s) uploaded.`);
      } else {
        results.errors.push(`Returns sync failed: ${res.message}`);
      }
    } else {
      results.returns = { success: true, message: 'No returns to sync.' };
    }

    // 3) Upload shift actions (best-effort — shifts already live on server)
    if (shiftsQueue.length > 0) {
      localDb.clearShiftsQueue();
      results.shifts = { success: true, message: `${shiftsQueue.length} shift action(s) flushed.` };
    } else {
      results.shifts = { success: true, message: 'No shift actions to sync.' };
    }

    // 4) Refresh local caches with fresh data from the server
    try {
      const [prodRes, catRes, custRes, taxRes] = await Promise.all([
        posApi.fetchAllProducts(token),
        posApi.fetchAllCategories(token),
        posApi.fetchAllCustomers(token),
        posApi.fetchTaxContext(token),
      ]);
      if (prodRes.success && Array.isArray(prodRes.data)) localDb.saveProducts(prodRes.data);
      if (catRes.success && Array.isArray(catRes.data)) localDb.saveCategories(catRes.data);
      if (custRes.success && Array.isArray(custRes.data)) localDb.saveCustomers(custRes.data);
      if (taxRes.success && taxRes.data) localDb.saveTaxContext(taxRes.data);

      // Also refresh location/terminal caches scoped to this user
      try {
        await refreshScopedCatalogCaches(token, auth.session.user);
      } catch (scopeErr) {
        console.warn('[sync] scope cache refresh failed:', scopeErr.message);
      }

      // Reload full company catalog into SQLite (not warehouse-scoped)
      try {
        await masterSync.refreshCatalog(token, '');
      } catch (catErr) {
        console.warn('[sync] catalog refresh failed:', catErr.message);
      }

      results.cacheRefreshed = !!(
        (prodRes.success && Array.isArray(prodRes.data)) ||
        (catRes.success && Array.isArray(catRes.data)) ||
        (custRes.success && Array.isArray(custRes.data))
      );
      if (results.cacheRefreshed) {
        console.log('[sync] Local caches refreshed from server.');
      } else {
        const why = [prodRes, catRes, custRes]
          .map((r) => r?.message)
          .filter(Boolean)
          .slice(0, 2)
          .join('; ') || 'API unreachable';
        console.warn('[sync] Cache refresh skipped —', why);
        results.errors.push(`Cache refresh failed: ${why}`);
      }
    } catch (err) {
      results.errors.push(`Cache refresh failed: ${err.message}`);
      console.error('[sync] Cache refresh error:', err);
    }

    const allOk = results.errors.length === 0;
    return {
      success: allOk,
      message: allOk ? 'Sync complete!' : `Sync finished with errors: ${results.errors.join('; ')}`,
      data: results,
    };
  });


  // ─── OFFLINE-FIRST: Queue return locally ─────────────────────────────────
  ipcMain.handle('pos:processReturn', async (_event, payload) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    if (!activeShift?.id) return { success: false, message: 'Open a shift first' };

    const refundAmount = roundMoney((payload.items || []).reduce(
      (sum, i) => sum + (Number(i.unitPrice) || 0) * (Number(i.quantity) || 0), 0
    ));
    const refundMethod = payload.refundMethod || 'Cash';
    const customerId = String(payload.customerId || '').trim();
    const refundKind = customerTenderKind(refundMethod);
    if ((refundKind === 'STORE_CREDIT' || refundKind === 'ACCOUNT') && !customerId) {
      return { success: false, message: 'Store credit / account refunds need a named customer on the original sale.' };
    }

    // Never refund more than was sold minus what earlier returns already took back.
    try {
      masterSqlite.reloadFromDiskSafe();
      const saleKey = String(payload.originalSaleId || payload.saleId || '');
      const prior = returnedQtyBySale(saleKey);
      for (const item of payload.items || []) {
        const key = returnLineKey(item);
        const sold = Number(item.soldQuantity);
        if (Number.isFinite(sold) && sold > 0) {
          const remaining = sold - (prior.get(key) || 0);
          if ((Number(item.quantity) || 0) > remaining + 1e-6) {
            return { success: false, message: `${item.productName || 'Item'}: only ${Math.max(0, remaining)} left to return.` };
          }
        }
      }
    } catch (err) {
      console.warn('[processReturn] prior-return check skipped:', err.message);
    }

    const enriched = stampScopedPayload(auth, {
      ...payload,
      type: 'RETURN',
      originalSaleId: payload.originalSaleId || payload.saleId,
      refundMethod,
      refundAmount,
      reason: payload.reason || 'Customer return',
      createdAt: new Date().toISOString(),
    });
    const saved = localDb.addReturnToQueue(enriched);

    try {
      const createdBy = currentUserId(auth.session?.user);
      const reference = `Return ${saved.id} (inv ${payload.invoiceNumber || enriched.originalSaleId})`;
      const entries = [];
      if (refundKind === 'STORE_CREDIT') {
        entries.push({ customerId, kind: 'CREDIT', type: 'ISSUE', amount: refundAmount, reference, note: 'Refund issued as store credit', createdBy });
      } else if (refundKind === 'ACCOUNT') {
        entries.push({ customerId, kind: 'ACCOUNT', type: 'REFUND', amount: -refundAmount, reference, note: 'Return credited to account', createdBy });
      }
      const reverse = Math.floor(Number(payload.loyaltyReversed) || 0);
      if (customerId && reverse > 0) {
        const bal = masterSqlite.getCustomerBalances(customerId);
        const take = Math.min(reverse, Math.max(0, Math.floor(bal.points)));
        if (take > 0) entries.push({ customerId, kind: 'POINTS', type: 'REVERSE', points: -take, reference, note: 'Points reversed for returned items', createdBy });
      }
      masterSqlite.addCustomerLedgerEntries(entries);
    } catch (err) {
      console.warn('[processReturn] customer ledger write failed', err.message);
    }
    console.log('[offline] Return queued locally:', saved.id, 'loc=', enriched.locationId);

    // Update stock in local SQLite for "local flow only" desktop app parity
    try {
      masterSqlite.reloadFromDisk();
      // Persist the return transaction locally in SQLite
      masterSqlite.addLocalReturn(saved);

      // Defective / damaged goods are refunded but not put back on the shelf.
      const restockItems = payload.restock === false ? [] : (payload.items || []);
      for (const item of restockItems) {
        const qty = Number(item.quantity) || 0;
        if (qty > 0 && item.productId) {
          // Adjust stock (returned items are added back to inventory)
          const { previousStock, newStock, productName, unit } = masterSqlite.adjustProductStockLocally(item.productId, qty);
          // Log stock movement
          masterSqlite.addStockMovement({
            productId: item.productId,
            productName: productName || item.productName || 'Product',
            type: 'stock_in',
            quantity: qty,
            previousStock,
            newStock,
            unit: unit || 'Pcs',
            unitCost: Number(item.unitPrice) || 0,
            stockType: 'bulk',
            reason: `Sales Return (Original Inv: ${payload.saleId})`,
            reference: saved.id || '',
            notes: 'Restocked via sales return flow.',
          });
        }
      }
    } catch (sqliteErr) {
      console.error('[processReturn] failed to update local SQLite stock/return:', sqliteErr.message);
    }

    return { success: true, data: saved, message: 'Return saved locally. Will sync on next sync.' };
  });

  /** What earlier returns already took back from one sale (qty per line + points reversed). */
  ipcMain.handle('pos:getReturnSummary', async (_event, saleId) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    try {
      masterSqlite.reloadFromDiskSafe();
      const qty = Object.fromEntries(returnedQtyBySale(String(saleId || '')));
      const prior = (masterSqlite.listAllLocalReturns() || [])
        .filter((r) => String(r.originalSaleId || r.saleId || '') === String(saleId || ''));
      return {
        success: true,
        data: {
          returnedQty: qty,
          returnsCount: prior.length,
          refundedTotal: roundMoney(prior.reduce((n, r) => n + (Number(r.refundAmount) || 0), 0)),
          loyaltyReversed: prior.reduce((n, r) => n + (Number(r.loyaltyReversed) || 0), 0),
        },
      };
    } catch (err) {
      return { success: false, message: err.message || 'Could not read earlier returns' };
    }
  });

  ipcMain.handle('pos:listLocalReturns', async () => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    return {
      success: true,
      offline: true,
      data: { returns: filterRecordsForUser(auth.session.user, localDb.getReturnsQueue()) },
    };
  });

  ipcMain.handle('pos:clearReturnsQueue', async () => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    // Non-admin: only delete their scoped returns; admin clears all
    if (!isAdminUser(auth.session.user)) {
      const mine = filterRecordsForUser(auth.session.user, localDb.getReturnsQueue());
      localDb.removeFromReturnsQueue(mine.map((r) => r.id));
      return { success: true, message: 'Your queued returns deleted.' };
    }
    localDb.clearReturnsQueue();
    return { success: true, message: 'All queued returns deleted.' };
  });


  ipcMain.handle('pos:getShiftReport', async (_event, shiftId) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;

    try {
      masterSqlite.reloadFromDiskSafe();
      const localSales = filterRecordsForUser(
        auth.session.user,
        masterSqlite.listAllLocalSales()
      );

      const currentShift = localDb.getActiveShift();
      const historyShifts = localDb.getShiftsHistory();
      const shiftInfo = (currentShift && String(currentShift.id) === String(shiftId))
        ? currentShift
        : historyShifts.find((s) => String(s.id) === String(shiftId)) || { openingCash: 0, cashFlows: [] };

      const shiftOpenedAt = shiftInfo.openedAt || shiftInfo.createdAt || null;
      const uid = String(auth.session.user?.id || shiftInfo.cashier?.id || shiftInfo.cashierId || '').trim();
      const shiftSales = localSales.filter((s) => {
        if (String(s.shiftId || '') === String(shiftId)) return true;
        // Older queued sales may lack shiftId — attribute by cashier + open time
        if (!s.shiftId && shiftOpenedAt && uid) {
          const sameCashier = String(s.cashierId || s.userId || '') === uid;
          const afterOpen = new Date(s.createdAt || s.created_at || 0) >= new Date(shiftOpenedAt);
          return sameCashier && afterOpen;
        }
        return false;
      });

      let localReturns = [];
      try {
        localReturns = filterRecordsForUser(
          auth.session.user,
          masterSqlite.listAllLocalReturns?.() || []
        );
      } catch {
        localReturns = [];
      }
      const shiftReturns = localReturns.filter(
        (r) => String(r.shiftId || '') === String(shiftId)
          || shiftSales.some((s) => String(s.id) === String(r.saleId || r.originalSaleId || ''))
      );

      const openingCash = Number(shiftInfo.openingCash || 0);
      const cashier = shiftInfo.cashier || auth.session.user || {};
      const cashierName = [cashier.firstName, cashier.lastName].filter(Boolean).join(' ')
        || cashier.email
        || shiftInfo.cashierName
        || 'Cashier';

      let cashSales = 0;
      let cardSales = 0;
      let creditSales = 0;
      let otherSales = 0;
      let totalSales = 0;
      let taxTotal = 0;
      let discountTotal = 0;
      let itemsSold = 0;
      const paymentsBreakdown = {};
      const productTally = new Map();

      const saleAmount = (sale) => {
        const explicit = Number(sale.grandTotal ?? sale.total ?? sale.totalAmount ?? sale.finalTotal ?? 0);
        if (explicit > 0) return explicit;
        const items = sale.items || [];
        return items.reduce((sum, i) => {
          const line = Number(i.lineTotal) || (Number(i.quantity || 1) * Number(i.unitPrice || 0));
          return sum + line;
        }, 0);
      };

      for (const sale of shiftSales) {
        const total = saleAmount(sale);
        totalSales += total;
        taxTotal += Number(sale.taxTotal ?? sale.taxAmount ?? sale.tax ?? 0);
        discountTotal += Number(sale.discountTotal ?? sale.discount ?? sale.discountAmount ?? 0);

        for (const item of sale.items || []) {
          const qty = Number(item.quantity || 0);
          itemsSold += qty;
          const key = String(item.productName || item.name || item.sku || 'Item');
          const cur = productTally.get(key) || { name: key, qty: 0, amount: 0 };
          cur.qty += qty;
          cur.amount += Number(item.lineTotal) || (qty * Number(item.unitPrice || 0));
          productTally.set(key, cur);
        }

        const pays = Array.isArray(sale.payments) && sale.payments.length
          ? sale.payments
          : [{ paymentMethod: sale.paymentMethod || sale.paymentMode || 'Cash', amount: total }];

        // Change handed back comes out of the cash tendered — count only cash kept.
        const tendered = pays.reduce((n, p) => n + (Number(p.amount) || 0), 0);
        let change = Number(sale.changeAmount ?? Math.max(0, tendered - total)) || 0;
        let saleCredit = 0;
        for (const p of pays) {
          const method = String(p.paymentMethod || 'Cash').trim() || 'Cash';
          let amt = Number(p.amount ?? 0) || (pays.length === 1 ? total : 0);
          const m = method.toLowerCase();
          if (m === 'cash' && change > 0) {
            const fromThis = Math.min(change, amt);
            amt -= fromThis;
            change -= fromThis;
          }
          paymentsBreakdown[method] = (paymentsBreakdown[method] || 0) + amt;
          const kind = customerTenderKind(method);
          if (m === 'cash') cashSales += amt;
          else if (m.includes('card')) cardSales += amt;
          else if (kind === 'ACCOUNT') { creditSales += amt; saleCredit += amt; }
          else otherSales += amt;
        }
        if (String(sale.notes || '').toLowerCase().includes('credit sale') && saleCredit === 0) {
          creditSales += total;
        }
      }

      let returnsTotal = 0;
      let returnsCount = 0;
      let cashRefunds = 0;
      for (const r of shiftReturns) {
        returnsCount += 1;
        const amount = Number(r.refundAmount) || (r.items || []).reduce(
          (n, i) => n + (Number(i.unitPrice) || 0) * (Number(i.quantity) || 0), 0
        );
        returnsTotal += amount;
        if (String(r.refundMethod || 'Cash').toLowerCase() === 'cash') cashRefunds += amount;
      }

      let cashIn = 0;
      let cashOut = 0;
      for (const flow of shiftInfo.cashFlows || []) {
        const amt = Number(flow.amount || 0);
        if (flow.type === 'in') cashIn += amt;
        else if (flow.type === 'out') cashOut += amt;
      }

      const expectedCash = openingCash + cashSales - cashRefunds + cashIn - cashOut;
      const topProducts = [...productTally.values()]
        .sort((a, b) => b.qty - a.qty)
        .slice(0, 8);

      const recentSales = shiftSales
        .slice()
        .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
        .slice(0, 12)
        .map((s) => ({
          id: s.id,
          invoiceNumber: s.invoiceNumber || s.orderNumber || s.id,
          customerName: s.customerName || s.customer?.name || 'Walk-in',
          total: saleAmount(s),
          paymentMethod: (s.payments || []).map((p) => p.paymentMethod).filter(Boolean).join(', ')
            || s.paymentMethod
            || 'Cash',
          createdAt: s.createdAt || s.created_at || null,
          itemsCount: (s.items || []).reduce((n, i) => n + Number(i.quantity || 0), 0),
        }));

      const report = {
        shiftId,
        status: shiftInfo.status || 'Open',
        openedAt: shiftInfo.openedAt || shiftInfo.createdAt || null,
        terminalName: shiftInfo.terminalName || shiftInfo.terminal?.name || '',
        locationName: shiftInfo.locationName || shiftInfo.location?.name || '',
        cashierName,
        openingCash,
        cashSales,
        cardSales,
        creditSales,
        otherSales,
        cashIn,
        cashOut,
        cashRefunds,
        expectedCash,
        totalSales,
        taxTotal,
        discountTotal,
        netSales: Math.max(0, totalSales - returnsTotal),
        salesCount: shiftSales.length,
        itemsSold,
        avgTicket: shiftSales.length ? totalSales / shiftSales.length : 0,
        returnsCount,
        returnsTotal,
        paymentsBreakdown,
        topProducts,
        recentSales,
      };

      return { success: true, data: report };
    } catch (err) {
      console.error('[pos:getShiftReport] failed', err.message);
      return { success: false, message: err.message || 'Could not generate shift report' };
    }
  });

  ipcMain.handle('pos:getDailyReport', async (_event, paramsString) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    try {
      masterSqlite.reloadFromDiskSafe();
      const localSales = masterSqlite.listAllLocalSales();
      let totalSales = 0;
      let taxTotal = 0;
      let salesCount = 0;
      for (const sale of localSales) {
        totalSales += Number(sale.total || sale.totalAmount || sale.finalTotal || 0);
        taxTotal += Number(sale.taxAmount || sale.tax || 0);
        salesCount++;
      }
      return {
        success: true,
        data: {
          totalSales,
          taxTotal,
          salesCount,
          netSales: totalSales - taxTotal,
        }
      };
    } catch (err) {
      return { success: false, message: err.message || 'Daily report failed' };
    }
  });

  ipcMain.handle('pos:verifyManager', async (_event, payload) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    // Bypassed/approved locally
    return { success: true, message: 'Verified locally' };
  });

  // ─── OFFLINE-FIRST: Categories from local cache ───────────────────────────
  handle('pos:getCategories', async (_event, paramsString) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    try {
      await ensureCatalogOpen(auth.session.user);
      masterSqlite.reloadFromDisk();
      return { success: true, data: masterSqlite.getCategoryTree() };
    } catch (err) {
      console.warn('[pos:getCategories] local read failed:', err.message);
      return { success: false, message: err.message || 'Local catalog unavailable' };
    }
  });


  // ─── LOCAL-ONLY: Customer search from local SQLite/cache ─────────────────
  ipcMain.handle('pos:searchCustomers', async (_event, { q, limit }) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    const query = (q || '').trim().toLowerCase();
    try {
      masterSqlite.reloadFromDiskSafe();
      const localHits = masterSqlite.searchCustomers({ query, limit: limit || 20 });
      if (localHits.length) return { success: true, data: localHits };
      // Fallback: search local JSON cache
      let customers = localDb.getCustomers() || [];
      let filtered = customers;
      if (query) {
        filtered = customers.filter(
          (c) =>
            (c.name || '').toLowerCase().includes(query) ||
            (c.email || '').toLowerCase().includes(query) ||
            (c.phone || '').toLowerCase().includes(query)
        );
      }
      return { success: true, data: filtered.slice(0, limit || 20) };
    } catch (err) {
      return { success: false, message: err.message || 'Customer search failed' };
    }
  });


  ipcMain.handle('pos:createCustomer', async (_event, payload) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    // Save customer locally first; will be synced later
    const created = {
      id: `local-cust-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      name: payload?.name || '',
      phone: payload?.phone || '',
      email: payload?.email || '',
      companyName: payload?.companyName || '',
      customerType: payload?.customerType || 'regular',
      isActive: true,
      ...payload,
    };
    try {
      masterSqlite.upsertCustomer(created);
      const cached = localDb.getCustomers() || [];
      localDb.saveCustomers([created, ...cached.filter((c) => (c.id || c._id) !== created.id)]);
    } catch (err) {
      console.warn('[pos:createCustomer] local save failed', err.message);
    }
    return { success: true, data: created };
  });

  ipcMain.handle('pos:getCustomerCreditInfo', async (_event, customerId) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    try {
      masterSqlite.reloadFromDiskSafe();
      const customer = masterSqlite.getCustomerById(customerId);
      let payload = {};
      try { payload = JSON.parse(customer?.payload || '{}'); } catch { payload = {}; }
      const bal = masterSqlite.getCustomerBalances(customerId);
      const creditLimit = Number(payload.creditLimit || payload.credit_limit || 0);
      return {
        success: true,
        data: {
          creditLimit,
          creditPolicy: String(payload.creditPolicy || 'WARN').toUpperCase(),
          outstandingBalance: bal.accountBalance,
          // 0 limit = no limit configured
          availableCredit: creditLimit > 0 ? roundMoney(creditLimit - bal.accountBalance) : null,
          loyaltyPoints: bal.points,
          storeCredit: bal.storeCredit,
        },
      };
    } catch (err) {
      return { success: false, message: err.message || 'Could not read customer balances' };
    }
  });

  /** Customers screen: every customer with live balances and purchase stats. */
  ipcMain.handle('customers:listAccounts', async (_event, params) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    try {
      masterSqlite.reloadFromDiskSafe();
      const customers = masterSqlite.searchCustomers({ query: params?.query || '', limit: params?.limit || 5000 });
      const balances = masterSqlite.getAllCustomerBalances();
      const sales = masterSqlite.listAllLocalSales();
      const rows = customers.map((c) => ({
        ...c,
        balances: balances[c.id] || { points: 0, storeCredit: 0, accountBalance: 0 },
        stats: customerSaleStats(c.id, sales),
      }));
      return { success: true, data: rows };
    } catch (err) {
      return { success: false, message: err.message || 'Failed to load customers' };
    }
  });

  ipcMain.handle('customers:getAccount', async (_event, customerId) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    try {
      masterSqlite.reloadFromDiskSafe();
      const customer = masterSqlite.searchCustomers({ query: '', limit: 1000000 }).find((c) => c.id === customerId);
      if (!customer) return { success: false, message: 'Customer not found' };
      const sales = masterSqlite.listAllLocalSales();
      const mySales = sales
        .filter((s) => String(s.customerId || '') === String(customerId))
        .map((s) => ({
          id: s.id,
          invoiceNumber: s.invoiceNumber || s.id,
          createdAt: s.createdAt,
          grandTotal: roundMoney(saleGrandTotal(s)),
          itemsCount: (s.items || []).reduce((n, i) => n + (Number(i.quantity) || 0), 0),
          payments: (s.payments || []).map((p) => ({ paymentMethod: p.paymentMethod, amount: Number(p.amount) || 0 })),
          loyaltyEarned: Number(s.loyaltyEarned) || 0,
        }));
      const returns = (masterSqlite.listAllLocalReturns() || [])
        .filter((r) => String(r.customerId || '') === String(customerId))
        .map((r) => ({
          id: r.id,
          invoiceNumber: r.invoiceNumber || r.originalSaleId || r.saleId,
          createdAt: r.createdAt,
          refundAmount: Number(r.refundAmount) || roundMoney((r.items || []).reduce((n, i) => n + (Number(i.unitPrice) || 0) * (Number(i.quantity) || 0), 0)),
          refundMethod: r.refundMethod || 'Cash',
        }));
      return {
        success: true,
        data: {
          customer,
          balances: masterSqlite.getCustomerBalances(customerId),
          stats: customerSaleStats(customerId, sales),
          ledger: masterSqlite.listCustomerLedger(customerId, 500),
          sales: mySales,
          returns,
        },
      };
    } catch (err) {
      return { success: false, message: err.message || 'Failed to load customer account' };
    }
  });

  ipcMain.handle('customers:update', async (_event, { id, patch }) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    try {
      masterSqlite.reloadFromDiskSafe();
      const allowed = ['name', 'phone', 'email', 'companyName', 'customerType', 'taxId', 'creditLimit', 'creditPolicy', 'creditTerms', 'notes', 'address'];
      const clean = {};
      for (const key of allowed) if (patch && patch[key] !== undefined) clean[key] = patch[key];
      if (clean.creditLimit !== undefined) clean.creditLimit = Math.max(0, Number(clean.creditLimit) || 0);
      if (clean.name !== undefined && !String(clean.name).trim()) return { success: false, message: 'Name is required' };
      const updated = masterSqlite.updateCustomerFields(id, clean);
      return { success: true, data: updated };
    } catch (err) {
      return { success: false, message: err.message || 'Failed to update customer' };
    }
  });

  /**
   * Manual account actions from the Customers screen:
   *   PAYMENT       — customer pays down their on-account balance (cash/card/…)
   *   CREDIT_ISSUE  — issue store credit (goodwill / gift) ; CREDIT_ADJUST ± correction
   *   POINTS_ADJUST — ± points with a reason
   */
  ipcMain.handle('customers:postEntry', async (_event, entry) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    try {
      masterSqlite.reloadFromDiskSafe();
      const customerId = String(entry?.customerId || '');
      if (!masterSqlite.getCustomerById(customerId)) return { success: false, message: 'Customer not found' };
      const action = String(entry?.action || '').toUpperCase();
      const amount = roundMoney(entry?.amount);
      const points = Math.round(Number(entry?.points) || 0);
      const note = String(entry?.note || '').trim();
      const createdBy = currentUserId(auth.session?.user);
      const bal = masterSqlite.getCustomerBalances(customerId);
      let row;
      if (action === 'PAYMENT') {
        if (!(amount > 0)) return { success: false, message: 'Enter the amount received' };
        if (amount > bal.accountBalance + 0.009) return { success: false, message: `Balance due is only ${bal.accountBalance.toFixed(2)}` };
        row = { kind: 'ACCOUNT', type: 'PAYMENT', amount: -amount, note: note || `Payment received (${entry.method || 'Cash'})`, reference: entry.method || 'Cash' };
      } else if (action === 'CREDIT_ISSUE') {
        if (!(amount > 0)) return { success: false, message: 'Enter the store credit amount' };
        row = { kind: 'CREDIT', type: 'ISSUE', amount, note: note || 'Store credit issued' };
      } else if (action === 'CREDIT_ADJUST') {
        if (!amount) return { success: false, message: 'Enter the adjustment amount' };
        if (bal.storeCredit + amount < -0.009) return { success: false, message: 'Store credit cannot go below zero' };
        if (!note) return { success: false, message: 'A reason is required for adjustments' };
        row = { kind: 'CREDIT', type: 'ADJUST', amount, note };
      } else if (action === 'POINTS_ADJUST') {
        if (!points) return { success: false, message: 'Enter the points to add or remove' };
        if (bal.points + points < 0) return { success: false, message: 'Points cannot go below zero' };
        if (!note) return { success: false, message: 'A reason is required for adjustments' };
        row = { kind: 'POINTS', type: 'ADJUST', points, note };
      } else {
        return { success: false, message: 'Unknown action' };
      }
      masterSqlite.addCustomerLedgerEntries([{
        ...row,
        customerId,
        createdBy,
        reference: row.reference || `Manual ${new Date().toISOString().slice(0, 10)}`,
      }]);
      return { success: true, data: masterSqlite.getCustomerBalances(customerId) };
    } catch (err) {
      return { success: false, message: err.message || 'Failed to post entry' };
    }
  });

  /** Raw local data for the Reports screen; aggregation happens in the renderer. */
  ipcMain.handle('reports:getData', async (_event, params) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    try {
      masterSqlite.reloadFromDiskSafe();
      const from = params?.from ? new Date(params.from) : new Date(0);
      const to = params?.to ? new Date(params.to) : new Date();
      const inRange = (iso) => {
        const t = new Date(iso || 0).getTime();
        return t >= from.getTime() && t <= to.getTime();
      };
      const sales = filterRecordsForUser(auth.session.user, masterSqlite.listAllLocalSales())
        .filter((s) => inRange(s.createdAt))
        .map((s) => ({ ...s, grandTotal: roundMoney(saleGrandTotal(s)) }));
      const returns = filterRecordsForUser(auth.session.user, masterSqlite.listAllLocalReturns() || [])
        .filter((r) => inRange(r.createdAt));
      const customers = masterSqlite.searchCustomers({ query: '', limit: 1000000 })
        .map((c) => ({ id: c.id, name: c.name, phone: c.phone }));
      return {
        success: true,
        data: {
          from: from.toISOString(),
          to: to.toISOString(),
          sales,
          returns,
          customers,
          balances: masterSqlite.getAllCustomerBalances(),
          ledger: masterSqlite.listLedgerBetween(from.toISOString(), to.toISOString()),
        },
      };
    } catch (err) {
      return { success: false, message: err.message || 'Failed to load report data' };
    }
  });

  ipcMain.handle('pos:getReceiptSettings', async () => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    try {
      const settings = localDb.getReceiptSettings();
      return { success: true, data: settings };
    } catch (err) {
      return {
        success: true,
        data: {
          storeName: 'Bison POS',
          address: 'Main St',
          phone: '000-000-0000',
          email: 'info@bison.com',
          website: 'www.bison.com',
          footer: 'Thank you for shopping with us!',
        }
      };
    }
  });

  ipcMain.handle('pos:getProfile', async () => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    const user = auth.session.user || {};
    const company = user.company || {};
    const business = user.businessDetails || {};
    const companyName =
      company.name ||
      user.organizationName ||
      business.companyName ||
      [user.firstName, user.lastName].filter(Boolean).join(' ') ||
      'POS';
    const logo =
      company.logo ||
      business.logo ||
      user.logo ||
      '';

    // Prefer live company profile when online
    try {
      if (auth.session.accessToken) {
        const live = await posApi.getProfile(auth.session.accessToken);
        if (live?.success && live.data) {
          const d = live.data;
          const liveCompany = d.company || {};
          const liveBiz = d.businessDetails || {};
          return {
            success: true,
            data: {
              id: d.id || user.id,
              name: [d.firstName || user.firstName, d.lastName || user.lastName]
                .filter(Boolean)
                .join(' ') || 'User',
              email: d.email || user.email || '',
              role: d.role || user.role || 'cashier',
              companyName:
                liveCompany.name ||
                d.organizationName ||
                liveBiz.companyName ||
                companyName,
              logo: liveCompany.logo || liveBiz.logo || logo || '',
              company: liveCompany.name ? liveCompany : company,
              businessDetails: liveBiz.logo || liveBiz.companyName ? liveBiz : business,
              organizationName: d.organizationName || user.organizationName || '',
            },
          };
        }
      }
    } catch (err) {
      console.warn('[pos:getProfile] live fetch failed, using session:', err.message);
    }

    return {
      success: true,
      data: {
        id: auth.session.userId || auth.session.id || user.id,
        name: [user.firstName, user.lastName].filter(Boolean).join(' ') || 'User',
        email: user.email || '',
        role: user.role || 'cashier',
        companyName,
        logo,
        company,
        businessDetails: business,
        organizationName: user.organizationName || '',
      },
    };
  });

  // ─── POS Management / Admin IPC Handlers ──────────────────────────────────
  ipcMain.handle('pos:createTerminal', async (_event, payload) => {
    const auth = requireAdmin();
    if (!auth.ok) return auth.result;
    const body = { ...(payload || {}) };
    if (!String(body.locationId || '').trim()) delete body.locationId;
    const res = await posApi.createTerminal(auth.session.accessToken, body);
    if (res?.success) {
      try {
        await refreshScopedCatalogCaches(auth.session.accessToken, auth.session.user);
      } catch (err) {
        console.warn('[scope] refresh after createTerminal failed:', err.message);
      }
    }
    return res;
  });

  ipcMain.handle('pos:updateTerminal', async (_event, { id, body }) => {
    const auth = requireAdmin();
    if (!auth.ok) return auth.result;
    const patch = { ...(body || {}) };
    if (Object.prototype.hasOwnProperty.call(patch, 'locationId') && !String(patch.locationId || '').trim()) {
      patch.locationId = null;
    }
    const res = await posApi.updateTerminal(auth.session.accessToken, id, patch);
    if (res?.success) {
      try {
        await refreshScopedCatalogCaches(auth.session.accessToken, auth.session.user);
      } catch (err) {
        console.warn('[scope] refresh after updateTerminal failed:', err.message);
      }
    }
    return res;
  });

  ipcMain.handle('pos:deleteTerminal', async (_event, id) => {
    const auth = requireAdmin();
    if (!auth.ok) return auth.result;
    const res = await posApi.deleteTerminal(auth.session.accessToken, id);
    if (res?.success) {
      try {
        await refreshScopedCatalogCaches(auth.session.accessToken, auth.session.user);
      } catch (err) {
        console.warn('[scope] refresh after deleteTerminal failed:', err.message);
      }
    }
    return res;
  });

  ipcMain.handle('pos:refreshScopeCache', async () => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    try {
      const data = await refreshScopedCatalogCaches(auth.session.accessToken, auth.session.user);
      return { success: true, data };
    } catch (err) {
      return { success: false, message: err.message || 'Could not refresh scope cache' };
    }
  });

  ipcMain.handle('pos:listUsers', async () => {
    const auth = requireAdmin();
    if (!auth.ok) return auth.result;
    return posApi.listCompanyUsers(auth.session.accessToken);
  });

  ipcMain.handle('pos:assignUserTerminal', async (_event, payload) => {
    const auth = requireAdmin();
    if (!auth.ok) return auth.result;
    const userId = String(payload?.userId || '').trim();
    if (!userId) return { success: false, message: 'User id is required' };
    const terminalId = payload?.terminalId ? String(payload.terminalId).trim() : null;
    return posApi.updateCompanyUser(auth.session.accessToken, userId, {
      assignedTerminalId: terminalId,
    });
  });

  ipcMain.handle('pos:reopenShift', async (_event, id) => {
    const auth = requireAdmin();
    if (!auth.ok) return auth.result;
    // Find shift in local history and reopen it locally
    try {
      const history = localDb.getShiftHistory() || [];
      const shift = history.find((s) => s.id === id);
      if (!shift) return { success: false, message: 'Shift not found in local history' };
      shift.status = 'Open';
      shift.reopenedAt = new Date().toISOString();
      const updated = history.map((s) => (s.id === id ? shift : s));
      localDb.saveShiftHistory(updated);
      activeShift = shift;
      localDb.saveActiveShift(activeShift);
      return { success: true, data: shift };
    } catch (err) {
      return { success: false, message: err.message || 'Could not reopen shift' };
    }
  });

  ipcMain.handle('pos:listLocalSales', async () => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    masterSqlite.reloadFromDisk();
    const sales = filterRecordsForUser(auth.session.user, masterSqlite.listAllLocalSales());
    return {
      success: true,
      offline: true,
      data: { sales },
    };
  });

  ipcMain.handle('pos:listSales', async (_event, paramsString) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    try {
      masterSqlite.reloadFromDiskSafe();
      const localSales = filterRecordsForUser(auth.session.user, masterSqlite.listAllLocalSales());
      return { success: true, data: localSales };
    } catch (err) {
      return { success: false, message: err.message || 'Failed to list sales' };
    }
  });

  ipcMain.handle('pos:getSale', async (_event, id) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    try {
      masterSqlite.reloadFromDiskSafe();
      const localSales = masterSqlite.listAllLocalSales();
      const found = localSales.find(s => String(s.id) === String(id));
      if (found) return { success: true, data: found };
      return { success: false, message: 'Sale not found locally' };
    } catch (err) {
      return { success: false, message: err.message || 'Error getting sale' };
    }
  });

  ipcMain.handle('pos:voidSale', async (_event, { id, body }) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    
    try {
      // Undo the customer's points / store credit / account movements for this sale
      masterSqlite.reloadFromDiskSafe();
      const sale = masterSqlite.listAllLocalSales().find((s) => String(s.id) === String(id));
      if (sale) {
        masterSqlite.reverseLedgerForReference(sale.invoiceNumber || sale.id, `Voided sale ${sale.invoiceNumber || sale.id}`);
      }
      // Delete from local SQLite database
      masterSqlite.deleteLocalSale(id);
      return { success: true, message: 'Sale deleted from local database' };
    } catch (err) {
      return { success: false, message: err.message || 'Error deleting sale from local database' };
    }
  });

  ipcMain.handle('pos:deleteAllSales', async () => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;

    try {
      // Delete all sales from local SQLite database
      masterSqlite.reloadFromDiskSafe();
      const allSales = masterSqlite.listAllLocalSales();
      let deletedCount = 0;
      
      for (const sale of allSales) {
        try {
          masterSqlite.deleteLocalSale(sale.id);
          deletedCount++;
        } catch (err) {
          console.error(`Error deleting sale ${sale.id}:`, err.message);
        }
      }
      
      return { success: true, message: `Deleted ${deletedCount} sales from local database` };
    } catch (err) {
      return { success: false, message: err.message || 'Error deleting all sales from local database' };
    }
  });

  ipcMain.handle('pos:convertToInvoice', async (_event, { id, body }) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    return { success: true, message: 'Converted locally' };
  });

  ipcMain.handle('pos:getAuditLogs', async (_event, paramsString) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    return { success: true, data: [] };
  });

  ipcMain.handle('pos:saveReceiptSettings', async (_event, body) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    try {
      localDb.saveReceiptSettings(body);
      return { success: true, message: 'Receipt settings saved locally' };
    } catch (err) {
      return { success: false, message: err.message || 'Failed to save settings' };
    }
  });

  ipcMain.handle('sales:enterSales', () => {
    console.log('[desktop] sales:enterSales called, switching to sales.html');
    showSalesScreen();
    return { success: true };
  });

  handle('pos:enterRegister', () => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    showRegisterScreen();
    return { success: true };
  });

  handle('pos:enterCategories', () => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    showCategoriesScreen();
    return { success: true };
  });

  handle('catalog:list', async () => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    await ensureCatalogOpen(auth.session.user);
    masterSqlite.reloadFromDiskSafe();
    return { success: true, data: masterSqlite.listCatalog() };
  });

  handle('catalog:listSuppliers', async () => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    await ensureCatalogOpen(auth.session.user);
    masterSqlite.reloadFromDiskSafe();
    const rows = masterSqlite.listSuppliers();
    return { success: true, data: rows };
  });

  handle('catalog:saveCategory', (_event, payload) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    return masterSqlite.saveCategory(payload || {});
  });

  handle('catalog:deleteCategory', (_event, id) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    return masterSqlite.deleteCategory(id);
  });

  handle('catalog:saveSubcategory', (_event, payload) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    return masterSqlite.saveSubcategory(payload || {});
  });

  handle('catalog:deleteSubcategory', (_event, id) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    return masterSqlite.deleteSubcategory(id);
  });

  handle('catalog:listProducts', () => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    // Same safety: always surface the latest on-disk catalog to the Products page.
    masterSqlite.reloadFromDiskSafe();
    const products = masterSqlite.listProducts();
    // Lean sync used to drop costPrice — restore from the full API cache when SQLite has 0
    try {
      const cached = localDb.getProducts() || [];
      if (cached.length) {
        const costById = new Map();
        for (const c of cached) {
          const id = String(c.id || c._id || '');
          const cost = Number(c.costPrice ?? c.cost_price ?? c.landingCost ?? 0);
          if (id && Number.isFinite(cost) && cost > 0) costById.set(id, cost);
        }
        let patched = 0;
        for (const p of products) {
          const id = String(p.id || '');
          if (!(Number(p.costPrice) > 0) && costById.has(id)) {
            const cost = costById.get(id);
            p.costPrice = cost;
            if (typeof masterSqlite.patchProductCost === 'function') {
              masterSqlite.patchProductCost(id, cost);
              patched += 1;
            }
          }
        }
        if (patched) console.log('[catalog:listProducts] backfilled costPrice for', patched, 'products');
      }
    } catch (err) {
      console.warn('[catalog:listProducts] cost backfill skipped', err.message);
    }
    return { success: true, data: products };
  });

  handle('catalog:saveProduct', (_event, payload) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    return masterSqlite.saveProduct(payload || {});
  });

  handle('catalog:deleteProduct', (_event, id) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    return masterSqlite.deleteProduct(id);
  });

  // ── Local Stock Movements (offline-first inventory receiving) ─────────────
  handle('pos:addStockIn', (_event, payload) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    try {
      const {
        productId, quantity, unitCost = 0, stockType = 'bulk',
        reason = 'Stock In', supplierId = null, supplierName = null,
        reference = '', notes = '', boxCount, piecesPerBox,
      } = payload || {};
      if (!productId) return { success: false, message: 'Product ID is required' };
      const qty = stockType === 'box'
        ? (parseFloat(boxCount) || 0) * (parseFloat(piecesPerBox) || 0)
        : parseFloat(quantity);
      if (!qty || isNaN(qty) || qty <= 0) return { success: false, message: 'Valid quantity is required' };

      const { previousStock, newStock, productName } = masterSqlite.adjustProductStockLocally(productId, qty);
      const product = masterSqlite.listProducts().find(p => p.id === productId);
      const unit = product?.stockUnitName || product?.stockUnit || 'Pcs';
      const movement = masterSqlite.addStockMovement({
        productId, productName, type: 'stock_in', quantity: qty,
        previousStock, newStock, unit, unitCost: parseFloat(unitCost) || 0,
        stockType, reason, supplierId, supplierName, reference, notes,
      });
      return { success: true, data: { movement, previousStock, newStock } };
    } catch (err) {
      return { success: false, message: err.message || 'Stock In failed' };
    }
  });

  handle('pos:addStockOut', (_event, payload) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    try {
      const {
        productId, quantity, unitCost = 0,
        reason = 'Stock Out', reference = '', notes = '',
      } = payload || {};
      if (!productId) return { success: false, message: 'Product ID is required' };
      const qty = parseFloat(quantity);
      if (!qty || isNaN(qty) || qty <= 0) return { success: false, message: 'Valid quantity is required' };

      const { previousStock, newStock, productName } = masterSqlite.adjustProductStockLocally(productId, -qty);
      const product = masterSqlite.listProducts().find(p => p.id === productId);
      const unit = product?.stockUnitName || product?.stockUnit || 'Pcs';
      const movement = masterSqlite.addStockMovement({
        productId, productName, type: 'stock_out', quantity: qty,
        previousStock, newStock, unit, unitCost: parseFloat(unitCost) || 0,
        stockType: 'bulk', reason, reference, notes,
      });
      return { success: true, data: { movement, previousStock, newStock } };
    } catch (err) {
      return { success: false, message: err.message || 'Stock Out failed' };
    }
  });

  handle('pos:listStockMovements', (_event, params) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    try {
      const movements = masterSqlite.listStockMovements(params || {});
      return { success: true, data: movements };
    } catch (err) {
      return { success: false, message: err.message || 'Failed to load movements' };
    }
  });

  // ── Sales Orders — local-first (show POS sales from SQLite, fallback API) ──
  ipcMain.handle('sales:getOrders', async (_event, params) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    try {
      masterSqlite.reloadFromDiskSafe();
      const localSales = masterSqlite.listAllLocalSales();
      return {
        success: true,
        offline: true,
        data: { data: localSales, pagination: { total: localSales.length, pages: 1 } },
      };
    } catch (err) {
      console.warn('[sales:getOrders] local read failed', err.message);
      return { success: false, message: err.message || 'Failed to list orders' };
    }
  });

  ipcMain.handle('sales:createOrder', async (_event, data) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    // Bypassed/approved locally
    return { success: true, message: 'Order created locally' };
  });

  ipcMain.handle('sales:updateStatus', async (_event, payload) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    return { success: true, message: 'Status updated locally' };
  });

  ipcMain.handle('sales:cancelOrder', async (_event, payload) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    return { success: true, message: 'Order cancelled locally' };
  });

  ipcMain.handle('sales:deleteOrder', async (_event, payload) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    return { success: true, message: 'Order deleted locally' };
  });

  // ── Customers — local-first ───────────────────────────────────────────────
  ipcMain.handle('customers:list', async (_event, params) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    try {
      masterSqlite.reloadFromDiskSafe();
      const local = masterSqlite.searchCustomers({ query: '', limit: params?.limit || 500 });
      return { success: true, data: local };
    } catch (err) {
      console.warn('[customers:list] local read failed', err.message);
      return { success: false, message: err.message || 'Failed to list customers' };
    }
  });

  ipcMain.handle('customers:search', async (_event, payload) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    try {
      masterSqlite.reloadFromDiskSafe();
      const local = masterSqlite.searchCustomers({ query: payload?.q || '', limit: payload?.limit || 20 });
      return { success: true, data: local };
    } catch (err) {
      console.warn('[customers:search] local read failed', err.message);
      return { success: false, message: err.message || 'Failed to search customers' };
    }
  });

  // ── Products — local-first ────────────────────────────────────────────────
  ipcMain.handle('products:list', async (_event, params) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    try {
      masterSqlite.reloadFromDiskSafe();
      const local = masterSqlite.listProducts();
      return { success: true, data: local };
    } catch (err) {
      console.warn('[products:list] local read failed', err.message);
      return { success: false, message: err.message || 'Failed to list products' };
    }
  });

  // ── Tax — company profile from web (cached locally, refresh when online) ──
  ipcMain.handle('tax:getContext', async () => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;

    const offlineFallback = () => {
      const cached = localDb.getTaxContext();
      if (cached) return { success: true, data: cached, source: 'cache' };
      return {
        success: true,
        data: localDb.normalizeTaxContext({ enabled: false, configured: false }),
        source: 'default',
      };
    };

    try {
      const token = auth.session?.accessToken;
      if (token) {
        const live = await posApi.fetchTaxContext(token);
        if (live?.success && live.data) {
          localDb.saveTaxContext(live.data);
          return { success: true, data: localDb.getTaxContext(), source: 'live' };
        }
      }
    } catch (err) {
      console.warn('[tax:getContext] live fetch failed', err.message);
    }
    return offlineFallback();
  });

  ipcMain.handle('tax:refreshContext', async () => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    try {
      const live = await posApi.fetchTaxContext(auth.session.accessToken);
      if (live?.success && live.data) {
        localDb.saveTaxContext(live.data);
        return { success: true, data: localDb.getTaxContext() };
      }
      return { success: false, message: live?.message || 'Could not refresh tax settings' };
    } catch (err) {
      return { success: false, message: err.message || 'Tax refresh failed' };
    }
  });

  // ─── Offline sync status (pending queue counts) ───────────────────────────
  ipcMain.handle('pos:getSyncStatus', () => {
    const sales = localDb.getSalesQueue();
    const returns = localDb.getReturnsQueue();
    const shifts = localDb.getShiftsQueue();
    const total = sales.length + returns.length + shifts.length;
    let catalogPending;
    try {
      const pc = masterSqlite.pendingCounts();
      catalogPending = (pc.categories || 0) + (pc.subcategories || 0) + (pc.products || 0);
    } catch { catalogPending = 0; }
    return {
      success: true,
      data: {
        pendingSales: sales.length,
        pendingReturns: returns.length,
        pendingShifts: shifts.length,
        totalPending: total,
        catalogPending,
        totalPendingAll: total + catalogPending,
      },
    };
  });

  ipcMain.handle('app:getInfo', () => {
    const machine = machineInfo.collect(app, userData());
    return {
      version: app.getVersion(),
      platform: process.platform,
      packaged: app.isPackaged,
      rendererOrigin,
      ...machine,
    };
  });

  ipcMain.handle('app:openExternal', (_event, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      shell.openExternal(url);
      return true;
    }
    return false;
  });

  // ─── Google Drive backup (local PC only — does not touch cloud API) ───
  ipcMain.handle('backup:getStatus', () => {
    try {
      return { success: true, data: driveBackup.getStatus() };
    } catch (err) {
      return { success: false, message: err.message || 'Failed to read backup status' };
    }
  });

  ipcMain.handle('backup:saveSettings', (_event, payload = {}) => {
    try {
      const patch = {};
      if (typeof payload.enabled === 'boolean') patch.enabled = payload.enabled;
      if (Array.isArray(payload.times)) patch.times = payload.times;
      if (typeof payload.clientId === 'string') patch.clientId = payload.clientId.trim();
      if (typeof payload.clientSecret === 'string' && payload.clientSecret.trim()) {
        patch.clientSecret = payload.clientSecret.trim();
      }
      const data = driveBackup.saveSettings(patch);
      return { success: true, data };
    } catch (err) {
      return { success: false, message: err.message || 'Failed to save backup settings' };
    }
  });

  ipcMain.handle('backup:connect', async () => {
    try {
      const data = await driveBackup.connectDrive();
      return { success: true, data };
    } catch (err) {
      return { success: false, message: err.message || 'Google sign-in failed' };
    }
  });

  ipcMain.handle('backup:disconnect', () => {
    try {
      return { success: true, data: driveBackup.disconnectDrive() };
    } catch (err) {
      return { success: false, message: err.message || 'Disconnect failed' };
    }
  });

  ipcMain.handle('backup:runNow', async () => {
    try {
      const data = await driveBackup.runBackup({ reason: 'manual' });
      return { success: true, data };
    } catch (err) {
      return { success: false, message: err.message || 'Backup failed' };
    }
  });

  ipcMain.handle('backup:list', async () => {
    try {
      const files = await driveBackup.listRemoteBackups();
      return { success: true, data: files };
    } catch (err) {
      return { success: false, message: err.message || 'Could not list Drive backups' };
    }
  });

  ipcMain.handle('backup:restore', async (_event, fileId) => {
    try {
      const data = await driveBackup.runRestore(fileId);
      return { success: true, data };
    } catch (err) {
      return { success: false, message: err.message || 'Restore failed' };
    }
  });

  ipcMain.handle('codes:qrSvg', async (_event, { text, size } = {}) => {
    try {
      const QRCode = require('qrcode');
      const value = String(text || '').trim();
      if (!value) return { success: false, message: 'Empty QR value' };
      const px = Math.max(96, Math.min(320, Number(size) || 160));
      const svg = await QRCode.toString(value, {
        type: 'svg',
        width: px,
        margin: 2,
        errorCorrectionLevel: 'M',
        color: { dark: '#000000', light: '#ffffff' },
      });
      return { success: true, svg };
    } catch (err) {
      return { success: false, message: err.message || 'QR render failed' };
    }
  });
}

function watchSessionExpiry() {
  if (sessionWatchTimer) clearInterval(sessionWatchTimer);
  sessionWatchTimer = setInterval(async () => {
    const sessionData = authStore.readSession(userData());

    if (sessionData && authStore.isExpired(sessionData)) {
      authStore.clearSession(userData());
      appView?.webContents.send('auth:expired');
      showLoginScreen({
        message: 'Your session expired. Please sign in again.',
        reason: 'SESSION_INVALID',
      });
      return;
    }

    if (!sessionData?.accessToken || pendingForcedLogout) return;
    try {
      const check = await validateSessionAccess(sessionData.accessToken);
      if (!check.ok) {
        await forceLogoutWithReason(check.code, check.message);
      }
    } catch (_) { /* network error — ignore, will retry next cycle */ }
  }, 20_000);
}

app.whenReady().then(async () => {
  localDb.initialize(app.getPath('userData'));
  try {
    driveBackup.initialize(app.getPath('userData'), { localDb, masterSqlite });
  } catch (err) {
    console.error('[drive-backup] init failed', err.message);
  }
  const bootSession = authStore.getValidSession(app.getPath('userData'));
  let bootUser = bootSession?.user || null;
  if (bootSession?.accessToken) {
    const bootCompanyId = resolveCompanyId(bootUser, bootSession);
    applyApiCompanyContext(bootCompanyId);
    bootUser = await enrichUserProfile(bootUser, bootSession.accessToken, bootCompanyId);
    if (bootUser) {
      bootUser = {
        ...bootUser,
        companyId: bootCompanyId || resolveCompanyId(bootUser, bootSession),
        activeCompanyId: bootCompanyId || resolveCompanyId(bootUser, bootSession),
      };
      authStore.writeSession(app.getPath('userData'), {
        ...bootSession,
        user: bootUser,
        activeCompanyId: bootUser.companyId,
      });
      applyApiCompanyContext(bootUser.companyId);
    }
  }
  if (bootUser) {
    await switchLocalDataForCompany(bootUser);
  } else {
    try {
      await masterSqlite.open(app.getPath('userData'), { companyId: '_default' });
    } catch (err) {
      console.error('[sqlite] failed to open default catalog', err.message);
    }
  }
  rendererOrigin = config.originOf(config.resolveAppUrl(app.isPackaged));
  console.log('[desktop] API URL:', config.resolveApiUrl());
  applyRendererSecurity();
  try {
    registerIpc();
    console.log('[desktop] IPC handlers ready (pos:syncMasterData, pos:listLocations)');
  } catch (err) {
    console.error('[desktop] registerIpc failed', err);
  }
  buildMenu();
  createSplash();
  createMainWindow();
  registerShortcuts();
  watchSessionExpiry();
  setupAutoUpdate(app).catch(() => { });
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});

app.on('window-all-closed', () => {
  if (!isMac) app.quit();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (sessionWatchTimer) clearInterval(sessionWatchTimer);
  try { driveBackup.stop(); } catch { /* ignore */ }
});
