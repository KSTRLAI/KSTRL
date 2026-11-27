// KSTRL account: log in through the website and get the plan and daily usage from the server.
//
// 1. Log in opens  {SITE}app-login?state=…&redirect_uri=kstrl://auth
// 2. The website (if the user is logged in there) redirects to  kstrl://auth?state=…&key=<api key>
// 3. KSTRL checks the state, stores the key (encrypted) and asks the API who this is:
//      GET {api}/v1/kstrl/account  (Authorization: Bearer <key>)
//      → { name, email, plan: 'free'|'max', usage: { used, limit, resetsAt } }
// See docs/website-login.md for the full contract.
const crypto = require('node:crypto');
const { shell } = require('electron');
const settings = require('./settings.cjs');
const oai = require('./providers/openai-compat.cjs');

const SITE = 'https://kstrlsi.base44.app/';
const LOGIN_URL = SITE + 'app-login';
const STATE_TTL = 15 * 60 * 1000;

let pending = null; // { state, at }
let lastReRegister = 0;
let notify = () => {};

function init(send) { notify = () => send('settings:changed', settings.publicView()); }

function login() {
  pending = { state: crypto.randomBytes(16).toString('hex'), at: Date.now() };
  const url = `${LOGIN_URL}?state=${pending.state}&redirect_uri=${encodeURIComponent('kstrl://auth')}&app=desktop`;
  shell.openExternal(url);
  return { url };
}

// Handles kstrl://auth?… from the browser. Returns a short status for the UI.
async function handleUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return { ok: false, error: 'Bad login link' }; }
  if (u.protocol !== 'kstrl:' || (u.hostname !== 'auth' && u.pathname.replace(/^\/+/, '') !== 'auth')) return { ok: false, error: 'Unknown link' };
  const state = u.searchParams.get('state');
  // Only accept a login the user started in this app, recently — a link from anywhere else is ignored.
  if (!pending || !state || state !== pending.state || Date.now() - pending.at > STATE_TTL) return { ok: false, error: 'This login link has expired. Click Log in again.' };
  pending = null;
  const key = (u.searchParams.get('key') || u.searchParams.get('token') || '').trim();
  if (!key) return { ok: false, error: u.searchParams.get('error') || 'The website did not send a key.' };
  const patch = { provider: 'unsloth', unslothKey: key, account: { name: u.searchParams.get('name') || '', email: u.searchParams.get('email') || '', plan: null, usage: null, source: 'link', fetchedAt: 0 } };
  // The website may tell a fresh install where the API lives — https only, and only if none is set.
  const apiUrl = u.searchParams.get('api_url');
  if (apiUrl && /^https:\/\//i.test(apiUrl) && !settings.getUnsloth().url) patch.unslothURL = apiUrl;
  settings.update(patch);
  await refresh();
  notify();
  return { ok: true };
}

// Pulls name, plan and today's usage from the server. Falls back to local tracking when the server has no account endpoint.
async function refresh() {
  const { url, key } = settings.getUnsloth();
  if (!url || !key) return null;
  let base;
  try { base = oai.normalizeBase(url); } catch { return null; }
  try {
    const res = await fetch(`${base}/kstrl/account`, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
    if (res.status === 401) {
      const acct = settings.load().account || {};
      // Automatic key revoked: ask for a new one (at most every 10 minutes, so a ban can't cause a loop).
      if (acct.auto && Date.now() - lastReRegister > 600_000) { lastReRegister = Date.now(); settings.update({ unslothKey: '', account: null }); return ensureKey(); }
      settings.update({ account: { ...acct, expired: true } }); notify(); return null;
    }
    if (!res.ok) return null; // 404 etc.: the server doesn't do accounts — keep counting locally
    const j = await res.json();
    const prev = settings.load().account || {};
    const usage = j.usage && Number.isFinite(+j.usage.used) && Number.isFinite(+j.usage.limit)
      ? { used: +j.usage.used, limit: +j.usage.limit, resetsAt: Number.isFinite(+j.usage.resetsAt) ? +j.usage.resetsAt : null }
      : null;
    settings.update({ account: { name: String(j.name || prev.name || ''), email: String(j.email || prev.email || ''), plan: j.plan === 'max' ? 'max' : 'free', usage, source: 'server', auto: !!prev.auto, fetchedAt: Date.now(), expired: false } });
    notify();
    return settings.load().account;
  } catch { return null; }
}

// Automatic key: a fresh install asks the API for its own Free key — no website visit needed.
// POST {api}/v1/kstrl/register { install_id, platform, version } → { key, plan? }
let registering = null;
async function ensureKey() {
  if (registering) return registering;
  registering = (async () => {
    const s = settings.load();
    const { url, key } = settings.getUnsloth();
    if (!url || key || s.provider === 'anthropic' || s.autoKeyDisabled) return false;
    let installId = s.installId;
    if (!installId) { installId = crypto.randomUUID(); settings.update({ installId }); }
    let base;
    try { base = oai.normalizeBase(url); } catch { return false; }
    try {
      const res = await fetch(`${base}/kstrl/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ install_id: installId, platform: process.platform, version: require('electron').app.getVersion() }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return false; // 404: the server doesn't hand out keys; 403/429: banned or rate limited
      const j = await res.json();
      if (!j || typeof j.key !== 'string' || !j.key.trim()) return false;
      settings.update({ unslothKey: j.key.trim(), account: { name: '', email: '', plan: j.plan === 'max' ? 'max' : 'free', usage: null, source: 'auto', auto: true, fetchedAt: 0 } });
      await refresh();
      notify();
      return true;
    } catch (e) { if (process.env.KSTRL_DEBUG) console.error('register failed', e); return false; }
  })().finally(() => { registering = null; });
  return registering;
}

// ---- KSTRL's own sign-up / log-in screen ----
//   POST {api}/v1/kstrl/auth/signup  { name, email, password, install_id } → { key, name, email, plan }
//   POST {api}/v1/kstrl/auth/login   { email, password, install_id }       → { key, name, email, plan }
// The password goes straight to the API over the network and is never stored by KSTRL; only the returned key is (encrypted).
async function account(kind, { name = '', email = '', password = '', url = '' } = {}) {
  const s = settings.load();
  email = String(email).trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: 'Enter a valid email address.' };
  if (!password) return { ok: false, error: 'Enter your password.' };
  if (kind === 'signup' && String(password).length < 8) return { ok: false, error: 'Use a password with at least 8 characters.' };
  const apiUrl = settings.getUnsloth().url || String(url || '').trim();
  if (!apiUrl) return { ok: false, error: 'Enter the KSTRL server address.', needsUrl: true };
  let base;
  try { base = oai.normalizeBase(apiUrl); } catch { return { ok: false, error: 'That server address isn\'t valid.', needsUrl: true }; }
  let installId = s.installId;
  if (!installId) { installId = crypto.randomUUID(); settings.update({ installId }); }
  let res;
  try {
    res = await fetch(`${base}/kstrl/auth/${kind === 'signup' ? 'signup' : 'login'}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ name: String(name).trim().slice(0, 80), email, password: String(password), install_id: installId }),
      signal: AbortSignal.timeout(20000),
    });
  } catch { return { ok: false, error: 'Couldn\'t reach the KSTRL server. Check your connection and try again.', needsUrl: !settings.getUnsloth().url }; }
  let j = null;
  try { j = await res.json(); } catch {}
  if (!res.ok) {
    if (res.status === 404 || res.status === 405) return { ok: false, error: 'This server doesn\'t support KSTRL accounts yet.' };
    return { ok: false, error: (j && j.error && (j.error.message || j.error)) || `Server error (${res.status})`, code: j && j.error && j.error.code };
  }
  if (!j || typeof j.key !== 'string' || !j.key.trim()) return { ok: false, error: 'The server didn\'t send a key.' };
  settings.update({
    provider: 'unsloth',
    unslothKey: j.key.trim(),
    ...(settings.getUnsloth().url ? {} : { unslothURL: apiUrl }),
    account: { name: String(j.name || name || ''), email: String(j.email || email), plan: j.plan === 'max' ? 'max' : 'free', usage: null, source: 'login', auto: false, fetchedAt: 0 },
  });
  await refresh();
  notify();
  return { ok: true, account: settings.load().account };
}

function logout() {
  pending = null;
  const { url, key } = settings.getUnsloth();
  const acct = settings.load().account;
  if (url && key && acct && !acct.auto) { // end the session on the server too (best effort)
    try { fetch(`${oai.normalizeBase(url)}/kstrl/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(5000) }).catch(() => {}); } catch {}
  }
  settings.update({ unslothKey: '', account: null });
  notify();
  setTimeout(() => ensureKey().catch(() => {}), 500); // fall back to this install's automatic Free key
  return true;
}

module.exports = { init, login, handleUrl, refresh, logout, ensureKey, signup: (a) => account('signup', a), signin: (a) => account('login', a), SITE };
