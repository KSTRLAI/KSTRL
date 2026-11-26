const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { MODELS } = require('./models.cjs');

const file = () => path.join(app.getPath('userData'), 'kstrl-settings.json');

const DEFAULTS = {
  apiKeyEnc: null, // safeStorage-encrypted API key (base64)
  baseURL: '', // optional custom Anthropic-compatible endpoint
  model: 'colossus-3',
  effort: 'normal',
  mode: 'agent',
  autoRunCommands: false,
  backendOverrides: {}, // { [kstrlModelId]: backendModelId }
  recentFolders: [],
  lastFolder: null,
  fontSize: 14,
  customInstructions: '',
};

let cache = null;

function load() {
  if (cache) return cache;
  try {
    cache = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file(), 'utf8')) };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

function save() {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(cache, null, 2));
}

function update(patch) {
  load();
  const next = { ...patch };
  if ('apiKey' in next) {
    const key = (next.apiKey || '').trim();
    delete next.apiKey;
    if (!key) cache.apiKeyEnc = null;
    else if (safeStorage.isEncryptionAvailable()) cache.apiKeyEnc = 'enc:' + safeStorage.encryptString(key).toString('base64');
    else cache.apiKeyEnc = 'raw:' + Buffer.from(key).toString('base64');
  }
  Object.assign(cache, next);
  save();
  return publicView();
}

function getApiKey() {
  load();
  if (process.env.KSTRL_API_KEY) return process.env.KSTRL_API_KEY;
  const v = cache.apiKeyEnc;
  if (!v) return process.env.ANTHROPIC_API_KEY || null;
  try {
    if (v.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(v.slice(4), 'base64'));
    if (v.startsWith('raw:')) return Buffer.from(v.slice(4), 'base64').toString('utf8');
  } catch {}
  return null;
}

function backendFor(modelId) {
  load();
  const m = MODELS.find((x) => x.id === modelId) || MODELS[MODELS.length - 1];
  return { ...m, backend: cache.backendOverrides[m.id] || m.backend };
}

function publicView() {
  load();
  const { apiKeyEnc, ...rest } = cache;
  return { ...rest, hasApiKey: !!getApiKey() };
}

function addRecent(folder) {
  load();
  cache.recentFolders = [folder, ...cache.recentFolders.filter((f) => f !== folder)].slice(0, 8);
  cache.lastFolder = folder;
  save();
}

module.exports = { load, update, getApiKey, backendFor, publicView, addRecent };
