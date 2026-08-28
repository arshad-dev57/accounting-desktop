

const {
  app,
  BrowserWindow,
  BrowserView,
  ipcMain,
  Menu,
  shell,
  globalShortcut,
  session,
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
const posApi = require('./pos-api.cjs');
const salesApi = require('./sales-api.cjs');
const localDb = require('./local-db.cjs');
const masterSqlite = require('./master-sqlite.cjs');
const masterSync = require('./master-sync.cjs');
const machineInfo = require('./machine-info.cjs');

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
let rendererOrigin = config.DEFAULT_LOCAL;
let shown = false;
let pendingLogin = null;
let activeShift = null;

function userData() {
  return app.getPath('userData');
}

function showLoginScreen() {
  pendingLogin = null;
  appView?.webContents.loadFile(path.join(__dirname, 'renderer', 'login.html'));
}

function showOtpScreen(email) {
  appView?.webContents.loadFile(path.join(__dirname, 'renderer', 'otp.html'), {
    query: { email: String(email || '') },
  });
}

function showShiftScreen() {
  appView?.webContents.loadFile(path.join(__dirname, 'renderer', 'shift.html'));
}

function showSellScreen() {
  appView?.webContents.loadFile(path.join(__dirname, 'renderer', 'sell.html'));
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

  appView?.webContents.session.clearCache(() => {
    const timestamp = Date.now();
    appView?.webContents.loadFile(path.join(__dirname, 'renderer', 'categories.html'), {
      query: { t: timestamp }
    });
  });
}

function showProductsScreen() {
  appView?.webContents.session.clearCache(() => {
    const timestamp = Date.now();
    appView?.webContents.loadFile(path.join(__dirname, 'renderer', 'products.html'), {
      query: { t: timestamp }
    });
  });
}

function showPosScreen() {
  showShiftScreen();
}

function loadAuthOrPos() {
  if (authStore.getValidSession(userData())) showShiftScreen();
  else showLoginScreen();
}

function isAdminUser(user) {
  const role = String(user?.role || '').toLowerCase().trim();
  return role === 'admin' || role === 'owner' || role === 'superadmin' || role === 'company_admin';
}

function requireAuth() {
  const sessionData = authStore.getValidSession(userData());
  if (!sessionData?.accessToken) {
    return { ok: false, result: { success: false, message: 'Please sign in again' } };
  }
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

async function completeLoginAndOpenPos(rawBody) {
  const picked = backendApi.pickAuth(rawBody);
  let { token, refreshToken, user } = picked;
  if (!token) {
    return { success: false, message: 'OTP verified but no token was returned' };
  }
  if (!user) {
    user = await backendApi.getMe(token);
  }
  if (!user) {
    return { success: false, message: 'Login succeeded but user profile could not be loaded' };
  }
  authStore.writeSession(userData(), {
    accessToken: token,
    refreshToken,
    user,
  });
  await applyAuthCookies(token, refreshToken);
  pendingLogin = null;
  activeShift = null;
  console.log('[desktop] session ready, opening shift screen', user.email || user.id);
  showShiftScreen();
  return { success: true };
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
    return s
      ? {
        accessToken: s.accessToken,
        refreshToken: s.refreshToken,
        user: s.user,
        isAdmin: isAdminUser(s.user),
      }
      : null;
  });

  ipcMain.handle('auth:clearSession', () => {
    authStore.clearSession(userData());
    pendingLogin = null;
    return true;
  });

  ipcMain.handle('auth:login', async (_event, payload) => {
    const email = String(payload?.email || '').trim();
    const password = String(payload?.password || '');
    const result = await backendApi.login(email, password);
    if (result.success) {
      pendingLogin = { email, password };
      showOtpScreen(email);
    }
    return result;
  });

  ipcMain.handle('auth:verifyOtp', async (_event, payload) => {
    const email = String(payload?.email || pendingLogin?.email || '').trim();
    const otp = String(payload?.otp || '').trim();
    const result = await backendApi.verifyLoginOtp(email, otp);
    if (!result.success) return result;
    const opened = await completeLoginAndOpenPos(result.data);
    if (!opened.success) return opened;
    return result;
  });

  ipcMain.handle('auth:resendOtp', async (_event, payload) => {
    const email = String(payload?.email || pendingLogin?.email || '').trim();
    if (!pendingLogin || pendingLogin.email !== email) {
      return { success: false, message: 'Please sign in again to resend OTP' };
    }
    return backendApi.login(pendingLogin.email, pendingLogin.password);
  });

  ipcMain.handle('auth:openLogin', () => {
    showLoginScreen();
    return true;
  });

  ipcMain.handle('auth:logout', () => {
    authStore.clearSession(userData());
    pendingLogin = null;
    activeShift = null;
    showLoginScreen();
    return true;
  });

  handle('pos:listTerminals', async () => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    return posApi.listTerminals(auth.session.accessToken);
  });

  handle('pos:listLocations', async () => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    return posApi.listLocations(auth.session.accessToken);
  });

  handle('pos:syncMasterData', async (event, payload) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    const locationId = String(payload?.locationId || '').trim();
    if (payload && payload.refresh) {
      const result = await masterSync.refreshCatalog(auth.session.accessToken, locationId);
      console.log('[pos:syncMasterData] refresh', result?.counts, 'location', locationId || 'all', result?.message || result?.success);
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
    const res = await posApi.getCurrentShift(auth.session.accessToken);
    if (res.success && res.data?.status === 'Open') activeShift = res.data;
    return res;
  });

  ipcMain.handle('pos:getActiveShift', () => activeShift);

  ipcMain.handle('pos:openShift', async (_event, payload) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    const res = await posApi.openShift(auth.session.accessToken, {
      terminalId: payload?.terminalId,
      openingCash: Number(payload?.openingCash || 0),
      notes: payload?.notes || '',
    });
    if (res.success) activeShift = res.data;
    return res;
  });

  ipcMain.handle('pos:resumeShift', async (_event, shiftId) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    const res = await posApi.resumeShift(auth.session.accessToken, shiftId);
    if (res.success) activeShift = res.data;
    return res;
  });

  ipcMain.handle('pos:closeShift', async (_event, payload) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    if (!activeShift?.id) return { success: false, message: 'No active shift' };
    const res = await posApi.closeShift(auth.session.accessToken, activeShift.id, {
      actualCash: Number(payload?.actualCash || 0),
      notes: payload?.notes || '',
    });
    if (res.success) activeShift = null;
    return res;
  });

  // ─── OFFLINE-FIRST: Search products from local cache ─────────────────────
  ipcMain.handle('pos:searchProducts', async (_event, payload) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;

    // Support both object payload { query, categoryId, locationId }
    // and raw querystring string "q=...&categoryId=...&locationId=..."
    const parsed = parseProductSearchPayload(payload);
    const q = parsed.q;
    const categoryId = parsed.categoryId;
    const locationId = parsed.locationId;

    const qs = new URLSearchParams({ limit: '200' });
    if (q) qs.set('q', q);
    if (categoryId && categoryId !== 'All') qs.set('categoryId', categoryId);
    if (locationId) qs.set('locationId', locationId);
    const live = await posApi.searchProducts(auth.session.accessToken, qs.toString());
    if (live?.success && Array.isArray(live.data) && live.data.length) {
      return { success: true, data: live.data, source: 'live' };
    }
    try {
      if (!masterSqlite.counts().products) {
        const synced = await masterSync.syncMasterData(auth.session.accessToken, locationId);
        if (!synced.success && !masterSqlite.counts().products) {
          if (live?.success && Array.isArray(live.data)) return { success: true, data: live.data, source: 'live' };
          return synced;
        }
      }
      const products = masterSqlite.searchProducts({
        query: q,
        categoryId,
      });
      // Live came back empty (e.g. location-scoped stock rows missing) but the
      // local replica has products — always serve the local rows so the sell
      // page is never blank while offline data exists.
      if (products.length) return { success: true, data: products, source: 'local' };
      if (live?.success && Array.isArray(live.data)) return { success: true, data: live.data, source: 'live' };
      return { success: true, data: products, source: 'local' };
    } catch (err) {
      console.error('[pos:searchProducts] local fallback failed', err.message);
      if (live?.success && Array.isArray(live.data)) return { success: true, data: live.data, source: 'live' };
      return { success: false, message: err.message || 'Product search failed' };
    }
  });


  // ─── OFFLINE-FIRST: Queue sale locally ───────────────────────────────────
  ipcMain.handle('pos:completeSale', async (_event, payload) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    if (!activeShift?.id) return { success: false, message: 'Open a shift first' };
    // Stamp the payload with shift info before saving locally
    const enriched = {
      ...payload,
      shiftId: activeShift.id,
      terminalId: activeShift.terminalId,
      cashierId: auth.session.userId || auth.session.id,
    };
    const saved = localDb.addSaleToQueue(enriched);
    try { masterSqlite.addLocalSale(enriched); } catch (err) {
      console.warn('[sqlite] local sale persist failed', err.message);
    }
    console.log('[offline] Sale queued locally:', saved.id);
    return { success: true, data: saved, message: 'Sale saved locally. Will sync on next sync.' };
  });


  ipcMain.handle('pos:enterShift', () => {
    showShiftScreen();
    return true;
  });

  ipcMain.handle('pos:enterSell', () => {
    if (!activeShift) return { success: false, message: 'Open a shift first' };
    showSellScreen();
    return { success: true };
  });

  ipcMain.handle('pos:getShiftHistory', async (_event, paramsString) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    return posApi.getShiftHistory(auth.session.accessToken, paramsString);
  });

  ipcMain.handle('pos:suspendShift', async (_event, shiftId) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    const res = await posApi.suspendShift(auth.session.accessToken, shiftId);
    if (res.success) activeShift = null;
    return res;
  });

  ipcMain.handle('pos:recordCashFlow', async (_event, payload) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    return posApi.recordCashFlow(auth.session.accessToken, payload);
  });

  // ─── OFFLINE-FIRST: Barcode / QR / SKU lookup from local catalog ─────────
  ipcMain.handle('pos:byBarcode', async (_event, { code, locationId }) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    const needle = String(code || '').trim();
    if (!needle) return { success: false, message: 'Barcode is required' };

    try { masterSqlite.reloadFromDisk(); } catch { /* ignore */ }
    const local = masterSqlite.findByScanCode(needle);
    if (local) return { success: true, data: local };

    const cached = localDb.getProducts() || [];
    const lower = needle.toLowerCase();
    const cachedHit = cached.find((p) =>
      [p.barcode, p.barcodeNumber, p.sku, p.qrCode, p.qr_code]
        .some((v) => String(v || '').trim().toLowerCase() === lower)
    );
    if (cachedHit) return { success: true, data: cachedHit };

    try {
      return await posApi.byBarcode(auth.session.accessToken, needle, locationId);
    } catch (err) {
      return { success: false, message: err.message || `No product found for ${needle}` };
    }
  });


  // ─── OFFLINE-FIRST: Hold / retrieve / delete from local JSON ─────────────
  ipcMain.handle('pos:holdSale', async (_event, payload) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    const saved = localDb.addHeldSale(payload);
    return { success: true, data: saved };
  });

  ipcMain.handle('pos:getHeldSales', async () => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    return { success: true, data: localDb.getHeldSales() };
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
    const salesQueue = localDb.getSalesQueue();
    const returnsQueue = localDb.getReturnsQueue();
    const shiftsQueue = localDb.getShiftsQueue();

    const results = { sales: null, returns: null, shifts: null, cacheRefreshed: false, errors: [] };

    // 1) Upload queued sales
    if (salesQueue.length > 0) {
      const res = await posApi.syncOfflineSales(token, { sales: salesQueue });
      results.sales = res;
      if (res.success) {
        localDb.clearSalesQueue();
        console.log(`[sync] ${salesQueue.length} sale(s) uploaded.`);
      } else {
        results.errors.push(`Sales sync failed: ${res.message}`);
      }
    } else {
      results.sales = { success: true, message: 'No sales to sync.' };
    }

    // 2) Upload queued returns
    if (returnsQueue.length > 0) {
      const res = await posApi.syncOfflineSales(token, { returns: returnsQueue });
      results.returns = res;
      if (res.success) {
        localDb.clearReturnsQueue();
        console.log(`[sync] ${returnsQueue.length} return(s) uploaded.`);
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
      results.cacheRefreshed = true;
      console.log('[sync] Local caches refreshed from server.');
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
    const enriched = { ...payload, shiftId: activeShift.id };
    const saved = localDb.addReturnToQueue(enriched);
    console.log('[offline] Return queued locally:', saved.id);

    // Update stock in local SQLite for "local flow only" desktop app parity
    try {
      masterSqlite.reloadFromDisk();
      // Persist the return transaction locally in SQLite
      masterSqlite.addLocalReturn(enriched);

      for (const item of payload.items || []) {
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

  ipcMain.handle('pos:listLocalReturns', async () => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    masterSqlite.reloadFromDisk();
    return {
      success: true,
      offline: true,
      data: { returns: masterSqlite.listAllLocalReturns() },
    };
  });


  ipcMain.handle('pos:getShiftReport', async (_event, shiftId) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    return posApi.getShiftReport(auth.session.accessToken, shiftId);
  });

  ipcMain.handle('pos:getDailyReport', async (_event, paramsString) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    return posApi.getDailyReport(auth.session.accessToken, paramsString);
  });

  ipcMain.handle('pos:verifyManager', async (_event, payload) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    return posApi.verifyManager(auth.session.accessToken, payload);
  });

  // ─── OFFLINE-FIRST: Categories from local cache ───────────────────────────
  handle('pos:getCategories', async (_event, paramsString) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    try {
      masterSqlite.reloadFromDisk();
      return { success: true, data: masterSqlite.getCategoryTree() };
    } catch (err) {
      // Local catalog not open / read failed — try to open it once, then retry.
      console.warn('[pos:getCategories] local read failed, reopening:', err.message);
      try {
        const { app } = require('electron');
        await masterSqlite.open(app.getPath('userData'));
        return { success: true, data: masterSqlite.getCategoryTree() };
      } catch (err2) {
        console.error('[pos:getCategories] reopen failed', err2.message);
        return { success: false, message: err2.message || 'Local catalog unavailable' };
      }
    }
  });


  // ─── OFFLINE-FIRST: Customer search from local cache ─────────────────────
  ipcMain.handle('pos:searchCustomers', async (_event, { q, limit }) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    const query = (q || '').trim().toLowerCase();
    const localHits = masterSqlite.searchCustomers({ query, limit: limit || 20 });
    if (localHits.length) return { success: true, data: localHits };
    let customers = localDb.getCustomers();
    if (!customers || customers.length === 0) {
      const res = await posApi.fetchAllCustomers(auth.session.accessToken);
      if (res.success && Array.isArray(res.data)) {
        localDb.saveCustomers(res.data);
        masterSqlite.applyPage({ customers: res.data });
        customers = res.data;
      } else {
        return res;
      }
    }
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
  });


  ipcMain.handle('pos:createCustomer', async (_event, payload) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    const res = await posApi.createCustomer(auth.session.accessToken, payload);
    const created = res?.data || res?.customer;
    if (res?.success && created) {
      try { masterSqlite.upsertCustomer(created); } catch (_) { /* ignore */ }
      const cached = localDb.getCustomers() || [];
      const id = created.id || created._id;
      localDb.saveCustomers([created, ...cached.filter((c) => (c.id || c._id) !== id)]);
    }
    return res;
  });

  ipcMain.handle('pos:getCustomerCreditInfo', async (_event, customerId) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    return posApi.getCustomerCreditInfo(auth.session.accessToken, customerId);
  });

  ipcMain.handle('pos:getReceiptSettings', async () => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    return posApi.getReceiptSettings(auth.session.accessToken);
  });

  ipcMain.handle('pos:getProfile', async () => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    return posApi.getProfile(auth.session.accessToken);
  });

  // ─── POS Management / Admin IPC Handlers ──────────────────────────────────
  ipcMain.handle('pos:createTerminal', async (_event, payload) => {
    const auth = requireAdmin();
    if (!auth.ok) return auth.result;
    return posApi.createTerminal(auth.session.accessToken, payload);
  });

  ipcMain.handle('pos:updateTerminal', async (_event, { id, body }) => {
    const auth = requireAdmin();
    if (!auth.ok) return auth.result;
    return posApi.updateTerminal(auth.session.accessToken, id, body);
  });

  ipcMain.handle('pos:deleteTerminal', async (_event, id) => {
    const auth = requireAdmin();
    if (!auth.ok) return auth.result;
    return posApi.deleteTerminal(auth.session.accessToken, id);
  });

  ipcMain.handle('pos:reopenShift', async (_event, id) => {
    const auth = requireAdmin();
    if (!auth.ok) return auth.result;
    return posApi.reopenShift(auth.session.accessToken, id);
  });

  ipcMain.handle('pos:listLocalSales', async () => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    masterSqlite.reloadFromDisk();
    // Return raw local sales; the renderer computes totals/cashier grouping
    // using its own helper functions (kept client-side only).
    return {
      success: true,
      offline: true,
      data: { sales: masterSqlite.listAllLocalSales() },
    };
  });

  ipcMain.handle('pos:listSales', async (_event, paramsString) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    return posApi.listSales(auth.session.accessToken, paramsString);
  });

  ipcMain.handle('pos:getSale', async (_event, id) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    return posApi.getSale(auth.session.accessToken, id);
  });

  ipcMain.handle('pos:voidSale', async (_event, { id, body }) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    return posApi.voidSale(auth.session.accessToken, id, body);
  });

  ipcMain.handle('pos:convertToInvoice', async (_event, { id, body }) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    return posApi.convertToInvoice(auth.session.accessToken, id, body);
  });

  ipcMain.handle('pos:getAuditLogs', async (_event, paramsString) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    return posApi.getAuditLogs(auth.session.accessToken, paramsString);
  });

  ipcMain.handle('pos:saveReceiptSettings', async (_event, body) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    return posApi.saveReceiptSettings(auth.session.accessToken, body);
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

  handle('catalog:list', () => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    // Refresh memory from disk so a stale/empty in-memory catalog can never
    // hide on-disk categories from the Categories page.
    masterSqlite.reloadFromDiskSafe();
    return { success: true, data: masterSqlite.listCatalog() };
  });

  handle('catalog:listSuppliers', async () => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    masterSqlite.reloadFromDiskSafe();
    let rows = masterSqlite.listSuppliers();
    if (!rows.length && auth.session?.accessToken) {
      try {
        const fetched = await posApi.fetchAllSuppliers(auth.session.accessToken);
        const list = Array.isArray(fetched?.data)
          ? fetched.data
          : Array.isArray(fetched?.data?.data)
            ? fetched.data.data
            : [];
        if (list.length) {
          masterSqlite.applyPage({ suppliers: list });
          rows = masterSqlite.listSuppliers();
        }
        console.log('[catalog:listSuppliers] cloud', list.length, 'local', rows.length);
      } catch (err) {
        console.error('[catalog:listSuppliers] fetch failed', err.message);
      }
    }
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
    return { success: true, data: masterSqlite.listProducts() };
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

  // ── Sales Orders ──────────────────────────────────────────────────────────
  ipcMain.handle('sales:getOrders', async (_event, params) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    return salesApi.getOrders(auth.session.accessToken, params || {});
  });

  ipcMain.handle('sales:createOrder', async (_event, data) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    return salesApi.createOrder(auth.session.accessToken, data);
  });

  ipcMain.handle('sales:updateStatus', async (_event, payload) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    return salesApi.updateOrderStatus(
      auth.session.accessToken,
      payload?.id,
      payload?.status,
      payload?.reason
    );
  });

  ipcMain.handle('sales:cancelOrder', async (_event, payload) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    return salesApi.cancelOrder(auth.session.accessToken, payload?.id, payload?.reason);
  });

  ipcMain.handle('sales:deleteOrder', async (_event, payload) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    return salesApi.deleteOrder(auth.session.accessToken, payload?.id);
  });

  // ── Customers ─────────────────────────────────────────────────────────────
  ipcMain.handle('customers:list', async (_event, params) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    return salesApi.getCustomers(auth.session.accessToken, params || {});
  });

  ipcMain.handle('customers:search', async (_event, payload) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    return salesApi.searchCustomers(
      auth.session.accessToken,
      payload?.q || '',
      payload?.limit || 20
    );
  });

  // ── Products ──────────────────────────────────────────────────────────────
  ipcMain.handle('products:list', async (_event, params) => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    return salesApi.getProducts(auth.session.accessToken, params || {});
  });

  // ── Tax ───────────────────────────────────────────────────────────────────
  ipcMain.handle('tax:getContext', async () => {
    const auth = requireAuth();
    if (!auth.ok) return auth.result;
    return salesApi.getTaxContext(auth.session.accessToken);
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
}

function watchSessionExpiry() {
  if (sessionWatchTimer) clearInterval(sessionWatchTimer);
  sessionWatchTimer = setInterval(() => {
    const sessionData = authStore.readSession(userData());
    if (sessionData && authStore.isExpired(sessionData)) {
      authStore.clearSession(userData());
      appView?.webContents.send('auth:expired');
    }
  }, 30_000);
}

app.whenReady().then(async () => {
  // Initialise local JSON database in the OS user-data folder
  localDb.initialize(app.getPath('userData'));
  try {
    await masterSqlite.open(app.getPath('userData'));
  } catch (err) {
    console.error('[sqlite] failed to open catalog', err.message);
  }
  rendererOrigin = config.originOf(config.resolveAppUrl(app.isPackaged));
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
});
