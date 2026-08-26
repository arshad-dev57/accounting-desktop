/**
 * Optional auto-update. Skipped unless ELECTRON_UPDATE_URL is set
 * or electron-builder publish is configured later.
 */
const { dialog } = require('electron');

async function setupAutoUpdate(app) {
  if (!app.isPackaged) return;

  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch {
    console.warn('[desktop] electron-updater not installed; skipping updates');
    return;
  }

  autoUpdater.autoDownload = false;
  autoUpdater.logger = console;

  const genericUrl = (process.env.ELECTRON_UPDATE_URL || '').trim();
  if (genericUrl) {
    autoUpdater.setFeedURL({ provider: 'generic', url: genericUrl });
  }

  autoUpdater.on('update-available', async (info) => {
    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: 'Update available',
      message: `Bisonstechs POS ${info.version} is available.`,
      detail: 'Download and install now? The app will restart after the update.',
      buttons: ['Update', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) await autoUpdater.downloadUpdate();
  });

  autoUpdater.on('update-downloaded', async () => {
    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: 'Update ready',
      message: 'Restart now to apply the update?',
      buttons: ['Restart', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });

  autoUpdater.on('error', (err) => {
    console.warn('[desktop] auto-update error', err?.message || err);
  });

  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    console.warn('[desktop] update check skipped', err?.message || err);
  }
}

module.exports = { setupAutoUpdate };
