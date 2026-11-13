// Models other than Claude that a session can run on: Grok, Gemini, or anything
// with an API. Claude Code still does the work (terminal, tools, memory, teams);
// only the model behind it changes. See llm-bridge.js for how.
//
// API keys are kept in their own file, encrypted with the Windows login, and
// never in config.json, which goes to the window and to the phone.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bridge = require('./llm-bridge');

// Where to get a key is shown beside the field. `model` is left for the person
// to pick from the provider's own list, because model names change every month.
const PRESETS = [
  { id: 'grok', name: 'Grok (xAI)', protocol: 'openai', baseUrl: 'https://api.x.ai/v1', keys: 'console.x.ai' },
  { id: 'gemini', name: 'Gemini (Google)', protocol: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', keys: 'aistudio.google.com/apikey' },
  { id: 'openai', name: 'OpenAI', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', keys: 'platform.openai.com/api-keys' },
  { id: 'openrouter', name: 'OpenRouter', protocol: 'openai', baseUrl: 'https://openrouter.ai/api/v1', keys: 'openrouter.ai/keys' },
  { id: 'groq', name: 'Groq', protocol: 'openai', baseUrl: 'https://api.groq.com/openai/v1', keys: 'console.groq.com/keys' },
  { id: 'mistral', name: 'Mistral', protocol: 'openai', baseUrl: 'https://api.mistral.ai/v1', keys: 'console.mistral.ai/api-keys' },
  { id: 'deepseek', name: 'DeepSeek', protocol: 'anthropic', baseUrl: 'https://api.deepseek.com/anthropic', keys: 'platform.deepseek.com/api_keys' },
  { id: 'kimi', name: 'Kimi (Moonshot)', protocol: 'anthropic', baseUrl: 'https://api.moonshot.ai/anthropic', keys: 'platform.moonshot.ai' },
  { id: 'glm', name: 'GLM (Z.ai)', protocol: 'anthropic', baseUrl: 'https://api.z.ai/api/anthropic', keys: 'z.ai/manage-apikey' },
  { id: 'ollama', name: 'Ollama (on this PC)', protocol: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', keys: '', noKey: true },
  { id: 'custom', name: 'Custom', protocol: 'openai', baseUrl: '', keys: '' },
];

const ID_RE = /^[a-z0-9]{1,24}$/;
// A key may only travel unencrypted inside this PC or a private network.
const PRIVATE_HOST = /^(localhost|127\.|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;

let file = null;
let crypt = null; // { encrypt(text) -> base64, decrypt(base64) -> text }
let list = [];
let server = null;

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    list = Array.isArray(data.list) ? data.list : [];
  } catch {
    list = [];
  }
}

function write() {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ list }, null, 2));
  fs.renameSync(tmp, file);
}

function init(userData, encryption) {
  file = path.join(userData, 'llms.json');
  crypt = encryption;
  load();
}

const keyOf = (e) => (e && e.key ? crypt.decrypt(e.key) : '');
const plain = (e) => ({ id: e.id, name: e.name, preset: e.preset, protocol: e.protocol, baseUrl: e.baseUrl, model: e.model, hasKey: Boolean(e.key) });

// For the window: everything but the key.
const all = () => list.map(plain);
const known = (id) => list.some((e) => e.id === id);

function validate(o) {
  const name = String(o.name || '').trim();
  const model = String(o.model || '').trim();
  const baseUrl = bridge.trimUrl(String(o.baseUrl || '').trim());
  const protocol = o.protocol === 'anthropic' ? 'anthropic' : 'openai';
  if (!name) throw new Error('Give it a name.');
  if (!model) throw new Error('Choose which model to use.');
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error('The address is not a web address.');
  }
  if (!/^https?:$/.test(url.protocol)) throw new Error('The address has to start with http or https.');
  return { name, model, baseUrl, protocol, url };
}

function guardKey(url, key) {
  if (key && url.protocol === 'http:' && !PRIVATE_HOST.test(url.hostname)) throw new Error('An API key cannot be sent over plain http to the internet. Use an https address.');
}

// A blank key on an existing entry means "keep the one saved".
function save(o) {
  const v = validate(o);
  const key = String(o.key || '').trim();
  const old = list.find((e) => e.id === o.id);
  guardKey(v.url, key || (old && old.key ? 'kept' : ''));
  const entry = {
    id: old ? old.id : crypto.randomBytes(6).toString('hex'),
    name: v.name,
    preset: String(o.preset || 'custom'),
    protocol: v.protocol,
    baseUrl: v.baseUrl,
    model: v.model,
    key: key ? crypt.encrypt(key) : old ? old.key : '',
  };
  if (old) list[list.indexOf(old)] = entry;
  else list.push(entry);
  write();
  return plain(entry);
}

function remove(id) {
  list = list.filter((e) => e.id !== id);
  write();
}

// Most specific choice wins: the session, then its project. Empty means Claude.
function pick(config, dir, sessionId) {
  const id = (sessionId && (config.sessionLlm || {})[sessionId]) || (dir && (config.projectLlm || {})[dir]) || '';
  return id !== 'claude' && ID_RE.test(id) ? id : '';
}

// What a session on this model is started with. The token is Loop's own, good
// only for the bridge on this PC, so the session never holds the real key.
function envFor(id) {
  if (!id) return {};
  const e = list.find((x) => x.id === id);
  if (!e) throw new Error('The model chosen for this session was removed. Choose another one.');
  if (!server || !server.port()) throw new Error('Loop could not start its connection to other models. Restart Loop and try again.');
  return {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port()}/${e.id}`,
    ANTHROPIC_AUTH_TOKEN: server.token,
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_MODEL: e.model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: e.model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: e.model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: e.model,
    ANTHROPIC_SMALL_FAST_MODEL: e.model,
    CLAUDE_CODE_SUBAGENT_MODEL: e.model,
    // Nothing that only Anthropic's own service understands.
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_PROMPT_CACHING: '1',
  };
}

async function start() {
  server = bridge.create((id) => {
    const e = list.find((x) => x.id === id);
    return e ? { ...e, key: keyOf(e) } : null;
  });
  await server.start();
}

const stop = () => server && server.stop();

const timeout = (ms) => AbortSignal.timeout(ms);

// In words someone can act on. A model on this PC can take minutes to load the
// first time, so running out of time does not mean the details are wrong.
function failure(e) {
  if (e.name === 'TimeoutError') return 'No answer in time. The address may be wrong, or the model may still be loading: try again in a minute.';
  return (e.cause && e.cause.message) || e.message;
}

async function modelsOf(c) {
  const url = `${bridge.trimUrl(c.baseUrl)}${c.protocol === 'anthropic' ? '/v1/models' : '/models'}`;
  const headers = { ...bridge.bearer(c.key), ...(c.protocol === 'anthropic' && c.key ? { 'x-api-key': c.key, 'anthropic-version': '2023-06-01' } : {}) };
  const r = await fetch(url, { headers, signal: timeout(15000) });
  if (!r.ok) throw new Error(await bridge.upstreamError(r, c.name || 'The provider'));
  const data = await r.json();
  return (data.data || data.models || []).map((m) => String(m.id || m.name || '').replace(/^models\//, '')).filter(Boolean).sort();
}

// The details being edited, with the saved key if none was typed.
function candidate(o) {
  const old = list.find((e) => e.id === o.id);
  const baseUrl = bridge.trimUrl(String(o.baseUrl || '').trim());
  const key = String(o.key || '').trim() || keyOf(old);
  try {
    guardKey(new URL(baseUrl), key);
  } catch (e) {
    if (e.code === 'ERR_INVALID_URL') throw new Error('The address is not a web address.');
    throw e;
  }
  return { name: String(o.name || '').trim(), protocol: o.protocol === 'anthropic' ? 'anthropic' : 'openai', baseUrl, model: String(o.model || '').trim(), key };
}

async function models(o) {
  try {
    return { ok: true, models: await modelsOf(candidate(o)) };
  } catch (e) {
    return { ok: false, error: failure(e) };
  }
}

// One tiny message, to prove the address, key and model work before relying on them.
async function check(o) {
  try {
    const c = candidate(o);
    if (!c.model) return { ok: false, error: 'Choose which model to use.' };
    const anthropic = c.protocol === 'anthropic';
    const r = await fetch(`${bridge.trimUrl(c.baseUrl)}${anthropic ? '/v1/messages' : '/chat/completions'}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...bridge.bearer(c.key), ...(anthropic ? { 'anthropic-version': '2023-06-01', ...(c.key ? { 'x-api-key': c.key } : {}) } : {}) },
      body: JSON.stringify({ model: c.model, messages: [{ role: 'user', content: 'Reply with the single word OK.' }], ...(anthropic ? { max_tokens: 16 } : {}) }),
      signal: timeout(180000),
    });
    if (!r.ok) return { ok: false, error: await bridge.upstreamError(r, c.name || 'The provider') };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: failure(e) };
  }
}

module.exports = { PRESETS, init, all, known, save, remove, pick, envFor, start, stop, models, check };
