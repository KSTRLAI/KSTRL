// Source control for the open project, through the git command line.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const ws = require('./workspace.cjs');

function git(args, { input, timeout = 60000, allowFail = false } = {}) {
  const cwd = ws.getRoot();
  if (!cwd) return Promise.reject(new Error('No folder is open.'));
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    const p = spawn('git', args, { cwd, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } });
    const t = setTimeout(() => { p.kill(); reject(new Error(`git ${args[0]} timed out`)); }, timeout);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { clearTimeout(t); reject(new Error(e.code === 'ENOENT' ? 'Git is not installed. Install it from git-scm.com.' : e.message)); });
    p.on('close', (code) => {
      clearTimeout(t);
      if (code === 0 || allowFail) resolve({ code, out, err });
      else reject(new Error((err.trim() || out.trim() || `git ${args[0]} failed`).split('\n').filter(Boolean).slice(-3).join('\n').replace(/^(fatal|error): /gm, '')));
    });
    if (input) p.stdin.end(input);
  });
}

const paths = (list) => (Array.isArray(list) ? list : [list]).filter((x) => typeof x === 'string' && x && !x.startsWith('-'));

async function status() {
  if (!ws.getRoot()) return { repo: false };
  const inside = await git(['rev-parse', '--is-inside-work-tree'], { allowFail: true }).catch((e) => ({ code: 1, err: e.message }));
  if (inside.code !== 0) return { repo: false, error: /not installed/.test(inside.err || '') ? inside.err : null };
  const { out } = await git(['status', '--porcelain=v1', '-b', '-z', '--untracked-files=all']);
  const parts = out.split('\0');
  let branch = '';
  let ahead = 0;
  let behind = 0;
  let upstream = false;
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (!e) continue;
    if (e.startsWith('## ')) {
      const m = e.slice(3);
      branch = m.replace(/^No commits yet on /, '').split('...')[0].trim();
      upstream = m.includes('...');
      ahead = +(m.match(/ahead (\d+)/)?.[1] || 0);
      behind = +(m.match(/behind (\d+)/)?.[1] || 0);
      continue;
    }
    const x = e[0];
    const y = e[1];
    const path = e.slice(3);
    if (x === 'R' || x === 'C') i++; // the original path follows a rename
    files.push({ path, index: x, work: y });
  }
  return { repo: true, branch, ahead, behind, upstream, files };
}

async function show(spec) {
  const r = await git(['show', spec], { allowFail: true });
  return r.code === 0 ? r.out : '';
}

// Before/after text for the diff viewer: staged = HEAD → index, unstaged = index → working file.
async function diff(path, staged) {
  const [p] = paths(path);
  if (!p) throw new Error('Bad path');
  if (staged) return { path: p, before: await show(`HEAD:${p}`), after: await show(`:${p}`) };
  let after = '';
  try { after = fs.readFileSync(ws.resolveInside(p), 'utf8'); } catch { after = ''; }
  return { path: p, before: await show(`:${p}`), after };
}

const stage = (list) => git(['add', '--', ...paths(list)]);
async function unstage(list) {
  const hasHead = (await git(['rev-parse', '--verify', 'HEAD'], { allowFail: true })).code === 0;
  return hasHead ? git(['restore', '--staged', '--', ...paths(list)]) : git(['rm', '--cached', '-q', '--', ...paths(list)]);
}
const discard = (list) => git(['restore', '--worktree', '--', ...paths(list)]);

async function commit(message) {
  const msg = String(message || '').trim();
  if (!msg) throw new Error('Write a commit message first.');
  const st = await status();
  if (!st.files.some((f) => f.index !== ' ' && f.index !== '?')) await git(['add', '-A']); // nothing staged: commit everything
  await git(['commit', '-F', '-'], { input: msg });
  return status();
}

async function push() {
  const st = await status();
  await git(st.upstream ? ['push'] : ['push', '-u', 'origin', 'HEAD'], { timeout: 180000 });
  return status();
}
async function pull() { await git(['pull', '--ff-only'], { timeout: 180000 }); return status(); }
async function init() { await git(['init']); return status(); }

// Diff text for writing a commit message (staged changes, or everything if nothing is staged).
async function diffForMessage() {
  let { out } = await git(['diff', '--cached', '--stat', '-p', '--no-color'], { allowFail: true });
  if (!out.trim()) ({ out } = await git(['diff', 'HEAD', '--stat', '-p', '--no-color'], { allowFail: true }));
  const st = await status();
  const untracked = st.files.filter((f) => f.index === '?').map((f) => f.path);
  if (untracked.length) out += `\nNew files:\n${untracked.slice(0, 50).join('\n')}`;
  return out.slice(0, 14000);
}

module.exports = { status, diff, stage, unstage, discard, commit, push, pull, init, diffForMessage };
