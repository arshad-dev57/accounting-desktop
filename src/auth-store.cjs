
const fs = require('fs');
const path = require('path');
const { safeStorage } = require('electron');

const BIN_FILE = 'session.enc';
const PLAIN_FILE = 'session.json';

/** In-memory copy so requireAuth still works if disk write/read glitches. */
let memorySession = null;

function paths(userData) {
  return {
    bin: path.join(userData, BIN_FILE),
    json: path.join(userData, PLAIN_FILE),
  };
}

function decodeJwtExpMs(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    const expSec = Number(payload.exp);
    if (!Number.isFinite(expSec) || expSec <= 0) return null;
    return expSec * 1000;
  } catch {
    return null;
  }
}

function normalizeSession(session) {
  if (!session || typeof session !== 'object') return null;
  const accessToken = String(session.accessToken || '').trim();
  if (!accessToken) return null;
  const expFromJwt = decodeJwtExpMs(accessToken);
  let expiresAt = session.expiresAt != null ? Number(session.expiresAt) : expFromJwt;
  // Guard: some callers accidentally store exp in seconds
  if (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt < 1e12 && expFromJwt) {
    expiresAt = expFromJwt;
  }
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
    expiresAt = expFromJwt || null;
  }
  return {
    accessToken,
    refreshToken: String(session.refreshToken || '').trim(),
    expiresAt,
    user: session.user || null,
    activeCompanyId: String(session.activeCompanyId || session.user?.companyId || '').trim(),
    savedAt: session.savedAt || Date.now(),
  };
}

function isExpired(session) {
  const normalized = normalizeSession(session);
  if (!normalized?.accessToken) return true;
  const exp = normalized.expiresAt || decodeJwtExpMs(normalized.accessToken);
  if (!exp) return false;
  return Date.now() >= exp - 15_000;
}

function writeSession(userData, session) {
  const normalized = normalizeSession(session);
  if (!normalized) {
    console.error('[desktop] writeSession refused — missing accessToken');
    return false;
  }
  memorySession = normalized;
  const { bin, json } = paths(userData);
  const payload = JSON.stringify(normalized);

  let encryptedOk = false;
  try {
    if (safeStorage.isEncryptionAvailable()) {
      fs.writeFileSync(bin, safeStorage.encryptString(payload));
      encryptedOk = true;
    }
  } catch (err) {
    console.error('[desktop] safeStorage encrypt failed', err);
  }

  // Always keep a plaintext fallback in dev so a bad encrypt/decrypt cannot wipe login.
  try {
    fs.writeFileSync(json, payload, { mode: 0o600 });
  } catch (err) {
    console.error('[desktop] session.json write failed', err);
    if (!encryptedOk) return false;
  }

  if (encryptedOk) {
    // Keep both; decrypt issues can fall back to json.
  }
  console.log(
    '[desktop] session saved',
    'exp=',
    normalized.expiresAt ? new Date(normalized.expiresAt).toISOString() : 'none',
    'company=',
    normalized.activeCompanyId || '-'
  );
  return true;
}

function readSession(userData) {
  const { bin, json } = paths(userData);
  try {
    if (fs.existsSync(bin) && safeStorage.isEncryptionAvailable()) {
      try {
        const parsed = normalizeSession(JSON.parse(safeStorage.decryptString(fs.readFileSync(bin))));
        if (parsed?.accessToken) {
          memorySession = parsed;
          return parsed;
        }
      } catch (err) {
        console.error('[desktop] session.enc decrypt failed, trying session.json', err.message || err);
      }
    }
    if (fs.existsSync(json)) {
      const parsed = normalizeSession(JSON.parse(fs.readFileSync(json, 'utf8')));
      if (parsed?.accessToken) {
        memorySession = parsed;
        return parsed;
      }
    }
  } catch (err) {
    console.error('[desktop] failed to read session', err);
  }
  if (memorySession?.accessToken) return memorySession;
  return null;
}

function clearSession(userData) {
  memorySession = null;
  const { bin, json } = paths(userData);
  for (const file of [bin, json]) {
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch {
      // ignore
    }
  }
}

function getValidSession(userData) {
  const session = readSession(userData);
  if (!session?.accessToken) return null;
  if (isExpired(session)) {
    // Do NOT delete the file here — watchSessionExpiry / logout own that.
    // Clearing on every requireAuth made sync show "Please sign in again"
    // while the sell UI was still open.
    return null;
  }
  return session;
}

module.exports = {
  writeSession,
  readSession,
  clearSession,
  getValidSession,
  isExpired,
  decodeJwtExpMs,
};
