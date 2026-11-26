// Workspace sandbox: every path the UI or the agent touches is resolved inside the open folder.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const IGNORE = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.venv', 'venv', '__pycache__', 'target', '.idea', '.vs', 'release', 'coverage']);

let root = null;
let realRoot = null;

function setRoot(dir) {
  root = dir ? path.resolve(dir) : null;
  realRoot = root ? fs.realpathSync(root) : null;
}
const getRoot = () => root;

// Resolve a (possibly relative) path and refuse anything that escapes the workspace.
function resolveInside(p) {
  if (!root) throw new Error('No folder is open. Open a folder first.');
  const target = path.resolve(root, p || '.');
  const rel = path.relative(root, target);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error(`Path escapes the workspace: ${p}`);
  // Canonicalize the nearest existing ancestor to defeat symlinks pointing outside.
  let probe = target;
  while (!fs.existsSync(probe) && probe !== root) probe = path.dirname(probe);
  const real = fs.realpathSync(probe);
  const rrel = path.relative(realRoot, real);
  if (rrel === '..' || rrel.startsWith('..' + path.sep) || path.isAbsolute(rrel)) throw new Error(`Path escapes the workspace via a link: ${p}`);
  return target;
}

const toRel = (abs) => path.relative(root, abs).split(path.sep).join('/') || '.';

async function readDir(dir) {
  const abs = resolveInside(dir);
  const entries = await fsp.readdir(abs, { withFileTypes: true });
  return entries
    .filter((e) => !(e.isDirectory() && e.name === '.git'))
    .map((e) => ({ name: e.name, path: toRel(path.join(abs, e.name)), dir: e.isDirectory(), ignored: IGNORE.has(e.name) }))
    .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
}

async function walk(dir = '.', limit = 4000) {
  const out = [];
  async function go(abs) {
    if (out.length >= limit) return;
    let entries;
    try { entries = await fsp.readdir(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= limit) return;
      if (IGNORE.has(e.name)) continue;
      const full = path.join(abs, e.name);
      if (e.isDirectory()) await go(full);
      else out.push(toRel(full));
    }
  }
  await go(resolveInside(dir));
  return out;
}

async function readFile(p) {
  const abs = resolveInside(p);
  const stat = await fsp.stat(abs);
  if (stat.size > 5 * 1024 * 1024) throw new Error(`File too large to open (${(stat.size / 1048576).toFixed(1)} MB)`);
  const buf = await fsp.readFile(abs);
  if (buf.subarray(0, 8000).includes(0)) throw new Error('Binary file');
  return buf.toString('utf8');
}

async function fileExists(p) {
  try { await fsp.access(resolveInside(p)); return true; } catch { return false; }
}

async function writeFile(p, contents) {
  const abs = resolveInside(p);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, contents, 'utf8');
}

async function createPath(p, isDir) {
  const abs = resolveInside(p);
  if (fs.existsSync(abs)) throw new Error('Already exists');
  if (isDir) await fsp.mkdir(abs, { recursive: true });
  else { await fsp.mkdir(path.dirname(abs), { recursive: true }); await fsp.writeFile(abs, ''); }
}

async function deletePath(p) {
  const abs = resolveInside(p);
  if (abs === root) throw new Error('Refusing to delete the workspace root');
  await fsp.rm(abs, { recursive: true, force: true });
}

async function renamePath(from, to) {
  await fsp.rename(resolveInside(from), resolveInside(to));
}

async function search(query, { regex = false, caseSensitive = false, glob = '' } = {}, max = 300) {
  if (!query) return [];
  let re;
  try {
    re = new RegExp(regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? '' : 'i');
  } catch (e) { throw new Error('Invalid regex: ' + e.message); }
  const globRe = glob ? new RegExp('^' + glob.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i') : null;
  const files = await walk('.', 8000);
  const results = [];
  for (const f of files) {
    if (results.length >= max) break;
    if (globRe && !globRe.test(path.posix.basename(f)) && !globRe.test(f)) continue;
    let text;
    try {
      const abs = resolveInside(f);
      if ((await fsp.stat(abs)).size > 1024 * 1024) continue;
      const buf = await fsp.readFile(abs);
      if (buf.subarray(0, 4000).includes(0)) continue;
      text = buf.toString('utf8');
    } catch { continue; }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length && results.length < max; i++) {
      if (re.test(lines[i])) results.push({ path: f, line: i + 1, text: lines[i].slice(0, 300) });
    }
  }
  return results;
}

// Run a shell command in the workspace and collect its output (used by the agent).
function runCommand(command, { timeoutMs = 120000, onData } = {}) {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const child = isWin
      ? spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], { cwd: root, windowsHide: true })
      : spawn(process.env.SHELL || 'bash', ['-lc', command], { cwd: root });
    let out = '';
    const push = (d) => {
      const s = d.toString();
      out += s;
      if (out.length > 200000) out = out.slice(-200000);
      onData && onData(s);
    };
    child.stdout.on('data', push);
    child.stderr.on('data', push);
    const timer = setTimeout(() => { push(`\n[KSTRL] Command timed out after ${timeoutMs / 1000}s and was stopped.\n`); child.kill(); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, output: out + String(e) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, output: out }); });
  });
}

module.exports = { setRoot, getRoot, resolveInside, readDir, walk, readFile, writeFile, fileExists, createPath, deletePath, renamePath, search, runCommand, IGNORE };
