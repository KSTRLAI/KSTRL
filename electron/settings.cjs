const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { MODELS, MODES, PLANS, EXTRA_WEIGHTS } = require('./models.cjs');

const file = () => path.join(app.getPath('userData'), 'kstrl-settings.json');

// Built-in server connection, written at build time from GitHub Actions secrets
// (KSTRL_UNSLOTH_URL / KSTRL_UNSLOTH_KEY). Every installed copy connects with it
// automatically unless the user enters their own server in Settings.
let BUILTIN = {};
try { BUILTIN = JSON.parse(fs.readFileSync(path.join(__dirname, 'build-config.json'), 'utf8')) || {}; } catch {}

const DEFAULTS = {
  provider: 'unsloth', // 'unsloth' (OpenAI-compatible server) | 'anthropic'
  // Unsloth server
  unslothURL: '',
  unslothKeyEnc: null,
  unslothModels: {}, // { [colossusId]: serverModelId }
  // Anthropic API (optional alternative)
  apiKeyEnc: null,
  baseURL: '',
  backendOverrides: {},
  // Kestrel
  model: 'colossus-3',
  effort: 'normal',
  mode: 'build', // build | plan | ask
  autoRunCommands: false,
  webAccess: 'ask', // ask | allow | off
  customInstructions: '',
  // Workspace / UI
  maxSteps: 60,
  // Models
  enabledModels: null, // null = all
  // Workspace / UI
  recentFolders: [],
  lastFolder: null,
  reopenLastProject: true,
  fontSize: 14,
  uiScale: 100,
  minimap: true,
  tabAutocomplete: true,
  wordWrap: false,
  reduceTransparency: false,
  showTips: true,
  // Notifications
  systemNotifications: true,
  completionSound: false,
  trayIcon: false,
  autoUpdate: true,
  // Stats
  usage: {}, // { [colossusId]: { requests, inputTokens, outputTokens } }
  plan: 'free', // free | max (local fallback; a logged-in account's plan comes from the server)
  account: null, // { name, email, plan, usage: { used, limit, resetsAt }, source: 'server'|'link', fetchedAt, expired }
  daily: null, // { date: 'YYYY-MM-DD', used, byModel: {}, byMode: {} }
  onboarded: false,
};

let cache = null;
const PICKABLE = MODELS.filter((m) => !m.hidden).map((m) => m.id);

function load() {
  if (cache) return cache;
  try { cache = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file(), 'utf8')) }; }
  catch { cache = { ...DEFAULTS }; }
  // Colossus 2.3 was retired and 2.2 UC is now reached through the UltraCode effort.
  if (cache.model === 'colossus-2.3') cache.model = 'colossus-3';
  if (cache.model === 'colossus-2.2-uc') { cache.model = 'colossus-3'; cache.effort = 'ultracode'; }
  if (cache.lastManualModel && !PICKABLE.includes(cache.lastManualModel)) cache.lastManualModel = 'colossus-3';
  if (Array.isArray(cache.enabledModels)) cache.enabledModels = cache.enabledModels.filter((id) => PICKABLE.includes(id));
  // Colossus 2.2 arrived in 1.4.0: show it to people who customised their picker before then.
  if (!cache.has22) { if (Array.isArray(cache.enabledModels) && !cache.enabledModels.includes('colossus-2.2')) cache.enabledModels.push('colossus-2.2'); cache.has22 = true; }
  // Agent mode became Build (and Plan) in 1.4.0.
  if (!MODES.some((m) => m.id === cache.mode)) cache.mode = 'build';
  for (const a of cache.automations || []) if (!MODES.some((m) => m.id === a.mode)) a.mode = 'build';
  if (Array.isArray(cache.enabledModels) && !cache.enabledModels.length) cache.enabledModels = null;
  for (const a of cache.automations || []) if (a.model === 'colossus-2.3' || a.model === 'colossus-2.2-uc') a.model = 'colossus-3';
  return cache;
}

function save() {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(cache, null, 2));
}

function seal(value) {
  const v = (value || '').trim();
  if (!v) return null;
  if (safeStorage.isEncryptionAvailable()) return 'enc:' + safeStorage.encryptString(v).toString('base64');
  return 'raw:' + Buffer.from(v).toString('base64');
}

function unseal(v) {
  if (!v) return null;
  try {
    if (v.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(v.slice(4), 'base64'));
    if (v.startsWith('raw:')) return Buffer.from(v.slice(4), 'base64').toString('utf8');
  } catch {}
  return null;
}

function update(patch) {
  load();
  const next = { ...patch };
  if ('apiKey' in next) { cache.apiKeyEnc = seal(next.apiKey); delete next.apiKey; }
  if ('unslothKey' in next) { cache.unslothKeyEnc = seal(next.unslothKey); delete next.unslothKey; }
  Object.assign(cache, next);
  save();
  return publicView();
}

function getApiKey() {
  load();
  return process.env.KSTRL_API_KEY || unseal(cache.apiKeyEnc) || process.env.ANTHROPIC_API_KEY || null;
}

// The KSTRL API (an OpenAI-compatible Unsloth server). The URL can ship with the app (build-config.json);
// the API key is always the user's own, pasted in via Connect API — keys are never built in.
function getUnsloth() {
  load();
  const own = !!cache.unslothURL;
  return {
    url: process.env.KSTRL_UNSLOTH_URL || cache.unslothURL || BUILTIN.unslothURL || '',
    key: process.env.KSTRL_UNSLOTH_KEY || unseal(cache.unslothKeyEnc) || '',
    builtin: !own && !!BUILTIN.unslothURL,
  };
}

const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

function daily() {
  load();
  if (!cache.daily || cache.daily.date !== today()) cache.daily = { date: today(), used: 0, byModel: {}, byMode: {} };
  return cache.daily;
}

function usageView() {
  const d = daily();
  const acct = cache.account;
  // Logged in to a server that reports usage: its numbers are the truth.
  if (acct && acct.source === 'server' && acct.usage) {
    const plan = PLANS[acct.plan] || PLANS.free;
    const limit = acct.usage.limit || plan.daily;
    const used = Math.round(acct.usage.used * 10) / 10;
    const midnight = new Date(); midnight.setHours(24, 0, 0, 0);
    return { plan: plan.id, planName: plan.name, limit, used, left: Math.max(0, limit - used), percent: Math.min(100, (used / limit) * 100), resetsAt: acct.usage.resetsAt || midnight.getTime(), byModel: d.byModel, byMode: d.byMode, server: true };
  }
  const plan = PLANS[(acct && acct.plan) || cache.plan] || PLANS.free;
  const midnight = new Date(); midnight.setHours(24, 0, 0, 0);
  const used = Math.round(d.used * 10) / 10;
  return { plan: plan.id, planName: plan.name, limit: plan.daily, used, left: Math.max(0, plan.daily - used), percent: Math.min(100, (used / plan.daily) * 100), resetsAt: midnight.getTime(), byModel: d.byModel, byMode: d.byMode };
}

const hasUsageLeft = () => usageView().left > 0;

// Credits for one model call (see models.cjs for the formula).
function creditsFor(modelId, mode, { input = 0, output = 0 }) {
  const m = MODELS.find((x) => x.id === modelId);
  const w = MODES.find((x) => x.id === mode)?.weight ?? EXTRA_WEIGHTS[mode] ?? 1;
  return ((input + 3 * output) / 1000) * (m?.weight ?? 1) * w;
}

function recordUsage(modelId, { input = 0, output = 0 } = {}, mode = 'build') {
  load();
  const u = cache.usage[modelId] || { requests: 0, inputTokens: 0, outputTokens: 0 };
  cache.usage = { ...cache.usage, [modelId]: { requests: u.requests + 1, inputTokens: u.inputTokens + input, outputTokens: u.outputTokens + output } };
  const d = daily();
  const c = creditsFor(modelId, mode, { input, output });
  d.used += c;
  d.byModel[modelId] = (d.byModel[modelId] || 0) + c;
  d.byMode[mode] = (d.byMode[mode] || 0) + c;
  save();
}

function backendFor(modelId) {
  load();
  const m = MODELS.find((x) => x.id === modelId) || MODELS[MODELS.length - 1];
  return { ...m, backend: cache.backendOverrides[m.id] || m.backend, serverModel: cache.unslothModels[m.id] || '' };
}

function isConfigured() {
  load();
  if (cache.provider === 'anthropic') return !!getApiKey();
  const u = getUnsloth();
  return !!u.url && !!u.key; // logged in (or a pasted API key)
}

function publicView() {
  load();
  const { apiKeyEnc, unslothKeyEnc, daily: _d, ...rest } = cache;
  const un = getUnsloth();
  return { ...rest, hasApiKey: !!getApiKey(), hasUnslothKey: !!unseal(cache.unslothKeyEnc), builtinServer: !!BUILTIN.unslothURL, usingBuiltinServer: un.builtin, configured: isConfigured(), usageToday: usageView(), loggedIn: !!(unseal(cache.unslothKeyEnc) && cache.account && !cache.account.expired), userName: require('node:os').userInfo().username };
}

function addRecent(folder) {
  load();
  cache.recentFolders = [folder, ...cache.recentFolders.filter((f) => f !== folder)].slice(0, 12);
  cache.lastFolder = folder;
  save();
}

module.exports = { load, update, getApiKey, getUnsloth, backendFor, publicView, addRecent, isConfigured, recordUsage, hasUsageLeft, usageView };
