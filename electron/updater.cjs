// Auto-update from GitHub Releases (AmirFoodDelivery/KSTRL).
// Works for the installed (NSIS) build; the portable .exe can't replace itself.
const { app } = require('electron');

let autoUpdater = null;
let state = { status: 'idle' };
let sendFn = () => {};

const isPortable = () => !!process.env.PORTABLE_EXECUTABLE_FILE;
const supported = () => app.isPackaged && process.platform === 'win32' && !isPortable();

function set(next) {
  state = { ...state, ...next };
  sendFn('update:status', state);
}

function init(send) {
  sendFn = send;
  if (!supported()) {
    state = { status: 'unsupported', reason: !app.isPackaged ? 'dev' : isPortable() ? 'portable' : 'platform' };
    return;
  }
  autoUpdater = require('electron-updater').autoUpdater;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => set({ status: 'checking', error: null }));
  autoUpdater.on('update-available', (i) => set({ status: 'downloading', version: i.version, percent: 0 }));
  autoUpdater.on('update-not-available', () => set({ status: 'current', checkedAt: Date.now() }));
  autoUpdater.on('download-progress', (p) => set({ status: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (i) => set({ status: 'ready', version: i.version, notes: typeof i.releaseNotes === 'string' ? i.releaseNotes : '' }));
  autoUpdater.on('error', (e) => set({ status: 'error', error: String(e && e.message ? e.message : e).split('\n')[0] }));

  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 8000); // shortly after launch
  setInterval(check, 4 * 60 * 60 * 1000); // and every 4 hours
}

function check() {
  if (!autoUpdater) return state;
  autoUpdater.checkForUpdates().catch(() => {});
  return state;
}

function install() {
  if (autoUpdater && state.status === 'ready') setImmediate(() => autoUpdater.quitAndInstall(false, true));
}

module.exports = { init, check, install, getState: () => ({ ...state, current: app.getVersion() }) };
