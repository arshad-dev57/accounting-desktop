/**
 * Desktop env. The Next.js POS keeps its own API_URL / .env.local.
 * This file only decides which web URL the native window opens.
 */
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '..', '.env') });
dotenv.config({ path: path.join(__dirname, '..', '.env.local'), override: true });

const DEFAULT_LOCAL = 'http://127.0.0.1:3000';
const DEFAULT_PROD = 'https://app.bisonstechs.com';
const DEFAULT_API = 'https://accountbackend-production-eaf5.up.railway.app';

function stripSlash(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

/** Local backend is plain HTTP — https://localhost causes ERR_SSL_WRONG_VERSION_NUMBER. */
function normalizeLocalApiUrl(url) {
  const raw = stripSlash(url);
  if (!raw) return raw;
  try {
    const u = new URL(raw);
    const host = String(u.hostname || '').toLowerCase();
    const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1';
    if (isLocal && u.protocol === 'https:') {
      u.protocol = 'http:';
      return stripSlash(u.toString());
    }
  } catch {
    /* keep as-is */
  }
  return raw;
}

function resolveAppUrl(isPackaged) {
  const fromEnv = stripSlash(process.env.ELECTRON_APP_URL);
  if (fromEnv) return fromEnv;
  return isPackaged ? DEFAULT_PROD : DEFAULT_LOCAL;
}

function resolveApiUrl() {
  const fromEnv = normalizeLocalApiUrl(process.env.ELECTRON_API_URL);
  if (fromEnv) return fromEnv;
  return DEFAULT_API;
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

function loginUrl(origin) {
  return `${stripSlash(origin)}/login`;
}

function posUrl(origin) {
  return `${stripSlash(origin)}/pos`;
}

/** After native login, only the POS web UI is allowed. */
function isDesktopAllowedPath(pathname) {
  const p = pathname || '/';
  if (p.startsWith('/_next') || p.startsWith('/api')) return true;
  if (p === '/pos' || p.startsWith('/pos/')) return true;
  if (p === '/favicon.ico' || p.startsWith('/assets')) return true;
  return false;
}

function isDesktopAuthPath(pathname) {
  const p = pathname || '/';
  return p === '/login' || p.startsWith('/login/');
}

module.exports = {
  DEFAULT_LOCAL,
  DEFAULT_PROD,
  DEFAULT_API,
  TITLEBAR_HEIGHT: 36,
  resolveAppUrl,
  resolveApiUrl,
  originOf,
  loginUrl,
  posUrl,
  isDesktopAllowedPath,
  isDesktopAuthPath,
};
