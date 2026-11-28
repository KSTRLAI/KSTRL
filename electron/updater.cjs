// Updates from GitHub Releases (KSTRLAI/KSTRL), with a prompt.
//
// KSTRL checks shortly after it starts and every 4 hours. When a newer version exists the app shows
// "Update available" — Update now downloads it and restarts into the new version (silent install).
//
// The feed is the "latest" release's latest.yml, fetched through github.com/…/releases/latest/download/,
// which always points at the newest KSTRL release (never a Launch pre-release) and needs no GitHub API.
// Works for the installed (NSIS) build; the portable .exe can't replace itself.
const { app, shell } = require('electron');

const FEED = 'https://github.com/KSTRLAI/KSTRL/releases/latest/download';
const PAGE = 'https://github.com/KSTRLAI/KSTRL/releases/latest';

let autoUpdater = null;
let state = { status: 'idle' };
let sendFn = () => {};
let installWhenReady = false;

const isPortable = () => !!process.env.PORTABLE_EXECUTABLE_FILE;
const supported = () => app.isPackaged && process.platform === 'win32' && !isPortable();
const log = (...a) => { try { require('./crash.cjs').log?.('updater', a.join(' ')); } catch {} };

function set(next) {
  state = { ...state, ...next };
  sendFn('update:status', getState());
}

// Newer-than check for versions like 1.10.0 vs 1.9.2.
function newer(a, b) {
  const pa = String(a).split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); }
  return false;
}

// Builds that can't self-update (Mac, portable, dev) still get the prompt: it opens the download page.
async function checkByPage() {
  try {
    const res = await fetch(PAGE, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
    const loc = res.headers.get('location') || '';
    const m = loc.match(/\/tag\/v?([\d.]+)$/);
    if (!m) throw new Error('no release found');
    if (newer(m[1], app.getVersion())) set({ status: 'available', version: m[1], manual: true, checkedAt: Date.now() });
    else set({ status: 'current', checkedAt: Date.now() });
  } catch (e) { set({ status: 'error', error: `Couldn't check for updates (${e.message})` }); }
  return getState();
}

function init(send) {
  sendFn = send;
  if (!supported()) {
    state = { status: 'idle', manual: true, reason: !app.isPackaged ? 'dev' : isPortable() ? 'portable' : 'platform' };
    if (app.isPackaged) {
      setTimeout(() => { if (require('./settings.cjs').load().autoUpdate !== false) checkByPage(); }, 8000);
      setInterval(() => { if (require('./settings.cjs').load().autoUpdate !== false) checkByPage(); }, 4 * 60 * 60 * 1000);
    }
    return;
  }
  autoUpdater = require('electron-updater').autoUpdater;
  autoUpdater.setFeedURL({ provider: 'generic', url: FEED });
  autoUpdater.disableDifferentialDownload = true; // the generic feed can't locate the old version's blockmap
  autoUpdater.autoDownload = false; // ask first
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.logger = { info: (m) => log('info', m), warn: (m) => log('warn', m), error: (m) => log('error', m), debug: () => {} };
  autoUpdater.on('checking-for-update', () => set({ status: 'checking', error: null }));
  autoUpdater.on('update-available', (i) => set({ status: 'available', version: i.version, checkedAt: Date.now() }));
  autoUpdater.on('update-not-available', () => set({ status: 'current', checkedAt: Date.now() }));
  autoUpdater.on('download-progress', (p) => set({ status: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (i) => {
    set({ status: 'ready', version: i.version, notes: typeof i.releaseNotes === 'string' ? i.releaseNotes : '' });
    if (installWhenReady) install();
  });
  autoUpdater.on('error', (e) => { log('error', e && e.stack); set({ status: 'error', error: String(e && e.message ? e.message : e).split('\n')[0] }); });

  const auto = () => { if (require('./settings.cjs').load().autoUpdate !== false && !['downloading', 'ready'].includes(state.status)) autoUpdater.checkForUpdates().catch(() => {}); };
  setTimeout(auto, 8000); // shortly after launch
  setInterval(auto, 4 * 60 * 60 * 1000); // and every 4 hours
}

function setAuto() {}

// "Update now": download, then restart into the new version as soon as it's ready.
function download() {
  if (state.manual || !autoUpdater) { shell.openExternal(PAGE); return getState(); }
  installWhenReady = true;
  if (state.status === 'ready') { install(); return getState(); }
  set({ status: 'downloading', percent: 0, error: null });
  autoUpdater.downloadUpdate().catch((e) => set({ status: 'error', error: String(e && e.message ? e.message : e).split('\n')[0] }));
  return getState();
}

// Manual "Check for Updates": resolves with the result so the UI can say "You're up to date".
async function check() {
  if (!autoUpdater) return app.isPackaged ? checkByPage() : getState();
  if (['downloading', 'ready'].includes(state.status)) return getState();
  try { await autoUpdater.checkForUpdates(); } catch (e) { set({ status: 'error', error: String(e && e.message ? e.message : e).split('\n')[0] }); }
  return getState();
}

// Silent install (no setup wizard), then KSTRL reopens by itself — it feels like a restart.
function install() {
  if (autoUpdater && state.status === 'ready') setImmediate(() => autoUpdater.quitAndInstall(true, true));
}

function getState() { return { ...state, current: app.getVersion(), page: PAGE }; }

module.exports = { init, check, install, setAuto, download, getState };
