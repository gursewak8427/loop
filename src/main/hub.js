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
//
// A tool can also run in Loop Cloud (viaCloud). This PC is then given no key
// for it, only an address on Loop Cloud, which it calls with its own sign-in.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const oauth = require('./oauth');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const SEP = '__';
const START = 45e3; // a program gets this long to say hello (npx may be downloading)
const CALL = 10 * 60e3; // the longest one tool call may take
const IDLE = 15 * 60e3; // a program nobody has used for this long is closed

let FILE = '';
let doc = { v: 1, at: 0, servers: {}, envs: {}, projectEnv: {}, defaultEnv: '', approved: [], machine: os.hostname(), local: {}, localOff: [] };
let server = null;
const spent = new Set(); // sign-ins this app started that have come back: their links work once
let backServer = null; // the fixed address a website-started sign-in comes back to
let port = 0;
const secret = crypto.randomBytes(16).toString('hex');
let onChange = () => {};
let cloudHeaders = () => ({}); // this machine's Loop Cloud sign-in, as request headers
let cloudBase = ''; // where Loop Cloud is; the only place that sign-in is sent
let cloudRefresh = async () => {}; // reads the tools from Loop Cloud again
const links = new Map(); // server key -> a live connection
const lastErr = new Map(); // server key -> why it did not connect
const needs = new Set(); // keys of this PC's web tools that asked for a sign-in
const pendings = new Map(); // sign-ins under way: state -> { key, pending, at }

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
    doc = { v: 1, at: Number(d.at) || 0, servers: d.servers || {}, envs: d.envs || {}, projectEnv: d.projectEnv || {}, defaultEnv: d.defaultEnv || '', approved: Array.isArray(d.approved) ? d.approved : [], machine: d.machine || os.hostname(), local: d.local && typeof d.local === 'object' ? d.local : {}, localOff: Array.isArray(d.localOff) ? d.localOff : [] };
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
      fileNames: Object.keys(s.files || {}),
      on: s.on || '',
      viaCloud: viaCloud(s),
      // A tool in Loop Cloud that signs in at its service: 'in', 'needed', or '' when it has no sign-in.
      signIn: viaCloud(s) ? s.signIn || '' : '',
      here: !elsewhere(s),
      ask: asks(s),
      // A GitHub connection signed in in Loop Cloud: git in its projects' sessions signs in through it.
      git: viaCloud(s) && s.git === true,
      up: links.has(key) && links.get(key).ready,
      tools: links.has(key) ? links.get(key).tools.length : null,
      error: lastErr.get(key) || '',
    })),
    envs: Object.entries(doc.envs).map(([id, e]) => ({ id, name: e.name, servers: (e.servers || []).filter((k) => doc.servers[k]), only: e.only !== false })),
    projectEnv: { ...doc.projectEnv },
    defaultEnv: doc.envs[doc.defaultEnv] ? doc.defaultEnv : '',
    machine: doc.machine,
    // Tools added on this PC, in Loop. They are this PC's own and go nowhere else.
    local: Object.entries(doc.local).map(([key, s]) => ({
      key,
      name: s.name || key,
      kind: s.kind,
      command: s.kind === 'stdio' ? [s.command, ...(s.args || []).map((a) => (/\s/.test(a) ? `"${a}"` : a))].join(' ') : '',
      url: s.url || '',
      envNames: Object.keys(s.env || {}),
      headerNames: Object.keys(s.headers || {}),
      dir: s.dir || '',
      // 'in' signed in, 'needed' it asked for a sign-in, '' it has none.
      auth: oauth.signedIn(s.auth) ? 'in' : needs.has(key) ? 'needed' : '',
      clientId: (s.client && s.client.id) || '',
      on: !doc.localOff.includes(key),
      up: links.has(key) && links.get(key).ready,
      tools: links.has(key) ? links.get(key).tools.length : null,
      error: lastErr.get(key) || '',
    })),
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

// ---------- tools on this PC ----------
// Added here, in Loop, and kept in this PC's own file. Every session on this
// PC gets the ones that are switched on, whichever agent it runs on, beside
// the tools of its Loop Cloud environment. They are never sent to the cloud.

const defOf = (key) => doc.servers[key] || doc.local[key] || null;
// The ones switched on, for one project: a tool kept to a project is left out elsewhere.
const localOn = (dir) => Object.keys(doc.local).filter((k) => !doc.localOff.includes(k) && !doc.servers[k] && (!doc.local[k].dir || doc.local[k].dir === dir));

function saveLocal(o) {
  const before = o.key ? doc.local[o.key] : null;
  if (o.key && !before) return { ok: false, error: 'That tool is no longer there.' };
  const built = buildTool(o, before);
  if (built.error) return { ok: false, error: built.error };
  const key = before ? o.key : freeKey(built.tool.name, { ...doc.servers, ...doc.local });
  doc.local[key] = built.tool;
  drop(key);
  save(false);
  return { ok: true, key };
}

function removeLocal(key) {
  if (!doc.local[key]) return false;
  delete doc.local[key];
  needs.delete(key);
  doc.localOff = doc.localOff.filter((k) => k !== key);
  drop(key);
  save(false);
  return true;
}

function setLocalOn(key, on) {
  if (!doc.local[key]) return false;
  doc.localOff = doc.localOff.filter((k) => k !== key);
  if (!on) {
    doc.localOff.push(key);
    drop(key);
  }
  save(false);
  return true;
}

// Brings in the MCP servers an agent is already set up with on this PC. Ones
// Loop has by name are left alone. Returns how many were added.
function importLocal(file) {
  const have = new Set(Object.values(doc.local).map((s) => s.name));
  let added = 0;
  for (const s of fromClaude(file)) {
    if (have.has(s.name)) continue;
    if (s.kind === 'stdio' && !doc.approved.includes(print(s))) doc.approved.push(print(s));
    doc.local[freeKey(s.name, { ...doc.servers, ...doc.local })] = s;
    have.add(s.name);
    added += 1;
  }
  if (added) save(false);
  return { ok: true, added };
}

// What a session on this PC works with: its environment's tools, and this
// PC's own. Null when there is neither.
function scopeOf(dir) {
  const env = envOf(dir);
  const mine = localOn(dir);
  if (!env && !mine.length) return null;
  return { id: env ? env.id : '', name: env ? env.name : 'This PC', only: env ? env.only === true : false, servers: [...(env ? (env.servers || []).filter((k) => doc.servers[k]) : []), ...mine] };
}

// A tool as it is stored, from what a form sent. { tool } or { error }.
function buildTool(o, before) {
  const name = String(o.name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!name) return { error: 'Give it a name.' };
  const s = { name, kind: o.kind === 'http' ? 'http' : 'stdio' };
  if (/^[A-Za-z0-9_-]+$/.test(String(o.dir || ''))) s.dir = String(o.dir); // kept to one project
  if (s.kind === 'http') {
    let u;
    try {
      u = new URL(String(o.url || '').trim());
    } catch {
      return { error: 'That web address is not valid.' };
    }
    if (!/^https?:$/.test(u.protocol)) return { error: 'The address must start with http:// or https://.' };
    s.url = u.toString();
    s.headers = pairs(o.headers, before ? before.headers : {});
    // Loop registered by hand with the service: its client ID, and a secret if it gave one.
    const id = String(o.clientId || '').trim().slice(0, 400);
    const old = before && before.client;
    if (id) s.client = { id, secret: String(o.clientSecret || '') || (old && old.id === id ? old.secret : '') };
    // A sign-in is kept only for the address it was made for, and the same registration.
    const same = before && before.kind === 'http' && before.auth && before.auth.origin === u.origin && ((before.client && before.client.id) || '') === id;
    if (same) s.auth = before.auth;
  } else {
    const parts = words(o.command);
    if (!parts.length) return { error: 'Give the command that starts it.' };
    s.command = parts[0];
    s.args = parts.slice(1);
    s.env = pairs(o.env, before ? before.env : {});
    if (!doc.approved.includes(print(s))) doc.approved.push(print(s)); // typed in on this PC
  }
  return { tool: s };
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
  if (id && id !== 'none' && id !== ALL && !doc.envs[id]) return false;
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

// "All tools": every tool connected on Loop Cloud, beside this PC's own. It is
// what a project gets when nothing narrower was chosen, for it or for this PC.
const ALL = '*';
// The tools a session works with: its project's choice, or this PC's, or all
// of them. ("none" on a project is an older choice, still kept: no cloud tools.)
function envOf(dir) {
  const own = doc.projectEnv[dir];
  if (own === 'none') return null;
  const id = own === ALL ? '' : doc.envs[own] ? own : doc.envs[doc.defaultEnv] ? doc.defaultEnv : '';
  if (id) return { id, ...doc.envs[id] };
  const servers = Object.keys(doc.servers);
  return servers.length ? { id: ALL, name: 'All tools', servers, only: false } : null;
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

// ---------- files a tool carries ----------

// A tool's files (a key, a certificate) are written to a folder of its own on
// this machine, readable by this user only, and {file:NAME} in its command,
// keys or headers becomes the path. Files no longer attached are removed.
function placeFiles(key, def) {
  const dir = path.join(path.dirname(FILE), 'mcp-files', key);
  const files = def.files || {};
  const names = Object.keys(files);
  if (!names.length) {
    fs.rmSync(dir, { recursive: true, force: true });
    return def;
  }
  fs.mkdirSync(dir, { recursive: true });
  for (const old of fs.readdirSync(dir)) if (files[old] === undefined) fs.rmSync(path.join(dir, old), { force: true });
  for (const n of names) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/.test(n)) continue;
    const want = Buffer.from(files[n], 'base64');
    const at = path.join(dir, n);
    let have = null;
    try {
      have = fs.readFileSync(at);
    } catch {
      // not there yet
    }
    if (!have || !have.equals(want)) fs.writeFileSync(at, want, { mode: 0o600 });
  }
  const put = (v) => String(v).replace(/\{file:([^}]+)\}/g, (m, n) => (files[n] !== undefined ? path.join(dir, n) : m));
  const map = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k, put(v)]));
  return { ...def, command: def.command ? put(def.command) : def.command, args: (def.args || []).map(put), env: map(def.env), headers: map(def.headers) };
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
  async post(msg, timeout, again) {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(this.def.headers || {}) };
    const far = viaCloud(this.def);
    if (!far && oauth.signedIn(this.def.auth)) {
      if (oauth.stale(this.def.auth)) await renewNow(this.key, this.def).catch(() => {});
      headers.Authorization = `Bearer ${this.def.auth.access}`;
    }
    if (far) {
      // This call carries the machine's sign-in, so it goes to Loop Cloud and
      // nowhere else, whatever the document says.
      if (!inCloud(this.def.url)) throw new Error('It is marked as running in Loop Cloud, but its address is somewhere else. It was not called.');
      const mine = cloudHeaders() || {};
      if (!mine.Authorization) throw new Error('Sign in to Loop Cloud first.');
      Object.assign(headers, mine);
    }
    if (this.session) headers['Mcp-Session-Id'] = this.session;
    let res;
    try {
      res = await fetch(this.def.url, { method: 'POST', headers, body: JSON.stringify(msg), signal: AbortSignal.timeout(timeout), ...(far ? { redirect: 'error' } : {}) });
    } catch (e) {
      throw new Error(e.name === 'TimeoutError' ? `No answer in ${Math.round(timeout / 1000)} seconds.` : `Could not reach it (${(e.cause && (e.cause.code || e.cause.message)) || e.message}).`);
    }
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.session = sid;
    if (msg.id === undefined) return null;
    if (res.status === 401 && !far && doc.local[this.key] && !Object.keys(this.def.headers || {}).some((n) => /^authorization$/i.test(n))) {
      // Its token may just have run out: one fresh one, one more try.
      if (!again && oauth.signedIn(this.def.auth) && this.def.auth.refresh) {
        const fresh = await renewNow(this.key, this.def).then(
          () => true,
          () => false,
        );
        if (fresh) return this.post(msg, timeout, true);
      }
      const had = oauth.signedIn(this.def.auth);
      needs.add(this.key);
      throw new Error(had ? 'Its sign-in has run out. Press Sign in.' : 'It asks you to sign in. Press Sign in.');
    }
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

// ---------- signing in to a web tool on this PC ----------
// The standard way (OAuth): Loop asks the server where its sign-in is, opens
// that page in the browser, and the browser comes back to this PC with a code.
// The token is kept in this PC's file and goes only to that tool.

const appReq = async (url, o = {}) => {
  const r = await fetch(url, { method: o.method || 'GET', headers: { 'User-Agent': 'Loop', ...(o.headers || {}) }, body: o.body, signal: AbortSignal.timeout(20e3) });
  return { status: r.status, headers: Object.fromEntries(r.headers), text: await r.text() };
};

async function renewNow(key, def) {
  const fresh = await oauth.renew(appReq, def.auth);
  def.auth = fresh;
  if (doc.local[key]) {
    doc.local[key].auth = fresh;
    save(false);
  }
}

// Starts a sign-in and answers with the page to open: { ok, url } or { ok: false, error }.
async function signIn(key) {
  if (!doc.local[key] && doc.servers[key] && viaCloud(doc.servers[key])) return signInFar(key);
  const def = doc.local[key];
  if (!def || def.kind !== 'http') return { ok: false, error: 'Only a web address added on this PC is signed in to here.' };
  try {
    const b = await oauth.begin(appReq, def.url, `http://127.0.0.1:${port}/oauth/callback`, { clientId: def.client && def.client.id, clientSecret: def.client && def.client.secret });
    if (!b.needed) return { ok: false, error: b.status >= 200 && b.status < 300 ? 'It answers without a sign-in.' : `It does not offer a sign-in (it answered ${b.status}). If it takes a key, put the key in its headers.` };
    for (const [s, p] of pendings) if (Date.now() - p.at > 15 * 60e3) pendings.delete(s);
    pendings.set(b.state, { key, pending: b.pending, at: Date.now() });
    return { ok: true, url: b.url };
  } catch (e) {
    return { ok: false, error: plain(e) };
  }
}

// A tool that runs in Loop Cloud, signed in from here. Loop Cloud finds the
// page and keeps the sign-in; this PC only lends the address the browser comes
// back to, which is what a service that turns a website away will accept.
async function farCall(pathname, body) {
  const mine = cloudHeaders() || {};
  if (!cloudBase || !mine.Authorization) throw new Error('Sign in to Loop Cloud first.');
  let r;
  try {
    r = await fetch(`${cloudBase}${pathname}`, { method: 'POST', headers: { ...mine, 'Content-Type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(60e3) });
  } catch (e) {
    throw new Error(e.name === 'TimeoutError' ? 'Loop Cloud did not answer.' : 'Could not reach Loop Cloud.');
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Loop Cloud answered ${r.status}.`);
  return j;
}

async function signInFar(key) {
  try {
    const j = await farCall(`/api/tools/servers/${encodeURIComponent(key)}/signin`, { redirect: `http://127.0.0.1:${port}/oauth/callback` });
    if (!/^https?:\/\//.test(String(j.url)) || !j.state) throw new Error('Loop Cloud gave no sign-in page.');
    for (const [s, p] of pendings) if (Date.now() - p.at > 15 * 60e3) pendings.delete(s);
    pendings.set(String(j.state), { key, far: true, at: Date.now() });
    return { ok: true, url: String(j.url) };
  } catch (e) {
    return { ok: false, error: plain(e) };
  }
}

function signOut(key) {
  const def = doc.local[key];
  if (!def || !def.auth) return false;
  delete def.auth;
  drop(key);
  save(false);
  onChange(state());
  return true;
}

// The browser coming back from the sign-in page. Answers what to show there.
async function signedBack(q) {
  const p = pendings.get(String(q.get('state') || ''));
  // Not one this app started: it was started on the Loop Cloud website, for a
  // service that sends people back only to their own computer. The code is
  // handed to Loop Cloud, which knows the sign-in by its state and trades it there.
  // (A link of this app's own that was already used is not one of those: its code goes nowhere.)
  if (!p && !spent.has(String(q.get('state'))) && q.get('state') && (q.get('code') || q.get('error'))) {
    try {
      const r = await farCall('/api/tools/oauth/finish', { state: q.get('state'), code: q.get('code') || '', error: q.get('error_description') || q.get('error') || '' });
      await Promise.resolve(cloudRefresh()).catch(() => {});
      return { ok: true, text: `You are signed in${r && r.name ? ` to ${r.name}` : ''}. It is ready on every machine. You can close this tab and go back to Loop Cloud.` };
    } catch (e) {
      // When this app could not hand it over (not signed in to Loop Cloud, or no connection), the website still can.
      const stuck = /Sign in to Loop Cloud first|Could not reach|did not answer/.test(plain(e));
      return { ok: false, text: stuck ? `${plain(e)} Copy this page's address and paste it into the box on the Loop Cloud website: the sign-in finishes there.` : plain(e) };
    }
  }
  if (!p || Date.now() - p.at > 15 * 60e3) return { ok: false, text: 'This sign-in link was already used, or is too old. Press Sign in again in Loop.' };
  pendings.delete(q.get('state'));
  spent.add(String(q.get('state')));
  if (spent.size > 300) spent.delete(spent.values().next().value);
  if (p.far) {
    const name = (doc.servers[p.key] && doc.servers[p.key].name) || p.key;
    try {
      await farCall('/api/tools/oauth/finish', { state: q.get('state'), code: q.get('code') || '', error: q.get('error_description') || q.get('error') || '' });
    } catch (e) {
      return { ok: false, text: plain(e) };
    }
    lastErr.delete(p.key);
    await Promise.resolve(cloudRefresh()).catch(() => {});
    test(p.key);
    return { ok: true, text: `You are signed in to ${name}. It is ready on every machine. You can close this tab and go back to Loop.` };
  }
  const def = doc.local[p.key];
  if (!def) return { ok: false, text: 'That tool is no longer in Loop.' };
  if (q.get('error') || !q.get('code')) return { ok: false, text: `${def.name} did not sign you in${q.get('error_description') || q.get('error') ? `: ${String(q.get('error_description') || q.get('error')).slice(0, 200)}` : '.'}` };
  try {
    def.auth = await oauth.finish(appReq, p.pending, q.get('code'));
  } catch (e) {
    return { ok: false, text: plain(e) };
  }
  needs.delete(p.key);
  save(false);
  test(p.key); // connects with the new sign-in and tells the windows
  return { ok: true, text: `You are signed in to ${def.name}. You can close this tab and go back to Loop.` };
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const backPage = (r) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Loop</title><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#0b1118;color:#e6edf3;font:16px/1.5 system-ui,sans-serif"><div style="max-width:420px;padding:28px;text-align:center"><div style="font-size:20px;font-weight:650;margin-bottom:8px">${r.ok ? 'Signed in' : 'Not signed in'}</div><div style="color:#9aa7b4">${esc(r.text)}</div></div>`;

function drop(key) {
  farGit.clear(); // a sign-in handed over for git is not kept past a change
  if (!defOf(key) && FILE) fs.rmSync(path.join(path.dirname(FILE), 'mcp-files', key), { recursive: true, force: true });
  const l = links.get(key);
  if (l) l.close();
  links.delete(key);
  lastErr.delete(key);
}

async function linkTo(key) {
  const def = defOf(key);
  if (!def) throw new Error('That tool is no longer set up in Loop.');
  if (elsewhere(def)) throw new Error(`It lives on ${def.on}, not on this machine.`);
  if (asks(def)) {
    lastErr.set(key, 'Waiting for you to allow it on this PC.');
    throw new Error('It has not been allowed to run on this PC yet. Open Tools in Loop and allow it.');
  }
  let l = links.get(key);
  if (!l) {
    l = new Link(key, placeFiles(key, def));
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
  const keys = (env.servers || []).filter((k) => defOf(k));
  const got = await Promise.all(keys.map((k) => linkTo(k).then((l) => [k, l], () => [k, null])));
  const out = [];
  for (const [key, l] of got) {
    if (!l) continue;
    for (const t of l.tools) {
      out.push({ ...t, name: `${key}${SEP}${t.name}`, description: `[${defOf(key).name}] ${t.description || ''}`.trim() });
    }
  }
  return out;
}

const textResult = (text, isError) => ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });

async function runTool(env, name, args) {
  const i = name.indexOf(SEP);
  const key = i > 0 ? name.slice(0, i) : '';
  if (!key || !(env.servers || []).includes(key) || !defOf(key)) return textResult(`There is no tool "${name}" among your Loop tools. Call loop_find_tools to see what is there.`, true);
  try {
    const l = await linkTo(key);
    return await l.ask('tools/call', { name: name.slice(i + SEP.length), arguments: args || {} });
  } catch (e) {
    return textResult(`${defOf(key).name} did not answer: ${plain(e)}`, true);
  }
}

async function handle(msg, dir) {
  const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
  const env = scopeOf(dir);
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
        const missing = (env.servers || []).filter((k) => defOf(k) && lastErr.has(k)).map((k) => `${defOf(k).name}: ${lastErr.get(k)}`);
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
    if (req.method === 'GET' && /^\/oauth\/callback\?/.test(req.url || '')) {
      return signedBack(new URL(req.url, 'http://127.0.0.1').searchParams).then((r) => {
        res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(backPage(r));
      });
    }
    // git in a session, asking for its GitHub sign-in.
    const g = /^\/git\/([a-f0-9]+)\/([A-Za-z0-9_-]+)$/.exec(req.url || '');
    if (g) {
      if (g[1] !== secret || req.method !== 'POST') return send(404);
      let asked = '';
      req.on('data', (c) => {
        asked += c;
        if (asked.length > 8000) req.destroy();
      });
      req.on('end', () =>
        gitAnswer(g[2], asked)
          .catch(() => '')
          .then((text) => {
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(text);
          }),
      );
      return undefined;
    }
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
  listenBack();
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve(port);
    });
  });
}

// The one address that does not change between starts, because the Loop Cloud
// website has to name it before it knows anything about this computer: a
// sign-in started there, for a service that sends people back only to their own
// computer, comes back here. If another program holds the port, nothing is
// lost: the browser shows the address and the person pastes it into the website.
const BACK_PORT = 47823;
function listenBack(at = BACK_PORT) {
  if (backServer) return;
  const srv = http.createServer((req, res) => {
    if (req.method !== 'GET' || !/^\/oauth\/callback\?/.test(req.url || '')) {
      res.writeHead(404);
      return res.end();
    }
    return signedBack(new URL(req.url, 'http://127.0.0.1').searchParams).then((r) => {
      res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(backPage(r));
    });
  });
  srv.on('error', () => {
    if (backServer === srv) backServer = null;
  });
  backServer = srv;
  srv.listen(at, '127.0.0.1');
}

// ---------- git, signed in through Loop Cloud ----------
// git in a session of a project that has a GitHub connection is signed in to
// GitHub through Loop, so clone, pull and push work on a machine that was
// never signed in to GitHub. The connection is signed in once, in Loop Cloud,
// and stays there. When git asks, this machine is handed its token of the
// hour, keeps it in memory for a few minutes, and never has the part that
// renews it. A token that sits on this machine is never used for this.
// Nothing is written to git's own settings: it lasts as long as the session,
// and only for github.com.

// The GitHub connections in Loop Cloud that a project's sessions have.
function gitFar(dir) {
  const env = scopeOf(dir);
  return env ? env.servers.filter((key) => doc.servers[key] && viaCloud(doc.servers[key]) && doc.servers[key].git === true) : [];
}
const farGit = new Map(); // tools + repo -> { text, until }: what Loop Cloud last handed over
const ghWho = new Map(); // connection -> { name, email } for commits

// What git asked ("protocol=https", "host=github.com", "path=owner/repo.git")
// and what it is told back, in git's own credential format. '' when it is not
// Loop's to answer.
async function gitAnswer(dir, asked) {
  const q = {};
  for (const line of String(asked).split(/\r?\n/)) {
    const at = line.indexOf('=');
    if (at > 0) q[line.slice(0, at)] = line.slice(at + 1);
  }
  if (q.protocol !== 'https' || String(q.host || '').toLowerCase() !== 'github.com') return '';
  const far = gitFar(dir);
  if (!far.length) return '';
  const repo = String(q.path || '')
    .replace(/^\/+/, '')
    .replace(/\.git$/, '')
    .split('/')
    .slice(0, 2)
    .join('/');
  const id = far.join(',') + ' ' + repo.toLowerCase();
  const have = farGit.get(id);
  if (have && Date.now() < have.until) return have.text;
  try {
    // With several connections, Loop Cloud gives the one that can see the repo.
    const j = await farCall('/api/git/credential', { host: 'github.com', repo, tools: far });
    if (!j.password) return '';
    const text = 'username=' + String(j.username || 'x-access-token') + '\npassword=' + String(j.password) + '\n';
    // One clone asks several times. Kept five minutes at most, and never past its own end.
    farGit.set(id, { text, until: Math.min(Date.now() + 5 * 60e3, (Number(j.expires) || 0) - 60e3) });
    return text;
  } catch (e) {
    lastErr.set(far[0], plain(e));
    onChange(state());
    return '';
  }
}

let gitHasName = null; // whether git on this machine already knows who commits
function gitKnowsName() {
  if (gitHasName !== null) return gitHasName;
  try {
    const out = require('child_process').execFileSync('git', ['config', '--global', 'user.email'], { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    gitHasName = Boolean(out.trim());
  } catch {
    gitHasName = false; // not set, or no git: nothing to keep
  }
  return gitHasName;
}

// What a session starts with so that its git signs in to GitHub through Loop.
// {} when its project has no GitHub connection that is signed in.
async function gitEnv(dir) {
  const far = /^[A-Za-z0-9_-]+$/.test(dir || '') && port ? gitFar(dir) : [];
  if (!far.length) return {};
  // git runs this through its own sh, on Windows too. Only "get" is answered:
  // Loop is never asked to store or forget a sign-in.
  const ask = '!f() { test "$1" = get && curl -s --max-time 25 --data-binary @- http://127.0.0.1:' + port + '/git/' + secret + '/' + dir + '; }; f';
  const out = {
    GIT_CONFIG_COUNT: '3',
    // An empty value first: no other helper, and no sign-in window, is tried for github.com.
    GIT_CONFIG_KEY_0: 'credential.https://github.com.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'credential.https://github.com.helper',
    GIT_CONFIG_VALUE_1: ask,
    // git says which repo it is for, so the right connection can be chosen.
    GIT_CONFIG_KEY_2: 'credential.https://github.com.useHttpPath',
    GIT_CONFIG_VALUE_2: 'true',
  };
  // A machine where git was never told who commits: the person behind the first connection.
  if (!gitKnowsName()) {
    if (!ghWho.has(far[0])) {
      const me = await farCall('/api/git/who', { tools: far }).catch(() => null);
      if (me && me.name && me.email) ghWho.set(far[0], { name: String(me.name), email: String(me.email) });
    }
    const who = ghWho.get(far[0]);
    if (who) Object.assign(out, { GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email });
  }
  return out;
}
// For tests: whether this machine's git has a name.
const gitTesting = (o) => {
  if ('knowsName' in o) gitHasName = o.knowsName;
  ghWho.clear();
  farGit.clear();
};

// The entry a session's tool file gets, or null when its project has no environment.
function entryFor(dir, sessionId) {
  const env = scopeOf(dir);
  if (!port || !env || !/^[A-Za-z0-9_-]+$/.test(dir || '') || !UUID_RE.test(sessionId || '')) return null;
  return { name: 'loop', only: env.only === true, env: env.name, server: { type: 'http', url: `http://127.0.0.1:${port}/hub/${secret}/${dir}/${sessionId}` } };
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
  for (const k of Object.keys(doc.local)) {
    if (!doc.servers[k]) continue;
    const moved = freeKey(`${k}-pc`, { ...doc.servers, ...doc.local });
    doc.local[moved] = doc.local[k];
    delete doc.local[k];
    doc.localOff = doc.localOff.map((x) => (x === k ? moved : x));
  }
  // A tool that is gone takes its files off this machine with it.
  const kept = path.join(path.dirname(FILE), 'mcp-files');
  try {
    for (const k of fs.readdirSync(kept)) if (!doc.servers[k]) fs.rmSync(path.join(kept, k), { recursive: true, force: true });
  } catch {
    // no files were ever placed
  }
  doc.at = Number(theirs.at) || Date.now();
  if (!doc.envs[doc.defaultEnv]) doc.defaultEnv = '';
  save(false);
  return true;
}

// A program named by the cloud runs on this PC only after someone here has
// said so: a stolen cloud sign-in must not be a way to run commands on it.
// Any change to the command or its keys asks again.
const print = (s) => crypto.createHash('sha256').update(JSON.stringify([s.command, s.args || [], Object.entries(s.env || {}).sort(), Object.entries(s.files || {}).sort()])).digest('hex');
// A tool that runs in Loop Cloud: nothing of it runs here, so it is on every
// machine and there is nothing to allow.
const viaCloud = (s) => s.kind === 'http' && s.viaCloud === true;
function inCloud(url) {
  try {
    return Boolean(cloudBase) && String(url).startsWith(`${cloudBase}/`) && new URL(url).origin === new URL(cloudBase).origin;
  } catch {
    return false;
  }
}
const elsewhere = (s) => !viaCloud(s) && Boolean(s.on && s.on !== doc.machine);
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
  cloudHeaders = opts.cloudHeaders || (() => ({}));
  cloudBase = String(opts.cloudBase || '').replace(/\/+$/, '');
  cloudRefresh = opts.cloudRefresh || (async () => {});
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
  if (backServer) backServer.close();
  server = null;
  backServer = null;
  port = 0;
}

module.exports = { gitEnv, gitTesting, signIn, signOut, saveLocal, removeLocal, setLocalOn, importLocal, scopeOf, fileFor, init, stop, state, saveServer, removeServer, saveEnv, removeEnv, setProjectEnv, setDefaultEnv, envOf, importClaude, fromClaude, test, entryFor, adopt, approve, trust, handle, words, pairs };
