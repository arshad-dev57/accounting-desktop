
const fs = require('fs');
const path = require('path');
const { safeStorage } = require('electron');

const BIN_FILE = 'session.enc';
const PLAIN_FILE = 'session.json';

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
    return payload.exp ? Number(payload.exp) * 1000 : null;
  } catch {
    return null;
  }
}

function isExpired(session) {
  if (!session?.accessToken) return true;
  const exp = session.expiresAt || decodeJwtExpMs(session.accessToken);
  if (!exp) return false;
  return Date.now() >= exp - 15_000;
}

function writeSession(userData, session) {
  const { bin, json } = paths(userData);
  const payload = JSON.stringify({
    accessToken: session.accessToken || '',
    refreshToken: session.refreshToken || '',
    expiresAt: session.expiresAt || decodeJwtExpMs(session.accessToken),
    user: session.user || null,
    savedAt: Date.now(),
  });

  try {
    if (safeStorage.isEncryptionAvailable()) {
      fs.writeFileSync(bin, safeStorage.encryptString(payload));
      if (fs.existsSync(json)) fs.unlinkSync(json);
      return;
    }
  } catch (err) {
    console.error('[desktop] safeStorage encrypt failed', err);
  }

  fs.writeFileSync(json, payload, { mode: 0o600 });
}

function readSession(userData) {
  const { bin, json } = paths(userData);
  try {
    if (fs.existsSync(bin) && safeStorage.isEncryptionAvailable()) {
      return JSON.parse(safeStorage.decryptString(fs.readFileSync(bin)));
    }
    if (fs.existsSync(json)) {
      return JSON.parse(fs.readFileSync(json, 'utf8'));
    }
  } catch (err) {
    console.error('[desktop] failed to read session', err);
  }
  return null;
}

function clearSession(userData) {
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
    clearSession(userData);
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
