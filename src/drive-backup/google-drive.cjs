/**
 * Google Drive OAuth (desktop loopback) + file upload/list/download.
 * Uses Drive scope drive.file only — app-created files. No cloud POS server involved.
 */
require('../config.cjs'); // load .env into process.env
const http = require('http');
const https = require('https');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');
const { shell } = require('electron');

const SCOPES = ['https://www.googleapis.com/auth/drive.file'];
const TOKEN_FILE = 'google-drive-tokens.json';
const FOLDER_NAME = 'Bisonstechs POS Backups';

let userDataPath = '';
let oauthServer = null;

function initialize(basePath) {
  userDataPath = basePath;
}

function tokenPath() {
  return path.join(userDataPath, TOKEN_FILE);
}

function readTokens() {
  try {
    if (!fs.existsSync(tokenPath())) return null;
    return JSON.parse(fs.readFileSync(tokenPath(), 'utf8'));
  } catch {
    return null;
  }
}

function writeTokens(tokens) {
  fs.writeFileSync(tokenPath(), JSON.stringify(tokens, null, 2), 'utf8');
}

function clearTokens() {
  try {
    if (fs.existsSync(tokenPath())) fs.unlinkSync(tokenPath());
  } catch {
    /* ignore */
  }
}

function getClientConfig(settings = {}) {
  const clientId = String(
    settings.clientId || process.env.GOOGLE_OAUTH_CLIENT_ID || ''
  ).trim();
  const clientSecret = String(
    settings.clientSecret || process.env.GOOGLE_OAUTH_CLIENT_SECRET || ''
  ).trim();
  return { clientId, clientSecret };
}

function isConnected() {
  const t = readTokens();
  return Boolean(t?.access_token || t?.refresh_token);
}

function getAccountEmail() {
  return readTokens()?.email || null;
}

function httpsRequest(method, urlStr, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const req = https.request(
      {
        method,
        hostname: url.hostname,
        path: url.pathname + url.search,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          const text = buf.toString('utf8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = null;
          }
          if (res.statusCode >= 400) {
            const msg =
              json?.error?.message ||
              json?.error_description ||
              text ||
              `HTTP ${res.statusCode}`;
            const err = new Error(msg);
            err.status = res.statusCode;
            err.body = json;
            reject(err);
            return;
          }
          resolve({ status: res.statusCode, json, buf, headers: res.headers });
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function refreshAccessToken(settings) {
  const tokens = readTokens();
  if (!tokens?.refresh_token) {
    throw new Error('Google Drive not connected. Sign in again.');
  }
  const { clientId, clientSecret } = getClientConfig(settings);
  if (!clientId || !clientSecret) {
    throw new Error('Google OAuth Client ID / Secret missing in settings or .env');
  }
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: tokens.refresh_token,
    grant_type: 'refresh_token',
  }).toString();

  const res = await httpsRequest('POST', 'https://oauth2.googleapis.com/token', {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
    },
    body,
  });

  const next = {
    ...tokens,
    access_token: res.json.access_token,
    expiry_date: Date.now() + (res.json.expires_in || 3600) * 1000,
    token_type: res.json.token_type || 'Bearer',
  };
  if (res.json.refresh_token) next.refresh_token = res.json.refresh_token;
  writeTokens(next);
  return next;
}

async function getAccessToken(settings) {
  let tokens = readTokens();
  if (!tokens) throw new Error('Google Drive not connected');
  if (tokens.access_token && tokens.expiry_date && Date.now() < tokens.expiry_date - 60_000) {
    return tokens.access_token;
  }
  if (tokens.refresh_token) {
    tokens = await refreshAccessToken(settings);
    return tokens.access_token;
  }
  throw new Error('Google session expired. Connect Google Drive again.');
}

async function fetchUserEmail(accessToken) {
  try {
    const res = await httpsRequest(
      'GET',
      'https://www.googleapis.com/oauth2/v2/userinfo',
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    return res.json?.email || null;
  } catch {
    return null;
  }
}

function stopOAuthServer() {
  if (oauthServer) {
    try {
      oauthServer.close();
    } catch {
      /* ignore */
    }
    oauthServer = null;
  }
}

function connect(settings = {}) {
  return new Promise((resolve, reject) => {
    const { clientId, clientSecret } = getClientConfig(settings);
    if (!clientId || !clientSecret) {
      reject(
        new Error(
          'Google OAuth Client ID and Secret required. Add them in Settings or set GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET in .env'
        )
      );
      return;
    }

    stopOAuthServer();

    oauthServer = http.createServer(async (req, res) => {
      try {
        const reqUrl = new URL(req.url, 'http://127.0.0.1');
        if (reqUrl.pathname !== '/oauth2callback') {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        const err = reqUrl.searchParams.get('error');
        if (err) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(`<h2>Google sign-in failed</h2><p>${err}</p><p>You can close this window.</p>`);
          stopOAuthServer();
          reject(new Error(err));
          return;
        }
        const code = reqUrl.searchParams.get('code');
        if (!code) {
          res.writeHead(400);
          res.end('Missing code');
          return;
        }

        const redirectUri = `http://127.0.0.1:${oauthServer.address().port}/oauth2callback`;
        const body = new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }).toString();

        const tokenRes = await httpsRequest('POST', 'https://oauth2.googleapis.com/token', {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(body),
          },
          body,
        });

        const tokens = {
          access_token: tokenRes.json.access_token,
          refresh_token: tokenRes.json.refresh_token,
          expiry_date: Date.now() + (tokenRes.json.expires_in || 3600) * 1000,
          token_type: tokenRes.json.token_type || 'Bearer',
          scope: tokenRes.json.scope,
        };
        tokens.email = await fetchUserEmail(tokens.access_token);
        writeTokens(tokens);

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          '<h2>Google Drive connected</h2><p>You can close this window and return to Bisonstechs POS.</p>'
        );
        stopOAuthServer();
        resolve({ email: tokens.email, connected: true });
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end(`<h2>Error</h2><p>${e.message}</p>`);
        stopOAuthServer();
        reject(e);
      }
    });

    oauthServer.listen(0, '127.0.0.1', () => {
      const port = oauthServer.address().port;
      const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
      const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      authUrl.searchParams.set('client_id', clientId);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('scope', SCOPES.join(' '));
      authUrl.searchParams.set('access_type', 'offline');
      authUrl.searchParams.set('prompt', 'consent');
      shell.openExternal(authUrl.toString()).catch((e) => {
        stopOAuthServer();
        reject(e);
      });
    });

    oauthServer.on('error', (e) => {
      stopOAuthServer();
      reject(e);
    });

    setTimeout(() => {
      if (oauthServer) {
        stopOAuthServer();
        reject(new Error('Google sign-in timed out. Try again.'));
      }
    }, 5 * 60 * 1000);
  });
}

function disconnect() {
  stopOAuthServer();
  clearTokens();
  return { success: true };
}

async function ensureBackupFolder(settings) {
  const accessToken = await getAccessToken(settings);
  const q = encodeURIComponent(
    `name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`
  );
  const list = await httpsRequest(
    'GET',
    `https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&fields=files(id,name)`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (list.json?.files?.length) return list.json.files[0].id;

  const meta = JSON.stringify({
    name: FOLDER_NAME,
    mimeType: 'application/vnd.google-apps.folder',
  });
  const created = await httpsRequest('POST', 'https://www.googleapis.com/drive/v3/files', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(meta),
    },
    body: meta,
  });
  return created.json.id;
}

async function uploadFile(settings, { localPath, fileName, folderId }) {
  const accessToken = await getAccessToken(settings);
  const parentId = folderId || (await ensureBackupFolder(settings));
  const fileBuf = fs.readFileSync(localPath);
  const boundary = 'bisonstechs_pos_backup_' + Date.now();
  const meta = JSON.stringify({
    name: fileName,
    parents: [parentId],
  });
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
        `--${boundary}\r\nContent-Type: application/zip\r\n\r\n`
    ),
    fileBuf,
    Buffer.from(`\r\n--${boundary}--`),
  ]);

  const res = await httpsRequest(
    'POST',
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,createdTime,size,modifiedTime',
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
        'Content-Length': body.length,
      },
      body,
    }
  );
  return res.json;
}

async function listBackups(settings) {
  const accessToken = await getAccessToken(settings);
  const folderId = await ensureBackupFolder(settings);
  const q = encodeURIComponent(
    `'${folderId}' in parents and trashed=false and name contains 'POS-backup-'`
  );
  const res = await httpsRequest(
    'GET',
    `https://www.googleapis.com/drive/v3/files?q=${q}&orderBy=createdTime desc&pageSize=50&fields=files(id,name,createdTime,modifiedTime,size)`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  return (res.json?.files || []).map((f) => ({
    id: f.id,
    name: f.name,
    createdTime: f.createdTime,
    modifiedTime: f.modifiedTime,
    size: Number(f.size || 0),
  }));
}

async function downloadFile(settings, fileId, destPath) {
  const accessToken = await getAccessToken(settings);
  return new Promise((resolve, reject) => {
    const url = new URL(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`
    );
    const req = https.request(
      {
        method: 'GET',
        hostname: url.hostname,
        path: url.pathname + url.search,
        headers: { Authorization: `Bearer ${accessToken}` },
      },
      (res) => {
        if (res.statusCode >= 400) {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            reject(new Error(Buffer.concat(chunks).toString('utf8') || `Download failed ${res.statusCode}`));
          });
          return;
        }
        const out = fs.createWriteStream(destPath);
        res.pipe(out);
        out.on('finish', () => resolve(destPath));
        out.on('error', reject);
      }
    );
    req.on('error', reject);
    req.end();
  });
}

module.exports = {
  initialize,
  getClientConfig,
  isConnected,
  getAccountEmail,
  connect,
  disconnect,
  ensureBackupFolder,
  uploadFile,
  listBackups,
  downloadFile,
  FOLDER_NAME,
};
