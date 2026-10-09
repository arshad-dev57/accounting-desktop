/**
 * Local POS ↔ Google Drive backup/restore.
 * Does NOT touch the cloud POS/accounting API or Railway server data.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const AdmZip = require('adm-zip');
const googleDrive = require('./google-drive.cjs');

const SETTINGS_FILE = 'drive-backup-settings.json';
const LOCAL_BACKUP_DIR = 'local-backups';

const DEFAULT_SETTINGS = {
  enabled: false,
  times: ['08:00', '14:00', '22:00'],
  clientId: '',
  clientSecret: '',
  lastBackupAt: null,
  lastBackupStatus: null,
  lastBackupError: null,
  lastRestoreAt: null,
  ranSlots: {}, // { '2026-09-08': ['08:00'] }
};

let userDataPath = '';
let localDb = null;
let masterSqlite = null;
let scheduleTimer = null;
let running = false;

function initialize(appUserDataPath, deps = {}) {
  userDataPath = appUserDataPath;
  localDb = deps.localDb;
  masterSqlite = deps.masterSqlite;
  googleDrive.initialize(appUserDataPath);
  ensureDirs();
  restartScheduler();
}

function ensureDirs() {
  const dir = path.join(userDataPath, LOCAL_BACKUP_DIR);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function settingsPath() {
  return path.join(userDataPath, SETTINGS_FILE);
}

function loadSettings() {
  try {
    if (fs.existsSync(settingsPath())) {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) };
    }
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_SETTINGS };
}

function saveSettings(partial) {
  const next = { ...loadSettings(), ...partial };
  // normalize times
  next.times = (next.times || DEFAULT_SETTINGS.times)
    .map((t) => String(t || '').trim())
    .filter((t) => /^\d{2}:\d{2}$/.test(t))
    .slice(0, 5);
  if (!next.times.length) next.times = [...DEFAULT_SETTINGS.times];
  fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2), 'utf8');
  restartScheduler();
  return getStatus();
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function nowSlot() {
  const d = new Date();
  return {
    dateKey: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`,
    timeKey: `${pad2(d.getHours())}:${pad2(d.getMinutes())}`,
  };
}

function companyDir() {
  const dir = localDb?.getCompanyDataPath?.();
  if (!dir || !fs.existsSync(dir)) {
    throw new Error('No company data loaded yet. Sign in and open POS first.');
  }
  return dir;
}

function companyId() {
  return localDb?.getActiveCompanyId?.() || 'unknown';
}

function buildZipName() {
  const d = new Date();
  const stamp = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}`;
  const host = os.hostname().replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 24) || 'pc';
  const cid = String(companyId()).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 20);
  return `POS-backup-${cid}-${host}-${stamp}.zip`;
}

function createLocalZip() {
  try {
    masterSqlite?.persist?.();
  } catch {
    /* ignore */
  }

  const sourceDir = companyDir();
  const zipName = buildZipName();
  const zipPath = path.join(userDataPath, LOCAL_BACKUP_DIR, zipName);
  const zip = new AdmZip();

  const entries = fs.readdirSync(sourceDir);
  for (const name of entries) {
    if (name.startsWith('.')) continue;
    const full = path.join(sourceDir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      zip.addLocalFolder(full, name);
    } else {
      zip.addLocalFile(full, '', name);
    }
  }

  const manifest = {
    app: 'accounting-desktop-app',
    type: 'pos-local-backup',
    companyId: companyId(),
    createdAt: new Date().toISOString(),
    hostname: os.hostname(),
    note: 'Local POS data only. Does not change cloud/server database.',
  };
  zip.addFile('backup-manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
  zip.writeZip(zipPath);
  return { zipPath, zipName, manifest };
}

async function runBackup({ reason = 'manual' } = {}) {
  if (running) throw new Error('A backup is already running');
  running = true;
  const settings = loadSettings();
  try {
    if (!googleDrive.isConnected()) {
      throw new Error('Connect Google Drive first');
    }
    const { zipPath, zipName } = createLocalZip();
    const uploaded = await googleDrive.uploadFile(settings, {
      localPath: zipPath,
      fileName: zipName,
    });

    // keep last 5 local zips
    pruneLocalBackups(5);

    const status = {
      enabled: settings.enabled,
      lastBackupAt: new Date().toISOString(),
      lastBackupStatus: 'ok',
      lastBackupError: null,
      lastBackupFile: zipName,
      lastBackupDriveId: uploaded.id,
      lastBackupReason: reason,
    };
    saveSettings(status);
    return { success: true, ...status, driveFile: uploaded };
  } catch (err) {
    saveSettings({
      lastBackupAt: new Date().toISOString(),
      lastBackupStatus: 'error',
      lastBackupError: err.message || String(err),
      lastBackupReason: reason,
    });
    throw err;
  } finally {
    running = false;
  }
}

function pruneLocalBackups(keep) {
  const dir = path.join(userDataPath, LOCAL_BACKUP_DIR);
  if (!fs.existsSync(dir)) return;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.zip'))
    .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  files.slice(keep).forEach(({ f }) => {
    try {
      fs.unlinkSync(path.join(dir, f));
    } catch {
      /* ignore */
    }
  });
}

async function listRemoteBackups() {
  const settings = loadSettings();
  if (!googleDrive.isConnected()) throw new Error('Connect Google Drive first');
  return googleDrive.listBackups(settings);
}

async function runRestore(fileId) {
  if (!fileId) throw new Error('Select a backup file');
  if (running) throw new Error('Backup/restore already running');
  running = true;
  const settings = loadSettings();
  const tmpZip = path.join(userDataPath, LOCAL_BACKUP_DIR, `restore-${Date.now()}.zip`);
  const target = companyDir();

  try {
    // safety local snapshot before overwrite
    try {
      createLocalZip();
    } catch {
      /* still allow restore */
    }

    await googleDrive.downloadFile(settings, fileId, tmpZip);

    try {
      masterSqlite?.persist?.();
    } catch {
      /* ignore */
    }
    try {
      await masterSqlite?.close?.();
    } catch {
      /* ignore */
    }

    const zip = new AdmZip(tmpZip);
    const entries = zip.getEntries();
    for (const entry of entries) {
      if (entry.isDirectory) continue;
      if (entry.entryName === 'backup-manifest.json') continue;
      const dest = path.join(target, entry.entryName);
      const destDir = path.dirname(dest);
      if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
      fs.writeFileSync(dest, entry.getData());
    }

    // reopen sqlite for current company
    try {
      await masterSqlite?.open?.(userDataPath, { companyId: companyId() });
    } catch (err) {
      console.warn('[drive-backup] reopen sqlite after restore', err.message);
    }

    saveSettings({ lastRestoreAt: new Date().toISOString() });
    return {
      success: true,
      message: 'Backup restored to this PC. Reloading POS data is recommended.',
      restoredAt: new Date().toISOString(),
    };
  } finally {
    running = false;
    try {
      if (fs.existsSync(tmpZip)) fs.unlinkSync(tmpZip);
    } catch {
      /* ignore */
    }
  }
}

function getStatus() {
  const settings = loadSettings();
  const { clientId, clientSecret } = googleDrive.getClientConfig(settings);
  return {
    enabled: Boolean(settings.enabled),
    times: settings.times || DEFAULT_SETTINGS.times,
    connected: googleDrive.isConnected(),
    accountEmail: googleDrive.getAccountEmail(),
    hasOAuthConfig: Boolean(clientId && clientSecret),
    clientIdSet: Boolean(clientId),
    clientSecretSet: Boolean(clientSecret),
    clientId: settings.clientId || '',
    // never return secret value to renderer — only whether set / allow save
    lastBackupAt: settings.lastBackupAt,
    lastBackupStatus: settings.lastBackupStatus,
    lastBackupError: settings.lastBackupError,
    lastBackupFile: settings.lastBackupFile || null,
    lastRestoreAt: settings.lastRestoreAt,
    folderName: googleDrive.FOLDER_NAME,
    affectsCloudServer: false,
    guide: {
      title: 'Google Drive backup (this PC only)',
      points: [
        'Backups copy THIS computer’s POS data (sales queue, catalog, shifts) to your Google Drive.',
        'Your cloud / Railway accounting server is NOT changed by backup or restore.',
        'Turn ON scheduled backup, set up to 3 daily times, then Connect Google.',
        'Google opens in the browser — allow access, then return here.',
        'Restore: pick a Drive backup by date/time — it overwrites local data on this PC only.',
        'App must be open for scheduled backups to run.',
      ],
    },
  };
}

async function connectDrive() {
  const settings = loadSettings();
  const result = await googleDrive.connect(settings);
  return { ...getStatus(), ...result };
}

function disconnectDrive() {
  googleDrive.disconnect();
  return getStatus();
}

function restartScheduler() {
  if (scheduleTimer) {
    clearInterval(scheduleTimer);
    scheduleTimer = null;
  }
  scheduleTimer = setInterval(() => {
    tickSchedule().catch((err) => {
      console.warn('[drive-backup] schedule', err.message);
    });
  }, 30_000);
  // first check soon
  setTimeout(() => {
    tickSchedule().catch(() => {});
  }, 5_000);
}

async function tickSchedule() {
  const settings = loadSettings();
  if (!settings.enabled) return;
  if (!googleDrive.isConnected()) return;
  if (running) return;

  const { dateKey, timeKey } = nowSlot();
  const times = settings.times || [];
  if (!times.includes(timeKey)) return;

  const ran = { ...(settings.ranSlots || {}) };
  const today = new Set(ran[dateKey] || []);
  if (today.has(timeKey)) return;

  today.add(timeKey);
  ran[dateKey] = [...today];
  // prune old days
  Object.keys(ran).forEach((k) => {
    if (k < dateKey) delete ran[k];
  });
  saveSettings({ ranSlots: ran });

  await runBackup({ reason: `schedule:${timeKey}` });
}

function stop() {
  if (scheduleTimer) {
    clearInterval(scheduleTimer);
    scheduleTimer = null;
  }
}

module.exports = {
  initialize,
  getStatus,
  saveSettings,
  connectDrive,
  disconnectDrive,
  runBackup,
  listRemoteBackups,
  runRestore,
  stop,
};
