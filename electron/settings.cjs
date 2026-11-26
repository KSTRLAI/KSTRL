const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { MODELS } = require('./models.cjs');

const file = () => path.join(app.getPath('userData'), 'kstrl-settings.json');

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
  recentFolders: [],
  lastFolder: null,
  fontSize: 14,
  onboarded: false,
};

let cache = null;

function load() {
  if (cache) return cache;
  try { cache = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file(), 'utf8')) }; }
  catch { cache = { ...DEFAULTS }; }
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
  return {
    url: process.env.KSTRL_UNSLOTH_URL || cache.unslothURL,
    key: process.env.KSTRL_UNSLOTH_KEY || unseal(cache.unslothKeyEnc) || '',
  };
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
  return { ...rest, hasApiKey: !!getApiKey(), hasUnslothKey: !!getUnsloth().key, configured: isConfigured(), userName: require('node:os').userInfo().username };
}

function addRecent(folder) {
  load();
  cache.recentFolders = [folder, ...cache.recentFolders.filter((f) => f !== folder)].slice(0, 12);
  cache.lastFolder = folder;
  save();
}

module.exports = { load, update, getApiKey, getUnsloth, backendFor, publicView, addRecent, isConfigured };
