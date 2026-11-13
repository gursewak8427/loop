// Tool environments. You connect an MCP server to Loop once; Loop groups them
// into environments ("Personal", "Client work"), and a session gets one entry,
// "loop", that serves the tools of its environment. Which environment a session
// has is decided by its project (or by the default), and can be changed without
// touching any agent's own configuration.
//
//   session ──► http://127.0.0.1:<port>/hub/<secret>/<dir>/<session> ──► this file
//                                                        ├─► a program on this PC (stdio)
//                                                        └─► a web address (http)
//
// What is stored: userData/mcp-hub.json, read and written only here. Keys and
// tokens (a program's environment, a web address's headers) never go to a
// window: a window is told their names, not their values.
//
// Tools and environments are set up on the Loop Cloud website and read here
// (adopt). What this PC adds is its own: which environment a project uses, and
// its say-so before a program the cloud names is run (approve).
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const SEP = '__';
const START = 45e3; // a program gets this long to say hello (npx may be downloading)
const CALL = 10 * 60e3; // the longest one tool call may take
const IDLE = 15 * 60e3; // a program nobody has used for this long is closed

let FILE = '';
let doc = { v: 1, at: 0, servers: {}, envs: {}, projectEnv: {}, defaultEnv: '', approved: [], machine: os.hostname() };
let server = null;
let port = 0;
const secret = crypto.randomBytes(16).toString('hex');
let onChange = () => {};
const links = new Map(); // server key -> a live connection
const lastErr = new Map(); // server key -> why it did not connect

// ---------- the stored document ----------

const slug = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

function freeKey(base, taken) {
  let key = slug(base) || 'tool';
  for (let n = 2; taken[key]; n += 1) key = `${(slug(base) || 'tool').slice(0, 36)}-${n}`;
  return key;
}

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    doc = { v: 1, at: Number(d.at) || 0, servers: d.servers || {}, envs: d.envs || {}, projectEnv: d.projectEnv || {}, defaultEnv: d.defaultEnv || '', approved: Array.isArray(d.approved) ? d.approved : [], machine: d.machine || os.hostname() };
  } catch {
    // nothing saved yet
  }
}

function save(touch = true) {
  if (touch) doc.at = Date.now();
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
  onChange(state());
}

// What a window may know: everything but the values of keys and tokens.
function state() {
  return {
    servers: Object.entries(doc.servers).map(([key, s]) => ({
      key,
      name: s.name || key,
      kind: s.kind,
      command: s.command || '',
      args: s.args || [],
      url: s.url || '',
      envNames: Object.keys(s.env || {}),
      headerNames: Object.keys(s.headers || {}),
      on: s.on || '',
      here: !elsewhere(s),
      ask: asks(s),
      up: links.has(key) && links.get(key).ready,
      tools: links.has(key) ? links.get(key).tools.length : null,
      error: lastErr.get(key) || '',
    })),
    envs: Object.entries(doc.envs).map(([id, e]) => ({ id, name: e.name, servers: (e.servers || []).filter((k) => doc.servers[k]), only: e.only !== false })),
    projectEnv: { ...doc.projectEnv },
    defaultEnv: doc.envs[doc.defaultEnv] ? doc.defaultEnv : '',
    machine: doc.machine,
  };
}

// name=value lines, as typed into a form. A name with no value keeps what is stored.
function pairs(text, before = {}) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s*([^=:\s][^=:]*?)\s*[=:]\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2];
    else if (line.trim() && before[line.trim()] !== undefined) out[line.trim()] = before[line.trim()];
  }
  return out;
}

// Splits a command line the way a person types it: quotes keep spaces together.
function words(line) {
  const out = [];
  String(line || '').replace(/"([^"]*)"|'([^']*)'|(\S+)/g, (_m, a, b, c) => out.push(a ?? b ?? c));
  return out;
}

function saveServer(o) {
  const before = o.key ? doc.servers[o.key] : null;
  const name = String(o.name || '').trim().slice(0, 60);
  if (!name) return { ok: false, error: 'Give it a name.' };
  const kind = o.kind === 'http' ? 'http' : 'stdio';
  const s = { name, kind };
  if (kind === 'http') {
    let u;
    try {
      u = new URL(String(o.url || '').trim());
    } catch {
      return { ok: false, error: 'That web address is not valid.' };
    }
    if (!/^https?:$/.test(u.protocol)) return { ok: false, error: 'The address must start with http:// or https://.' };
    s.url = u.toString();
    s.headers = pairs(o.headers, before ? before.headers : {});
  } else {
    const parts = words(o.command);
    if (!parts.length) return { ok: false, error: 'Give the command that starts it.' };
    s.command = parts[0];
    s.args = parts.slice(1);
    s.env = pairs(o.env, before ? before.env : {});
    if (!doc.approved.includes(print(s))) doc.approved.push(print(s)); // typed in on this PC
  }
  const key = before ? o.key : freeKey(name, doc.servers);
  doc.servers[key] = s;
  drop(key);
  save();
  return { ok: true, key };
}

function removeServer(key) {
  if (!doc.servers[key]) return false;
  delete doc.servers[key];
  for (const e of Object.values(doc.envs)) e.servers = (e.servers || []).filter((k) => k !== key);
  drop(key);
  save();
  return true;
}

function saveEnv(o) {
  const name = String(o.name || '').trim().slice(0, 40);
  if (!name) return { ok: false, error: 'Give the environment a name.' };
  const id = o.id && doc.envs[o.id] ? o.id : freeKey(name, doc.envs);
  const before = doc.envs[id] || {};
  doc.envs[id] = {
    name,
    servers: (o.servers || before.servers || []).filter((k) => doc.servers[k]),
    only: o.only === undefined ? before.only !== false : Boolean(o.only),
  };
  save();
  return { ok: true, id };
}

function removeEnv(id) {
  if (!doc.envs[id]) return false;
  delete doc.envs[id];
  if (doc.defaultEnv === id) doc.defaultEnv = '';
  for (const [dir, e] of Object.entries(doc.projectEnv)) if (e === id) delete doc.projectEnv[dir];
  save();
  return true;
}

function setProjectEnv(dir, id) {
  if (id && id !== 'none' && !doc.envs[id]) return false;
  if (id) doc.projectEnv[dir] = id;
  else delete doc.projectEnv[dir]; // back to the default
  save();
  return true;
}

function setDefaultEnv(id) {
  doc.defaultEnv = doc.envs[id] ? id : '';
  save();
  return true;
}

// The environment a session works in: its project's, or the default. "none" on
// a project means that project takes no environment even when there is a default.
function envOf(dir) {
  const own = doc.projectEnv[dir];
  if (own === 'none') return null;
  const id = doc.envs[own] ? own : doc.envs[doc.defaultEnv] ? doc.defaultEnv : '';
  return id ? { id, ...doc.envs[id] } : null;
}

// ---------- bringing in what an agent already has ----------

// The MCP servers Claude Code is set up with on this PC, as Loop would store them.
function fromClaude(file) {
  let c;
  try {
    c = JSON.parse(fs.readFileSync(file || path.join(os.homedir(), '.claude.json'), 'utf8'));
  } catch {
    return [];
  }
  const out = [];
  for (const [name, s] of Object.entries(c.mcpServers || {})) {
    if (!s) continue;
    if (/^(http|sse)$/.test(s.type || '') && s.url) {
      if (s.type === 'sse') continue; // the older kind of web tool; not carried
      out.push({ name, kind: 'http', url: s.url, headers: s.headers || {} });
    } else if (s.command) {
      const args = Array.isArray(s.args) ? s.args.map(String) : [];
      out.push({ name, kind: 'stdio', command: String(s.command), args, env: s.env || {} });
    }
  }
  return out;
}

// Adds the ones Loop does not have yet (matched by name). Returns how many.
function importClaude(file) {
  let added = 0;
  const have = new Set(Object.values(doc.servers).map((s) => s.name));
  for (const s of fromClaude(file)) {
    if (have.has(s.name)) continue;
    doc.servers[freeKey(s.name, doc.servers)] = s;
    added += 1;
  }
  if (added) save();
  return { ok: true, added };
}

// ---------- talking to one server ----------

class Link {
  constructor(key, def) {
    this.key = key;
    this.def = def;
    this.tools = [];
    this.ready = false;
    this.seq = 0;
    this.waiting = new Map();
    this.used = Date.now();
    this.opening = null;
  }

  open() {
    if (!this.opening) {
      this.opening = this.start().then(
        () => {
          this.ready = true;
          lastErr.delete(this.key);
        },
        (e) => {
          this.close();
          lastErr.set(this.key, plain(e));
          links.delete(this.key);
          throw e;
        },
      );
    }
    return this.opening;
  }

  async start() {
    if (this.def.kind === 'stdio') this.spawn();
    const hello = await this.ask('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'Loop', version: '1' } }, START);
    this.info = (hello && hello.serverInfo) || {};
    await this.tell('notifications/initialized');
    await this.refresh();
  }

  async refresh() {
    const all = [];
    let cursor;
    for (let page = 0; page < 20; page += 1) {
      const r = await this.ask('tools/list', cursor ? { cursor } : {}, START);
      all.push(...((r && r.tools) || []));
      cursor = r && r.nextCursor;
      if (!cursor) break;
    }
    this.tools = all;
  }

  spawn() {
    const { command, args = [], env = {} } = this.def;
    // On Windows, npx and friends are .cmd files, which only a shell can start.
    const viaShell = process.platform === 'win32' && !/\.exe$/i.test(command);
    const quote = (a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
    this.child = viaShell
      ? spawn([command, ...args].map(quote).join(' '), { shell: true, env: { ...process.env, ...env }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      : spawn(command, args, { env: { ...process.env, ...env }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    this.child.stdout.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          this.got(JSON.parse(line));
        } catch {
          // a program that prints something else on stdout; not ours to read
        }
      }
    });
    let said = '';
    this.child.stderr.on('data', (d) => (said = (said + d).slice(-600)));
    const gone = (why) => {
      const err = new Error(why);
      for (const w of this.waiting.values()) w.rej(err);
      this.waiting.clear();
      this.ready = false;
      if (links.get(this.key) === this) links.delete(this.key);
    };
    this.child.on('error', (e) => gone(e.code === 'ENOENT' ? `"${command}" was not found on this PC.` : e.message));
    this.child.on('exit', (code) => gone(`It stopped${code ? ` (exit ${code})` : ''}.${said.trim() ? ` It said: ${said.trim().split('\n').pop()}` : ''}`));
  }

  got(msg) {
    if (msg.id !== undefined && msg.id !== null && this.waiting.has(msg.id) && (msg.result !== undefined || msg.error)) {
      const w = this.waiting.get(msg.id);
      this.waiting.delete(msg.id);
      clearTimeout(w.timer);
      if (msg.error) w.rej(new Error(msg.error.message || 'The tool server answered with an error.'));
      else w.res(msg.result);
    } else if (msg.id !== undefined && msg.method) {
      // The server asks us something (a ping, a list of roots). Answer politely.
      this.send({ jsonrpc: '2.0', id: msg.id, ...(msg.method === 'ping' ? { result: {} } : { error: { code: -32601, message: 'Not supported' } }) }).catch(() => {});
    }
  }

  ask(method, params, timeout = CALL) {
    this.used = Date.now();
    const id = ++this.seq;
    const msg = { jsonrpc: '2.0', id, method, params };
    if (this.def.kind === 'http') return this.post(msg, timeout);
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        rej(new Error(`No answer in ${Math.round(timeout / 1000)} seconds.`));
      }, timeout);
      this.waiting.set(id, { res, rej, timer });
      this.send(msg).catch((e) => {
        clearTimeout(timer);
        this.waiting.delete(id);
        rej(e);
      });
    });
  }

  tell(method, params) {
    const msg = { jsonrpc: '2.0', method, ...(params ? { params } : {}) };
    return this.def.kind === 'http' ? this.post(msg, 15e3).catch(() => {}) : this.send(msg);
  }

  send(msg) {
    return new Promise((res, rej) => {
      if (!this.child || !this.child.stdin.writable) return rej(new Error('It is not running.'));
      this.child.stdin.write(`${JSON.stringify(msg)}\n`, (e) => (e ? rej(e) : res()));
    });
  }

  // A web tool answers a POST with JSON, or with a stream that carries the answer.
  async post(msg, timeout) {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(this.def.headers || {}) };
    if (this.session) headers['Mcp-Session-Id'] = this.session;
    let res;
    try {
      res = await fetch(this.def.url, { method: 'POST', headers, body: JSON.stringify(msg), signal: AbortSignal.timeout(timeout) });
    } catch (e) {
      throw new Error(e.name === 'TimeoutError' ? `No answer in ${Math.round(timeout / 1000)} seconds.` : `Could not reach it (${(e.cause && (e.cause.code || e.cause.message)) || e.message}).`);
    }
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.session = sid;
    if (msg.id === undefined) return null;
    if (res.status === 401 || res.status === 403) throw new Error('It refused the key or token it was given.');
    if (!res.ok) throw new Error(`It answered ${res.status}.`);
    const type = res.headers.get('content-type') || '';
    let answer = null;
    if (type.includes('text/event-stream')) {
      for (const block of (await res.text()).split(/\r?\n\r?\n/)) {
        const data = block
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
          .join('\n');
        if (!data) continue;
        try {
          const m = JSON.parse(data);
          if (m.id === msg.id) answer = m;
        } catch {
          // not a message
        }
      }
    } else {
      const body = await res.json();
      answer = Array.isArray(body) ? body.find((m) => m.id === msg.id) : body;
    }
    if (!answer) throw new Error('It gave no answer.');
    if (answer.error) throw new Error(answer.error.message || 'The tool server answered with an error.');
    return answer.result;
  }

  close() {
    this.ready = false;
    for (const w of this.waiting.values()) {
      clearTimeout(w.timer);
      w.rej(new Error('Closed.'));
    }
    this.waiting.clear();
    if (this.child) {
      try {
        this.child.stdin.end();
        if (process.platform === 'win32' && this.child.pid) spawn('taskkill', ['/pid', String(this.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        else this.child.kill();
      } catch {
        // already gone
      }
      this.child = null;
    }
  }
}

const plain = (e) => String((e && e.message) || e || 'It did not connect.').split('\n')[0].slice(0, 240);

function drop(key) {
  const l = links.get(key);
  if (l) l.close();
  links.delete(key);
  lastErr.delete(key);
}

async function linkTo(key) {
  const def = doc.servers[key];
  if (!def) throw new Error('That tool is no longer set up in Loop.');
  if (elsewhere(def)) throw new Error(`It lives on ${def.on}, not on this machine.`);
  if (asks(def)) {
    lastErr.set(key, 'Waiting for you to allow it on this PC.');
    throw new Error('It has not been allowed to run on this PC yet. Open Tools in Loop and allow it.');
  }
  let l = links.get(key);
  if (!l) {
    l = new Link(key, def);
    links.set(key, l);
  }
  await l.open();
  return l;
}

// Connects once and says what it found; what the Test button shows.
async function test(key) {
  drop(key);
  try {
    const l = await linkTo(key);
    onChange(state());
    return { ok: true, tools: l.tools.map((t) => t.name), server: (l.info && l.info.name) || '' };
  } catch (e) {
    onChange(state());
    return { ok: false, error: plain(e) };
  }
}

// ---------- what a session sees ----------

const META = [
  {
    name: 'loop_find_tools',
    description:
      'Lists the tools of your Loop environment as they are right now, including ones connected after this session started. Pass a few words to narrow it down. Use the name it gives with loop_run_tool when that tool is not already in your own list.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Words to look for in a tool name or description. Leave out to list everything.' } } },
  },
  {
    name: 'loop_run_tool',
    description: 'Runs a tool of your Loop environment by the name loop_find_tools gave, with its arguments. For tools that joined the environment after this session started.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, arguments: { type: 'object' } }, required: ['name'] },
  },
];

// Every tool of an environment, named "<server>__<tool>". A server that will
// not connect is left out and remembered, so one broken tool does not cost the rest.
async function toolsOf(env) {
  const keys = (env.servers || []).filter((k) => doc.servers[k]);
  const got = await Promise.all(keys.map((k) => linkTo(k).then((l) => [k, l], () => [k, null])));
  const out = [];
  for (const [key, l] of got) {
    if (!l) continue;
    for (const t of l.tools) {
      out.push({ ...t, name: `${key}${SEP}${t.name}`, description: `[${doc.servers[key].name}] ${t.description || ''}`.trim() });
    }
  }
  return out;
}

const textResult = (text, isError) => ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });

async function runTool(env, name, args) {
  const i = name.indexOf(SEP);
  const key = i > 0 ? name.slice(0, i) : '';
  if (!key || !(env.servers || []).includes(key) || !doc.servers[key]) return textResult(`There is no tool "${name}" in the ${env.name} environment. Call loop_find_tools to see what is there.`, true);
  try {
    const l = await linkTo(key);
    return await l.ask('tools/call', { name: name.slice(i + SEP.length), arguments: args || {} });
  } catch (e) {
    return textResult(`${doc.servers[key].name} did not answer: ${plain(e)}`, true);
  }
}

async function handle(msg, dir) {
  const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
  const env = envOf(dir);
  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: (msg.params && msg.params.protocolVersion) || '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'loop', version: '1' },
        instructions: env
          ? `These are the tools of the "${env.name}" environment in Loop. Each is named <server>__<tool>. Tools connected in Loop after this session started are not in your list: find them with loop_find_tools and run them with loop_run_tool.`
          : 'This project has no tool environment in Loop.',
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: env ? [...(await toolsOf(env)), ...META] : [] });
    case 'tools/call': {
      const p = msg.params || {};
      if (!env) return reply(textResult('This project has no tool environment in Loop.', true));
      if (p.name === 'loop_find_tools') {
        const q = String((p.arguments && p.arguments.query) || '').toLowerCase().split(/\s+/).filter(Boolean);
        const all = await toolsOf(env);
        const hit = all.filter((t) => q.every((w) => `${t.name} ${t.description}`.toLowerCase().includes(w)));
        const missing = (env.servers || []).filter((k) => doc.servers[k] && lastErr.has(k)).map((k) => `${doc.servers[k].name}: ${lastErr.get(k)}`);
        return reply(
          textResult(
            JSON.stringify({ environment: env.name, tools: hit.slice(0, 60).map((t) => ({ name: t.name, description: (t.description || '').slice(0, 300), inputSchema: t.inputSchema })), more: Math.max(0, hit.length - 60), notConnected: missing }, null, 1),
          ),
        );
      }
      if (p.name === 'loop_run_tool') return reply(await runTool(env, String((p.arguments && p.arguments.name) || ''), (p.arguments && p.arguments.arguments) || {}));
      return reply(await runTool(env, String(p.name || ''), p.arguments));
    }
    default:
      return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
  }
}

function listen() {
  server = http.createServer((req, res) => {
    const send = (code, body) => {
      res.writeHead(code, body ? { 'Content-Type': 'application/json' } : {});
      res.end(body ? JSON.stringify(body) : undefined);
    };
    const m = /^\/hub\/([a-f0-9]+)\/([A-Za-z0-9_-]+)\/([0-9a-f-]{36})\/?$/.exec(req.url || '');
    if (!m || m[1] !== secret || !UUID_RE.test(m[3])) return send(404);
    if (req.method === 'DELETE') return send(200);
    if (req.method !== 'POST') return send(405);
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 8e6) req.destroy();
    });
    req.on('end', async () => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      }
      const out = [];
      for (const one of Array.isArray(msg) ? msg : [msg]) {
        if (one.id === undefined || one.id === null) continue; // a notification
        out.push(await handle(one, m[2]).catch((e) => ({ jsonrpc: '2.0', id: one.id, error: { code: -32603, message: plain(e) } })));
      }
      if (!out.length) return send(202);
      send(200, Array.isArray(msg) ? out : out[0]);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve(port);
    });
  });
}

// The entry a session's tool file gets, or null when its project has no environment.
function entryFor(dir, sessionId) {
  const env = envOf(dir);
  if (!port || !env || !/^[A-Za-z0-9_-]+$/.test(dir || '') || !UUID_RE.test(sessionId || '')) return null;
  return { name: 'loop', only: env.only !== false, env: env.name, server: { type: 'http', url: `http://127.0.0.1:${port}/hub/${secret}/${dir}/${sessionId}` } };
}

// Writes the --mcp-config file for one session: Loop's memory (when it has
// one) and its environment's tools. "only" says the session should take no
// other tools than these.
function fileFor(dir, sessionId, memoryUrl) {
  const mine = entryFor(dir, sessionId);
  if (!mine && !memoryUrl) return { file: null, only: false };
  const mcpServers = {};
  if (memoryUrl) mcpServers['team-memory'] = { type: 'http', url: memoryUrl };
  if (mine) mcpServers[mine.name] = mine.server;
  const folder = path.join(path.dirname(FILE), 'mcp');
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `${sessionId}.json`);
  fs.writeFileSync(file, JSON.stringify({ mcpServers }));
  return { file, only: Boolean(mine && mine.only) };
}

// ---------- what Loop Cloud says ----------

// Takes the tools and environments as they are set up on the website. This PC
// keeps what is its own: which project uses which environment, its default,
// and which programs it has been allowed to run.
function adopt(theirs, machine) {
  if (machine && machine !== doc.machine) doc.machine = machine;
  if (!theirs || !theirs.servers) return false;
  const next = { servers: theirs.servers, envs: theirs.envs || {} };
  if (JSON.stringify(next) === JSON.stringify({ servers: doc.servers, envs: doc.envs })) return false;
  for (const k of Object.keys(doc.servers)) if (JSON.stringify(next.servers[k]) !== JSON.stringify(doc.servers[k])) drop(k);
  doc.servers = next.servers;
  doc.envs = next.envs;
  doc.at = Number(theirs.at) || Date.now();
  if (!doc.envs[doc.defaultEnv]) doc.defaultEnv = '';
  save(false);
  return true;
}

// A program named by the cloud runs on this PC only after someone here has
// said so: a stolen cloud sign-in must not be a way to run commands on it.
// Any change to the command or its keys asks again.
const print = (s) => crypto.createHash('sha256').update(JSON.stringify([s.command, s.args || [], Object.entries(s.env || {}).sort()])).digest('hex');
const elsewhere = (s) => Boolean(s.on && s.on !== doc.machine);
const asks = (s) => s.kind === 'stdio' && !elsewhere(s) && !doc.approved.includes(print(s));

function approve(key) {
  const s = doc.servers[key];
  if (!s || s.kind !== 'stdio') return false;
  if (!doc.approved.includes(print(s))) doc.approved.push(print(s));
  lastErr.delete(key);
  save(false);
  return true;
}

// The tools this PC itself handed to the cloud are its own: no need to ask.
function trust(list) {
  for (const s of list || []) if (s.kind === 'stdio' && !doc.approved.includes(print(s))) doc.approved.push(print(s));
  save(false);
}

// ---------- start and stop ----------

let sweep = null;

async function init(userData, opts = {}) {
  FILE = path.join(userData, 'mcp-hub.json');
  onChange = opts.onChange || (() => {});
  load();
  await listen();
  sweep = setInterval(() => {
    for (const [key, l] of links) if (l.def.kind === 'stdio' && Date.now() - l.used > IDLE && !l.waiting.size) drop(key);
  }, 60e3);
  sweep.unref();
  return port;
}

function stop() {
  if (sweep) clearInterval(sweep);
  for (const key of [...links.keys()]) drop(key);
  if (server) server.close();
  server = null;
  port = 0;
}

module.exports = { fileFor, init, stop, state, saveServer, removeServer, saveEnv, removeEnv, setProjectEnv, setDefaultEnv, envOf, importClaude, fromClaude, test, entryFor, adopt, approve, trust, handle, words, pairs };
