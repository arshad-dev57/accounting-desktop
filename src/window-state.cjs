/**
 * Remember window size and position between launches.
 */
const fs = require('fs');
const path = require('path');
const { screen } = require('electron');

const FILE_NAME = 'window-state.json';
const DEFAULT_BOUNDS = { width: 1280, height: 800, isMaximized: false };

function statePath(userData) {
  return path.join(userData, FILE_NAME);
}

function read(userData) {
  try {
    return { ...DEFAULT_BOUNDS, ...JSON.parse(fs.readFileSync(statePath(userData), 'utf8')) };
  } catch {
    return { ...DEFAULT_BOUNDS };
  }
}

function isVisibleOnAnyDisplay(bounds) {
  if (typeof bounds.x !== 'number' || typeof bounds.y !== 'number') return false;
  return screen.getAllDisplays().some((d) => {
    const { x, y, width, height } = d.workArea;
    return (
      bounds.x + 40 < x + width &&
      bounds.x + bounds.width - 40 > x &&
      bounds.y + 40 < y + height &&
      bounds.y + 80 > y
    );
  });
}

function load(userData) {
  const saved = read(userData);
  if (!isVisibleOnAnyDisplay(saved)) {
    return {
      width: saved.width || DEFAULT_BOUNDS.width,
      height: saved.height || DEFAULT_BOUNDS.height,
      isMaximized: false,
    };
  }
  return saved;
}

function save(userData, win) {
  if (!win || win.isDestroyed()) return;
  const isMaximized = win.isMaximized();
  const bounds = isMaximized ? read(userData) : win.getBounds();
  try {
    fs.writeFileSync(
      statePath(userData),
      JSON.stringify(
        {
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
          isMaximized,
        },
        null,
        2
      )
    );
  } catch (err) {
    console.error('[desktop] failed to save window state', err);
  }
}

function track(userData, win) {
  const persist = () => save(userData, win);
  win.on('resize', persist);
  win.on('move', persist);
  win.on('close', persist);
}

module.exports = { load, save, track, DEFAULT_BOUNDS };
