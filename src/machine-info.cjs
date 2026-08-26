/**
 * Host machine + local app storage stats for the Settings screen.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');

function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '0 B';
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n;
  let i = -1;
  do {
    value /= 1024;
    i += 1;
  } while (value >= 1024 && i < units.length - 1);
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${units[i]}`;
}

function fileSize(filePath) {
  try {
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      return fs.statSync(filePath).size;
    }
  } catch {
    /* ignore */
  }
  return 0;
}

function dirSize(dirPath, depth = 0) {
  if (depth > 8) return 0;
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    try {
      if (entry.isDirectory()) total += dirSize(full, depth + 1);
      else if (entry.isFile()) total += fs.statSync(full).size;
    } catch {
      /* ignore locked files */
    }
  }
  return total;
}

function diskFor(targetPath) {
  try {
    const stats = fs.statfsSync(targetPath);
    const block = Number(stats.bsize || stats.frsize || 0);
    const total = Number(stats.blocks || 0) * block;
    const free = Number(stats.bavail != null ? stats.bavail : stats.bfree || 0) * block;
    const used = Math.max(0, total - free);
    return {
      total,
      free,
      used,
      totalLabel: formatBytes(total),
      freeLabel: formatBytes(free),
      usedLabel: formatBytes(used),
      percentUsed: total > 0 ? Math.round((used / total) * 100) : 0,
    };
  } catch (err) {
    return {
      total: 0,
      free: 0,
      used: 0,
      totalLabel: '—',
      freeLabel: '—',
      usedLabel: '—',
      percentUsed: 0,
      error: err.message,
    };
  }
}

function platformLabel(platform) {
  if (platform === 'darwin') return 'macOS';
  if (platform === 'win32') return 'Windows';
  if (platform === 'linux') return 'Linux';
  return platform;
}

function collect(app, userDataPath) {
  const cpus = os.cpus() || [];
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = Math.max(0, totalMem - freeMem);
  const disk = diskFor(userDataPath);

  const catalogDb = path.join(userDataPath, 'pos-master.sqlite');
  const cacheFiles = [
    'cache_products.json',
    'cache_categories.json',
    'cache_customers.json',
    'cache_tax_context.json',
  ];
  const queueFiles = [
    'queue_sales.json',
    'queue_returns.json',
    'queue_shifts.json',
    'queue_held.json',
  ];
  const sessionFiles = ['session.bin', 'session.json', 'window-state.json'];

  const catalogBytes = fileSize(catalogDb);
  const cacheBytes = cacheFiles.reduce((sum, name) => sum + fileSize(path.join(userDataPath, name)), 0);
  const queueBytes = queueFiles.reduce((sum, name) => sum + fileSize(path.join(userDataPath, name)), 0);
  const sessionBytes = sessionFiles.reduce((sum, name) => sum + fileSize(path.join(userDataPath, name)), 0);
  const appDataBytes = dirSize(userDataPath);
  let installBytes = 0;
  try {
    installBytes = dirSize(app.getAppPath());
  } catch {
    installBytes = 0;
  }

  return {
    computer: {
      hostname: os.hostname(),
      username: os.userInfo().username,
      platform: platformLabel(os.platform()),
      arch: os.arch(),
      osRelease: os.release(),
      cpu: cpus[0]?.model || 'Unknown CPU',
      cores: cpus.length,
      memory: {
        total: totalMem,
        free: freeMem,
        used: usedMem,
        totalLabel: formatBytes(totalMem),
        freeLabel: formatBytes(freeMem),
        usedLabel: formatBytes(usedMem),
        percentUsed: totalMem > 0 ? Math.round((usedMem / totalMem) * 100) : 0,
      },
    },
    disk,
    storage: {
      userDataPath: userDataPath,
      appDataBytes,
      appDataLabel: formatBytes(appDataBytes),
      catalogBytes,
      catalogLabel: formatBytes(catalogBytes),
      cacheBytes,
      cacheLabel: formatBytes(cacheBytes),
      queueBytes,
      queueLabel: formatBytes(queueBytes),
      sessionBytes,
      sessionLabel: formatBytes(sessionBytes),
      installBytes,
      installLabel: formatBytes(installBytes),
    },
    app: {
      name: app.getName(),
      version: app.getVersion(),
      packaged: app.isPackaged,
    },
  };
}

module.exports = { collect, formatBytes };
