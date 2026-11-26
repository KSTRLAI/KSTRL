const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { MODELS } = require('./models.cjs');

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
  mode: 'agent',
  autoRunCommands: false,
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
  onboarded: false,
};

let cache = null;

function load() {
  if (cache) return cache;
  try { cache = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file(), 'utf8')) }; }
  catch { cache = { ...DEFAULTS }; }
  // Colossus 2.3 was retired and 2.2 UC is now reached through the UltraCode effort.
  if (cache.model === 'colossus-2.3') cache.model = 'colossus-3';
  if (cache.model === 'colossus-2.2-uc') { cache.model = 'colossus-3'; cache.effort = 'ultracode'; }
  if (cache.lastManualModel && !['colossus-2', 'colossus-3'].includes(cache.lastManualModel)) cache.lastManualModel = 'colossus-3';
  if (Array.isArray(cache.enabledModels)) cache.enabledModels = cache.enabledModels.filter((id) => ['colossus-2', 'colossus-3'].includes(id));
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

function getUnsloth() {
  load();
  const own = !!cache.unslothURL;
  return {
    url: process.env.KSTRL_UNSLOTH_URL || cache.unslothURL || BUILTIN.unslothURL || '',
    key: process.env.KSTRL_UNSLOTH_KEY || (own ? unseal(cache.unslothKeyEnc) : null) || (own ? '' : BUILTIN.unslothKey || '') || '',
    builtin: !own && !!BUILTIN.unslothURL,
  };
}

function recordUsage(modelId, { input = 0, output = 0 } = {}) {
  load();
  const u = cache.usage[modelId] || { requests: 0, inputTokens: 0, outputTokens: 0 };
  cache.usage = { ...cache.usage, [modelId]: { requests: u.requests + 1, inputTokens: u.inputTokens + input, outputTokens: u.outputTokens + output } };
  save();
}

function backendFor(modelId) {
  load();
  const m = MODELS.find((x) => x.id === modelId) || MODELS[MODELS.length - 1];
  return { ...m, backend: cache.backendOverrides[m.id] || m.backend, serverModel: cache.unslothModels[m.id] || '' };
}

function isConfigured() {
  load();
  return cache.provider === 'anthropic' ? !!getApiKey() : !!getUnsloth().url;
}

function publicView() {
  load();
  const { apiKeyEnc, unslothKeyEnc, ...rest } = cache;
  const un = getUnsloth();
  return { ...rest, hasApiKey: !!getApiKey(), hasUnslothKey: !!unseal(cache.unslothKeyEnc), builtinServer: !!BUILTIN.unslothURL, usingBuiltinServer: un.builtin, configured: isConfigured(), userName: require('node:os').userInfo().username };
}

function addRecent(folder) {
  load();
  cache.recentFolders = [folder, ...cache.recentFolders.filter((f) => f !== folder)].slice(0, 12);
  cache.lastFolder = folder;
  save();
}

module.exports = { load, update, getApiKey, getUnsloth, backendFor, publicView, addRecent, isConfigured, recordUsage };
