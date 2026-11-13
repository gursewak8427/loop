// Coding agents other than Claude Code, each signed in with its own plan:
// ChatGPT through Codex, Grok through Grok Build, Gemini through Antigravity,
// Kimi through Kimi Code. Loop runs the provider's own program in a terminal at
// the project folder, the way it runs Claude Code, so the work is billed to that
// plan and not to an API key.
//
// Every command is built here from fixed parts. The window only names an agent
// and, to continue a conversation, an id this file has checked.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const HOME = os.homedir();

const AGENTS = {
  codex: {
    name: 'ChatGPT',
    tool: 'Codex',
    plan: 'ChatGPT Plus, Pro or Business',
    exe: 'codex',
    // Codex keeps a login wherever CODEX_HOME points, so each account is a folder.
    homeEnv: 'CODEX_HOME',
    mainHome: () => path.join(HOME, '.codex'),
    model: (m) => `-c model=${m}`,
    // Conversations, skills and the rest stay one set, shared by every account.
    shared: ['sessions', 'archived_sessions', 'skills', 'plugins', 'rules', 'memories'],
    copied: ['config.toml', 'AGENTS.md'],
    run: 'codex',
    login: 'codex login',
    resume: (id) => `codex resume ${id}`,
    last: 'codex resume --last',
    install: 'npm install -g @openai/codex',
  },
  grok: {
    name: 'Grok',
    tool: 'Grok Build',
    plan: 'SuperGrok or X Premium+',
    exe: 'grok',
    run: 'grok',
    login: 'grok login',
    resume: (id) => `grok --resume ${id}`,
    last: 'grok -c',
    install: 'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://x.ai/cli/install.ps1 | iex"',
  },
  antigravity: {
    name: 'Gemini',
    tool: 'Antigravity',
    plan: 'Google AI Pro or Ultra, or the free plan',
    exe: 'agy',
    run: 'agy',
    // It has no sign-in command of its own: the first start opens the browser.
    login: 'agy',
    resume: (id) => `agy --conversation ${id}`,
    last: 'agy -c',
    install: 'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://antigravity.google/cli/install.ps1 | iex"',
  },
  kimi: {
    name: 'Kimi',
    tool: 'Kimi Code',
    plan: 'Kimi membership',
    exe: 'kimi',
    run: 'kimi',
    login: 'kimi login',
    resume: (id) => `kimi -S ${id}`,
    last: 'kimi -c',
    install: null,
  },
};

const NATIVE_RE = /^[A-Za-z0-9_.:-]{1,100}$/;

function get(id) {
  const a = Object.prototype.hasOwnProperty.call(AGENTS, id) ? AGENTS[id] : null;
  if (!a) throw new Error('Loop does not know that agent.');
  return a;
}

// What a tab runs. kind: 'agent' (a session), 'agentLogin' or 'agentInstall'.
// A session continues its own conversation when Loop knows its id, else the
// latest one in the folder, else starts fresh.
function baseCommand(o) {
  const a = get(o.agent);
  if (o.kind === 'agentLogin') return a.login;
  if (o.kind === 'agentInstall') {
    if (!a.install) throw new Error(`Install ${a.tool} from its own website.`);
    return a.install;
  }
  if (o.native) {
    if (!NATIVE_RE.test(String(o.native))) throw new Error('That conversation id is not valid.');
    return a.resume(o.native);
  }
  return o.cont ? a.last : a.run;
}

// With a model chosen for the session, for an agent that takes one.
function command(o) {
  const base = baseCommand(o);
  const a = get(o.agent);
  const m = String(o.model || '');
  if (o.kind !== 'agent' || !m || !a.model || !/^[A-Za-z0-9._-]{1,80}$/.test(m)) return base;
  const [exe, ...rest] = base.split(' ');
  return [exe, a.model(m), ...rest].join(' ');
}

// ---- several logins for one agent ----

const ACCOUNT_RE = /^[a-z0-9]{1,24}$/;
let base = null; // where extra accounts live: <userData>/agents/<agent>/<account>

function init(userData) {
  base = path.join(userData, 'agents');
}

const isMainAccount = (account) => !account || account === 'default';
const multi = (id) => Boolean(get(id).homeEnv);

function accountDir(id, account) {
  const a = get(id);
  if (!a.homeEnv) throw new Error(`${a.tool} keeps one login on this PC.`);
  if (!ACCOUNT_RE.test(String(account)) || isMainAccount(account)) throw new Error('Loop does not know that account.');
  return path.join(base, id, account);
}

// A new account's folder: links to what all accounts share, a copy of the settings.
function prepare(id, account) {
  const a = get(id);
  const dir = accountDir(id, account);
  fs.mkdirSync(dir, { recursive: true });
  const main = a.mainHome();
  for (const name of a.shared || []) {
    const target = path.join(main, name);
    const link = path.join(dir, name);
    try {
      if (!fs.statSync(target).isDirectory()) continue;
    } catch {
      continue;
    }
    try {
      fs.lstatSync(link);
      continue; // already there
    } catch {
      fs.symlinkSync(target, link, 'junction');
    }
  }
  for (const name of a.copied || []) {
    const from = path.join(main, name);
    const to = path.join(dir, name);
    if (!fs.existsSync(to) && fs.existsSync(from)) fs.copyFileSync(from, to);
  }
  return dir;
}

// What the agent's program is started with for this account.
// Where an account's login lives, without making anything.
function homeOf(id, account) {
  const a = get(id);
  return isMainAccount(account) || !a.homeEnv ? a.mainHome() : accountDir(id, account);
}

function envFor(id, account) {
  if (isMainAccount(account)) return {};
  return { [get(id).homeEnv]: prepare(id, account) };
}

// Deletes an account's own login. The shared folders are links: they are taken
// out one by one first, so nothing they point to is touched.
function removeAccount(id, account) {
  const a = get(id);
  const dir = accountDir(id, account);
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (!fs.lstatSync(p).isSymbolicLink()) continue;
    try {
      fs.rmdirSync(p);
    } catch {
      fs.unlinkSync(p);
    }
  }
  for (const e of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (e.isSymbolicLink()) throw new Error(`Could not remove ${a.tool}'s account folder safely.`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

const run = (file, args, ms, env) =>
  new Promise((resolve) => {
    // On Windows these programs are .cmd files, which only a shell starts. The
    // words are fixed here, so they are joined rather than passed one by one.
    const win = process.platform === 'win32';
    execFile(win ? [file, ...args].join(' ') : file, win ? [] : args, { timeout: ms, windowsHide: true, shell: win, env: { ...process.env, ...(env || {}) } }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: `${stdout || ''}${stderr || ''}` }),
    );
  });

const installed = async (exe) => (await run(process.platform === 'win32' ? 'where' : 'which', [exe], 8000)).ok;
const exists = (p) => {
  try {
    return fs.statSync(p).size > 0;
  } catch {
    return false;
  }
};

// Whether a plan is signed in, in words; the key or token itself never leaves here.
function codexLogin(out) {
  if (/not logged in/i.test(out)) return { signedIn: false };
  if (/chatgpt/i.test(out)) return { signedIn: true, how: 'ChatGPT plan' };
  if (/api key/i.test(out)) return { signedIn: true, how: 'an API key, not your ChatGPT plan', apiKey: true };
  return { signedIn: null };
}

// Whether one account is signed in.
async function loginOf(id, account, home) {
  if (id === 'codex') return codexLogin((await run('codex', ['login', 'status'], 20000, envFor(id, account))).out);
  if (id === 'kimi') return { signedIn: exists(path.join(home, '.kimi-code', 'credentials', 'kimi-code.json')) };
  if (id === 'grok') return { signedIn: exists(path.join(home, '.grok', 'auth.json')) };
  return { signedIn: null };
}

// One agent: installed or not, and each of its accounts. `extra` is Loop's list
// of added accounts, [{ id, agent, name }]; the main login is always first.
async function statusOf(id, extra = [], home = HOME) {
  const a = get(id);
  const base = { id, name: a.name, tool: a.tool, plan: a.plan, canInstall: Boolean(a.install), multi: Boolean(a.homeEnv) };
  if (!(await installed(a.exe))) return { ...base, installed: false, signedIn: false, accounts: [] };
  const mine = a.homeEnv ? extra.filter((x) => x && x.agent === id && ACCOUNT_RE.test(String(x.id))) : [];
  const accounts = await Promise.all(
    [{ id: 'default' }, ...mine].map(async (x) => {
      try {
        return { id: x.id, ...(await loginOf(id, x.id, home)) };
      } catch (e) {
        return { id: x.id, signedIn: null, error: e.message };
      }
    }),
  );
  return { ...base, installed: true, ...accounts[0], id, accounts };
}

const statusAll = (extra = []) => Promise.all(Object.keys(AGENTS).map((id) => statusOf(id, extra)));

// Two ways of writing one folder: either slash, any case, with or without a trailing slash.
const dirKey = (p) =>
  path
    .resolve(String(p || '').replace(/\\/g, '/'))
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
const sameDir = (a, b) => dirKey(a) === dirKey(b);

function readFirstLine(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    return buf.toString('utf8', 0, n).split('\n')[0];
  } catch {
    return '';
  }
}

// Codex keeps each conversation in sessions/YYYY/MM/DD/rollout-*.jsonl, whose
// first line names its id and folder.
function codexNative(cwd, since, home) {
  const root = path.join(home, '.codex', 'sessions');
  const found = [];
  const walk = (dir, depth) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        const at = fs.statSync(p).mtimeMs;
        if (at >= since) found.push({ p, at });
      }
    }
  };
  walk(root, 0);
  found.sort((a, b) => a.at - b.at);
  for (const f of found) {
    try {
      const r = JSON.parse(readFirstLine(f.p));
      const meta = r.payload || r;
      if (meta.id && sameDir(meta.cwd, cwd) && Date.parse(meta.timestamp || 0) >= since - 60000) return String(meta.id);
    } catch {
      // not a conversation file
    }
  }
  return '';
}

// Kimi lists every conversation in session_index.jsonl, oldest first.
function kimiNative(cwd, since, home) {
  const index = path.join(home, '.kimi-code', 'session_index.jsonl');
  let lines = [];
  try {
    lines = fs.readFileSync(index, 'utf8').split('\n').filter(Boolean);
  } catch {
    return '';
  }
  for (const line of lines) {
    try {
      const r = JSON.parse(line);
      if (!sameDir(r.workDir, cwd) || !r.sessionDir) continue;
      if (fs.statSync(r.sessionDir).birthtimeMs >= since - 5000) return String(r.sessionId);
    } catch {
      // a line being written, or a folder since removed
    }
  }
  return '';
}

// The conversation an agent started in cwd after `since`, once it has saved one.
function findNative(id, cwd, since, home = HOME) {
  get(id);
  const out = id === 'codex' ? codexNative(cwd, since, home) : id === 'kimi' ? kimiNative(cwd, since, home) : '';
  return NATIVE_RE.test(out) ? out : '';
}

// Codex's file for one conversation: sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl.
function rolloutFile(native, home) {
  let file = '';
  const walk = (dir, depth) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (file) return;
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith(`${native}.jsonl`)) file = p;
    }
  };
  walk(path.join(home, '.codex', 'sessions'), 0);
  return file;
}

function readLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n');
  } catch {
    return [];
  }
}

// The last turns of an agent's conversation, as [{ role, text }], for the note
// handed to the next agent. Only Codex's are read for now; others give [].
function turns(id, native, home = HOME, max = 6) {
  get(id);
  if (id !== 'codex' || !NATIVE_RE.test(String(native || ''))) return [];
  const file = rolloutFile(native, home);
  if (!file) return [];
  const out = [];
  for (const line of readLines(file)) {
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    const p = r && r.type === 'response_item' && r.payload;
    if (!p || p.type !== 'message' || (p.role !== 'user' && p.role !== 'assistant')) continue;
    const text = (p.content || [])
      .map((c) => c.text || '')
      .join('\n')
      .trim();
    // Codex adds its own context as user messages in angle-bracket blocks.
    if (!text || text.startsWith('<')) continue;
    const last = out[out.length - 1];
    if (last && last.role === p.role && last.text === text) continue;
    out.push({ role: p.role, text });
  }
  return out.slice(-max);
}

// The model a conversation last ran on, as the agent wrote it down ('' when not known).
const modelCache = new Map();
function modelOf(id, native, home = HOME) {
  get(id);
  if (id !== 'codex' || !NATIVE_RE.test(String(native || ''))) return '';
  const file = rolloutFile(native, home);
  if (!file) return '';
  let at = 0;
  try {
    at = fs.statSync(file).mtimeMs;
  } catch {
    return '';
  }
  const hit = modelCache.get(file);
  if (hit && hit.at === at) return hit.model;
  let model = '';
  const lines = readLines(file);
  for (let i = lines.length - 1; i >= 0 && !model; i--) {
    if (!lines[i].includes('"turn_context"')) continue;
    try {
      const r = JSON.parse(lines[i]);
      if (r.type === 'turn_context' && r.payload && typeof r.payload.model === 'string') model = r.payload.model.slice(0, 100);
    } catch {
      // a line being written
    }
  }
  modelCache.set(file, { at, model });
  return model;
}

module.exports = { AGENTS, get, command, statusOf, statusAll, findNative, turns, modelOf, codexLogin, init, envFor, homeOf, removeAccount, multi };
