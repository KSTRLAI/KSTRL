// Crash and error log: always written to <userData>/logs/kstrl.log; sent to the KSTRL API only if the user turns on crash reports.
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const dir = () => path.join(app.getPath('userData'), 'logs');
const file = () => path.join(dir(), 'kstrl.log');
const sent = new Map(); // message -> time (dedupe)
let lastError = null;

function write(level, source, message, stack) {
  try {
    fs.mkdirSync(dir(), { recursive: true });
    try { if (fs.statSync(file()).size > 1_000_000) fs.renameSync(file(), file() + '.old'); } catch {}
    fs.appendFileSync(file(), `[${new Date().toISOString()}] ${level} ${source}: ${message}${stack ? '\n' + stack : ''}\n`);
  } catch {}
}

// Paths in stacks can contain the user's name — strip the home folder before anything leaves the PC.
const scrub = (s) => String(s || '').split(os.homedir()).join('~').slice(0, 8000);

async function report(source, err) {
  const message = scrub(err?.message || err);
  const stack = scrub(err?.stack || '');
  write('ERROR', source, message, stack);
  lastError = { source, message, at: Date.now() };
  const settings = require('./settings.cjs');
  if (!settings.load().crashReports) return;
  const now = Date.now();
  if (now - (sent.get(message) || 0) < 3600_000 || sent.size > 50) return;
  sent.set(message, now);
  try {
    const { url, key } = settings.getUnsloth();
    if (!url) return;
    const base = require('./providers/openai-compat.cjs').normalizeBase(url);
    await fetch(`${base}/kstrl/crash`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ version: app.getVersion(), platform: process.platform, arch: process.arch, source, message, stack }),
      signal: AbortSignal.timeout(8000),
    });
  } catch {}
}

function init() {
  process.on('uncaughtException', (e) => report('main', e));
  process.on('unhandledRejection', (e) => report('main', e));
  app.on('render-process-gone', (_e, _wc, d) => report('renderer', new Error(`Window crashed (${d.reason}, exit ${d.exitCode})`)));
  app.on('child-process-gone', (_e, d) => { if (d.reason !== 'clean-exit') report('process', new Error(`${d.type} process gone (${d.reason})`)); });
  write('INFO', 'app', `KSTRL ${app.getVersion()} started on ${process.platform} ${os.release()}`);
}

module.exports = { init, report, log: (source, message) => write('info', source, message), logsDir: dir, lastError: () => lastError };
