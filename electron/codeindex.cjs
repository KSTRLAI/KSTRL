// Codebase search: a ranked (BM25) index over ~40-line chunks of every text file in the project.
// Identifiers are split (camelCase, snake_case) so "user login" finds handleUserLogin().
// Files are re-read only when their modification time changes.
const fsp = require('node:fs/promises');
const ws = require('./workspace.cjs');

const CHUNK = 40;
const STEP = 30;
const MAX_FILE = 400 * 1024;
const TEXT_EXT = /\.(js|jsx|mjs|cjs|ts|tsx|py|rb|go|rs|java|kt|kts|swift|c|cc|cpp|h|hpp|cs|php|lua|dart|scala|sql|sh|ps1|bat|html|htm|css|scss|less|vue|svelte|astro|json|yml|yaml|toml|ini|md|mdx|txt|xml|gradle|cmake|r|ex|exs|erl|hs|clj|zig|nim|sol|prisma|graphql|gql|proto|env\.example)$/i;
const SPECIAL = /(^|\/)(Dockerfile|Makefile|README|LICENSE|\.gitignore)$/;

let state = { root: null, files: new Map(), df: new Map(), chunks: 0, built: 0 }; // files: path -> { mtime, chunks: [{ start, end, tf: Map, len, text }] }

function tokens(text) {
  const out = [];
  const words = text.match(/[A-Za-z_][A-Za-z0-9_]*|\d+/g) || [];
  for (const w of words) {
    const parts = w.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').split(/[\s_]+/);
    for (const p of parts) { const t = p.toLowerCase(); if (t.length >= 2 && t.length <= 40) out.push(t); }
    if (parts.length > 1 && w.length <= 40) out.push(w.toLowerCase());
  }
  return out;
}

function chunkFile(path, text) {
  const lines = text.split('\n');
  const chunks = [];
  const pathTokens = tokens(path);
  for (let i = 0; i < lines.length; i += STEP) {
    const start = i;
    const end = Math.min(lines.length, i + CHUNK);
    const body = lines.slice(start, end).join('\n');
    const tf = new Map();
    for (const t of [...tokens(body), ...pathTokens, ...pathTokens]) tf.set(t, (tf.get(t) || 0) + 1);
    let len = 0;
    for (const v of tf.values()) len += v;
    chunks.push({ start: start + 1, end, tf, len, text: body });
    if (end >= lines.length) break;
  }
  return chunks;
}

async function refresh() {
  const root = ws.getRoot();
  if (!root) throw new Error('No folder is open.');
  if (state.root !== root) state = { root, files: new Map(), df: new Map(), chunks: 0, built: 0 };
  const paths = (await ws.walk('.', 20000)).filter((p) => TEXT_EXT.test(p) || SPECIAL.test(p));
  const seen = new Set(paths);
  let changed = false;
  for (const p of [...state.files.keys()]) if (!seen.has(p)) { state.files.delete(p); changed = true; }
  for (const p of paths) {
    let st;
    try { st = await fsp.stat(ws.resolveInside(p)); } catch { continue; }
    if (st.size > MAX_FILE) continue;
    const prev = state.files.get(p);
    if (prev && prev.mtime === st.mtimeMs) continue;
    let text;
    try { text = await fsp.readFile(ws.resolveInside(p), 'utf8'); } catch { continue; }
    if (text.includes('\u0000')) continue;
    state.files.set(p, { mtime: st.mtimeMs, chunks: chunkFile(p, text) });
    changed = true;
  }
  if (changed || !state.built) {
    const df = new Map();
    let n = 0;
    for (const f of state.files.values()) for (const c of f.chunks) { n++; for (const t of c.tf.keys()) df.set(t, (df.get(t) || 0) + 1); }
    state.df = df;
    state.chunks = n;
    state.built = Date.now();
  }
}

async function search(query, limit = 8) {
  await refresh();
  const q = [...new Set(tokens(query))];
  if (!q.length) return [];
  const N = Math.max(1, state.chunks);
  let total = 0;
  for (const f of state.files.values()) for (const c of f.chunks) total += c.len;
  const avg = total / N || 1;
  const k1 = 1.2;
  const b = 0.75;
  const scored = [];
  for (const [path, f] of state.files) {
    for (const c of f.chunks) {
      let s = 0;
      let hits = 0;
      for (const t of q) {
        const tf = c.tf.get(t);
        if (!tf) continue;
        hits++;
        const idf = Math.log(1 + (N - (state.df.get(t) || 0) + 0.5) / ((state.df.get(t) || 0) + 0.5));
        s += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * c.len) / avg)));
      }
      if (hits) scored.push({ path, start: c.start, end: c.end, score: s * (0.6 + (0.4 * hits) / q.length), text: c.text });
    }
  }
  scored.sort((a, b2) => b2.score - a.score);
  // One chunk per file region: skip overlapping neighbours of a better hit.
  const out = [];
  for (const r of scored) {
    if (out.some((o) => o.path === r.path && r.start <= o.end && r.end >= o.start)) continue;
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

module.exports = { search, tokens };
