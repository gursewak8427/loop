// The phone bridge: how the Loop app on your phone reaches this PC.
//
// Everything the phone asks for is done by the Loop window, not here. This file
// is only the door: it listens on the Tailscale network, checks the pairing
// token, and passes messages between a phone and the window. That way the phone
// and the desktop act on exactly the same projects, sessions, teams and config,
// with one copy of the rules.
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const zlib = require('zlib');
const https = require('https');
const { execFile } = require('child_process');
const os = require('os');
const path = require('path');
const { WebSocketServer } = require('ws');
const transcript = require('./transcript');
const tasks = require('./tasks');

const PORT = 8787;
// A code you can read off the screen and type on a phone once. Behind Tailscale
// nothing else can reach the port, and a wrong code is answered slowly and dropped.
const CODE_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
const newCode = () =>
  [0, 1, 2]
    .map(() =>
      Array.from(crypto.randomBytes(4))
        .map((n) => CODE_CHARS[n % CODE_CHARS.length])
        .join(''),
    )
    .join('-');
const MAX_IMAGE = 12 * 1024 * 1024; // one screenshot, not a film
// One message on the socket: a chat attachment of up to 20 MB, as base64.
const MAX_WS = 30 * 1024 * 1024;

let server = null;
let wss = null;
let uploads = null;
let certDir = null;
let secure = null; // the https half
let secureWss = null;
let secureName = ''; // this machine's name on your tailnet
let securePort = 0;
let secureWhy = ''; // why there is no secure address, if there is none
let webRoot = null; // the built web app, served to a browser
let listening = 0; // the port in use, 0 when off
let lastError = '';
let token = '';
let clientSeq = 0;
let beat = null;
const clients = new Map(); // id -> { ws, paired, subscribed, at, ip }

// The last list of background tasks each phone was given. What one of them
// printed is asked for by its id, never by a path: the file is the one Claude
// Code itself named in the conversation, and nothing else can be read.
const taskLists = new Map(); // client id -> { server, list }

async function answerTasks(c, m) {
  const dir = String(m.dir || '');
  const sessionId = String(m.sessionId || '');
  const server = String(m.server || '');
  let list = [];
  try {
    const r = server ? await hooks.remoteRead(server, dir, sessionId, -1) : await transcript.readLocal(dir, sessionId, -1);
    list = tasks.readTasks((r && r.text) || '');
  } catch {
    list = [];
  }
  taskLists.set(c.id, { server, list });
  send(c, { t: 'done', id: m.id, ok: true, data: { sessionId, tasks: list } });
}

async function answerTaskOut(c, m) {
  const held = taskLists.get(c.id);
  const want = String(m.task || '');
  const t = held && held.list.find((x) => x.id === want);
  if (!t || !t.file) return send(c, { t: 'done', id: m.id, ok: false, text: 'That task is not in the list any more.' });
  const out = held.server ? await hooks.remoteTail(held.server, t.file) : await tasks.tailOf(t.file);
  send(c, { t: 'done', id: m.id, ok: true, data: { task: want, text: (out && out.text) || '', cut: Boolean(out && out.cut) } });
}

// Set by main: how to reach the window and how to answer the phone.
let hooks = {
  toWindow: () => false, // (channel, payload) -> was it sent
  onCount: () => {},
  remoteRead: async () => null, // (server, dir, sessionId, from) -> { size, text }
  remoteTail: async () => null, // (server, file) -> { text, cut } for one task's output
  toServer: async () => null, // (server, file, onProgress) -> the path it has there
  openTicket: async () => ({ ok: false, why: 'Remote access is off.' }), // (ticket) -> { ok, key, host }
  visitorOk: () => false, // (key) -> may this browser in
  deskServe: () => false, // (req, res) -> served Loop's window files
  deskAttach: () => false, // (ws) -> the connection now carries Loop's window
};

// Pictures arrive in pieces, each one answered, so the phone can show how far
// along it is. They start the moment one is chosen, not when the message goes.
const UP_PIECE = 64 * 1024; // base64 characters in one piece, at most
const ups = new Map(); // client id + upload id -> { name, parts, got, of, at }

const sameToken = (a, b) => {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
};

const send = (c, msg) => {
  try {
    if (c.ws.readyState === 1) c.ws.send(JSON.stringify(msg));
  } catch {
    // the phone went away mid-write; its close handler cleans up
  }
};

const paired = () => [...clients.values()].filter((c) => c.paired);

function broadcast(msg, onlySubscribed) {
  for (const c of paired()) if (!onlySubscribed || c.subscribed) send(c, msg);
}

// The address to put in front of the user: Tailscale first, then the LAN.
function addresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family !== 'IPv4' || i.internal) continue;
      const tail = i.address.startsWith('100.') && Number(i.address.split('.')[1]) >= 64 && Number(i.address.split('.')[1]) <= 127;
      out.push({ ip: i.address, tailscale: tail });
    }
  }
  out.sort((a, b) => Number(b.tailscale) - Number(a.tailscale));
  return out;
}

function state() {
  return {
    on: Boolean(listening),
    port: listening || PORT,
    // The name and port a page on the web can reach this PC by, if there is one.
    secure: secureName && securePort ? `${secureName}:${securePort}` : '',
    token,
    host: os.hostname(),
    addresses: addresses(),
    phones: paired().length,
    error: lastError,
  };
}

const tellMain = () => hooks.onCount(state());

// ---- what a phone may send ----

function handle(c, raw) {
  let m;
  try {
    m = JSON.parse(raw);
  } catch {
    return;
  }
  if (!m || typeof m.t !== 'string') return;
  // Loop's own window in a browser: the same key, then the connection is the window's.
  if (m.t === 'desk' && !c.paired && !c.desk) {
    if (!hooks.visitorOk(String(m.key || '').trim().toLowerCase())) {
      setTimeout(() => {
        send(c, { t: 'desk-denied' });
        c.ws.close();
      }, 1000);
      return;
    }
    c.desk = true;
    clients.delete(c.id);
    hooks.deskAttach(c.ws);
    return;
  }
  if (c.desk) return;
  if (m.t === 'hello') {
    const said = String(m.token || '').trim().toLowerCase();
    // The pairing code, or a key a browser got by opening this PC from Loop Cloud.
    if (!sameToken(said, token) && !hooks.visitorOk(said)) {
      setTimeout(() => {
        send(c, { t: 'denied', why: 'That pairing code is not the one Loop is showing. Check it on the PC.' });
        c.ws.close();
      }, 1000);
      return;
    }
    c.paired = true;
    send(c, { t: 'ready', host: os.hostname(), app: 'Loop', window: hooks.toWindow('phone:ping', {}) });
    tellMain();
    return;
  }
  if (!c.paired) return;
  if (m.t === 'bye') return c.ws.close();
  if (m.t === 'sub') c.subscribed = true;
  // The chat of one session comes straight from its conversation file; the
  // window is only told so it can pass on questions shown on that terminal.
  if (m.t === 'chat') {
    c.following = { dir: m.dir, sessionId: m.sessionId, server: m.server || '' };
    transcript.follow(c.id, c.following, (msg) => send(c, msg), hooks.remoteRead);
    return relay(c, { t: 'follow', sessionId: m.sessionId });
  }
  // One step's output or one picture, asked for when the phone opens it.
  if (m.t === 'kept') return send(c, { t: 'kept', id: m.id, ref: m.ref, data: transcript.fetchKept(c.id, m.ref) });
  // What a session has running in the background, read from its conversation
  // file: the same list the PC shows, and what one of them has printed so far.
  if (m.t === 'tasks') return answerTasks(c, m);
  if (m.t === 'taskout') return answerTaskOut(c, m);
  if (m.t === 'earlier') return transcript.earlier(c.id);
  if (m.t === 'unchat') {
    transcript.unfollow(c.id);
    return relay(c, { t: 'follow', sessionId: null });
  }
  // One piece of a picture on its way.
  if (m.t === 'up') {
    const up = String(m.up || '');
    const i = Number(m.i);
    const of = Number(m.of);
    const d = String(m.d || '');
    if (!/^[a-z0-9]{6,32}$/.test(up) || !(of > 0 && of <= Math.ceil((MAX_IMAGE * 1.4) / UP_PIECE)) || !(i >= 0 && i < of) || d.length > UP_PIECE) {
      return send(c, { t: 'upgot', up, i, failed: 'That picture could not be sent.' });
    }
    const key = `${c.id}:${up}`;
    let u = ups.get(key);
    if (!u) {
      for (const [k, v] of ups) if (Date.now() - v.at > 10 * 60 * 1000) ups.delete(k); // given up on
      u = { name: String(m.name || ''), parts: new Array(of), got: 0, of, at: Date.now() };
      ups.set(key, u);
    }
    if (u.parts[i] == null) u.got += 1;
    u.parts[i] = d;
    u.at = Date.now();
    if (u.got < u.of) return send(c, { t: 'upgot', up, i });
    ups.delete(key);
    const file = saveImage({ name: u.name, b64: u.parts.join('') });
    if (!file) return send(c, { t: 'upgot', up, i, failed: 'The picture could not be saved on the PC.' });
    const token = path.basename(file);
    // A server session needs it on the server: that copy starts now as well.
    if (m.server) {
      send(c, { t: 'upgot', up, i, token, far: true });
      let last = 0;
      hooks
        .toServer(String(m.server), file, (p) => {
          if (p - last < 0.05 && p < 1) return;
          last = p;
          send(c, { t: 'upfar', up, p });
        })
        .then((there) => send(c, { t: 'upfar', up, p: 1, done: true, failed: there ? undefined : 'The picture could not be copied to the server.' }));
      return;
    }
    return send(c, { t: 'upgot', up, i, token });
  }
  // A message with pictures: the pictures become files here first.
  if (m.t === 'send') {
    const paths = [];
    // Pictures sent ahead, named by the token each one was given.
    for (const token of (Array.isArray(m.uploads) ? m.uploads : []).slice(0, 6)) {
      const name = path.basename(String(token));
      const file = path.join(uploads, name);
      if (!/^phone-[\w-]+\.(png|jpe?g|gif|webp|bmp)$/i.test(name) || !fs.existsSync(file)) {
        return send(c, { t: 'done', id: m.id, ok: false, text: 'A picture was lost on the way. Add it again.' });
      }
      paths.push(file);
    }
    for (const img of (Array.isArray(m.images) ? m.images : []).slice(0, 6)) {
      const file = saveImage(img);
      if (!file) return send(c, { t: 'done', id: m.id, ok: false, text: 'A picture could not be saved on the PC.' });
      paths.push(file);
    }
    return relay(c, { t: 'send', id: m.id, dir: m.dir, sessionId: m.sessionId, text: String(m.text || '').slice(0, 20000), paths });
  }
  // An image arrives as base64 and becomes a file on this PC; the window then
  // types its path into the session, which is how Claude Code takes a picture.
  if (m.t === 'image') {
    const file = saveImage(m);
    if (!file) return send(c, { t: 'done', id: m.id, ok: false, text: 'That image could not be saved on the PC.' });
    return relay(c, { t: 'image', id: m.id, tabId: m.tabId, path: file, name: m.name || '' });
  }
  relay(c, m);
}

// Loop's window takes a moment to start listening, and a phone that connects
// in that moment would otherwise be answered by nobody at all. What arrives
// first is held and handed over as soon as the window is there.
let wired = false;
let held = [];
let heldTimer = null;

function relay(c, m) {
  if (!wired) {
    if (held.length < 100) held.push({ c, m });
    if (!heldTimer) heldTimer = setTimeout(giveUpHeld, 25000);
    return;
  }
  const sent = hooks.toWindow('phone:do', { ...m, c: c.id });
  if (!sent && m.id) send(c, { t: 'done', id: m.id, ok: false, text: 'Loop is not open on the PC, so nothing was changed.' });
  if (!sent && m.t === 'sub') send(c, { t: 'state', closed: true });
}

// The window says when it is listening; everything held then goes at once.
function windowWired() {
  clearTimeout(heldTimer);
  heldTimer = null;
  wired = true;
  const waiting = held;
  held = [];
  for (const h of waiting) if (clients.has(h.c.id)) relay(h.c, h.m);
}

function giveUpHeld() {
  heldTimer = null;
  const waiting = held;
  held = [];
  for (const { c, m } of waiting) {
    if (m.id) send(c, { t: 'done', id: m.id, ok: false, text: 'Loop is not open on the PC, so nothing was changed.' });
    if (m.t === 'sub') send(c, { t: 'state', closed: true });
  }
}

function saveImage(m) {
  try {
    const b64 = String(m.b64 || '');
    if (!b64 || b64.length > MAX_IMAGE * 1.4) return null;
    const buf = Buffer.from(b64, 'base64');
    if (!buf.length || buf.length > MAX_IMAGE) return null;
    const ext = (/\.(png|jpe?g|gif|webp|bmp)$/i.exec(String(m.name || '')) || [, 'png'])[1].toLowerCase();
    fs.mkdirSync(uploads, { recursive: true });
    const file = path.join(uploads, `phone-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}.${ext}`);
    fs.writeFileSync(file, buf);
    purgeUploads();
    return file;
  } catch {
    return null;
  }
}

// Pictures and files sent from the chat or a phone are kept two weeks: the
// session reads them at once, and the chat shows them again when scrolled back.
function purgeUploads() {
  const cut = Date.now() - 14 * 24 * 60 * 60 * 1000;
  for (const name of fs.readdirSync(uploads)) {
    const p = path.join(uploads, name);
    try {
      if (fs.statSync(p).mtimeMs < cut) fs.unlinkSync(p);
    } catch {
      // in use or already gone
    }
  }
}

// An answer being written, sent to every phone; each one shows it only if that
// is the chat it has open.
// /clear moved a session to a new conversation: every phone reading the old
// one reads the new one from now on, and is told so it can follow the id.
function moved(from, to) {
  for (const c of paired()) {
    if (!c.following || c.following.sessionId !== from) continue;
    c.following = { ...c.following, sessionId: to };
    transcript.follow(c.id, c.following, (msg) => send(c, msg), hooks.remoteRead);
    send(c, { t: 'moved', from, to });
  }
}

function draft(sessionId, text, done) {
  if (!clients.size) return;
  broadcast({ t: 'draft', sessionId, d: text, done: Boolean(done) }, true);
}

// ---- answers coming back from the window ----

// The window answers one phone (m.c) or, with no c, everyone watching.
function fromWindow(m) {
  if (!m || typeof m.t !== 'string') return;
  if (m.t === 'wired') return windowWired();
  if (m.c == null) return broadcast(m, m.t === 'state');
  const c = clients.get(m.c);
  if (c && c.paired) send(c, m);
}

// The app as a web page, for a phone with only a browser. It is the same app;
// what a browser cannot do is tell you about a session while the page is closed.
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.bin': 'application/octet-stream',
  '.map': 'application/json; charset=utf-8',
};

const RETIRE_WORKER = `
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) await caches.delete(k);
    await self.registration.unregister();
    for (const c of await self.clients.matchAll({ type: 'window' })) c.navigate(c.url);
  })());
});
`;

// Squeezed once per file, not once per phone.
const squeezed = new Map();
function packed(file, tag, body) {
  const key = file + tag;
  let out = squeezed.get(key);
  if (!out) {
    out = zlib.gzipSync(body, { level: 6 });
    if (squeezed.size > 40) squeezed.clear(); // a new build replaces the old
    squeezed.set(key, out);
  }
  return out;
}

function serveApp(req, res) {
  if (!webRoot || !fs.existsSync(webRoot)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('Loop is running, but the web app was not built into it.');
  }
  const asked = decodeURIComponent((req.url || '/').split('?')[0]);
  // A browser that opened an early version still runs its offline cache, which
  // keeps handing out that old app. This takes its place at once, empties the
  // cache, removes itself and reloads the page onto the current app.
  if (asked === '/flutter_service_worker.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(RETIRE_WORKER);
  }
  // Everything is served from inside one folder, whatever the address asks for.
  const file = path.join(webRoot, path.normalize(asked).replace(/^([\\/]|\.\.)+/, ''));
  const target = !file.startsWith(webRoot) || !fs.existsSync(file) || fs.statSync(file).isDirectory() ? path.join(webRoot, 'index.html') : file;
  // Kept in the browser's store, but checked every time: a new build of the app
  // shows up at once, and an unchanged one costs a few bytes rather than megabytes.
  let tag = '';
  try {
    const st = fs.statSync(target);
    tag = `"${st.size}-${Math.round(st.mtimeMs)}"`;
  } catch {
    // read below will report it
  }
  if (tag && req.headers['if-none-match'] === tag) {
    res.writeHead(304, { etag: tag, 'cache-control': 'no-cache' });
    return res.end();
  }
  fs.readFile(target, (err, body) => {
    if (err) {
      res.writeHead(500).end();
      return;
    }
    const type = TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream';
    // The app is a few megabytes of text and the phone may be far away on a
    // slow link: squeezing it costs a moment here and saves most of the wait.
    const wants = String(req.headers['accept-encoding'] || '');
    const squeeze = /text|javascript|json|wasm|svg/.test(type) && wants.includes('gzip') && body.length > 1024;
    const out = squeeze ? packed(target, tag, body) : body;
    res.writeHead(200, {
      'content-type': type,
      'cache-control': 'no-cache',
      ...(tag ? { etag: tag } : {}),
      ...(squeeze ? { 'content-encoding': 'gzip', vary: 'accept-encoding' } : {}),
    });
    res.end(out);
  });
}

// ---- a secure address, so a page on the web can reach this PC ----
//
// Tailscale issues a real certificate for this machine's own name on your
// tailnet. With it the bridge also answers on https, which is what a page
// served from somewhere else needs: a browser will not open a plain
// connection from a secure page. Nothing is exposed to the internet; the name
// only resolves inside your tailnet.

const TAILSCALE = [
  path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe'),
  '/usr/bin/tailscale',
  '/usr/local/bin/tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  'tailscale',
];

function tailscaleAt() {
  for (const t of TAILSCALE) if (t === 'tailscale' || fs.existsSync(t)) return t;
  return null;
}

const run = (exe, args, limit = 90000) =>
  new Promise((res) => {
    try {
      execFile(exe, args, { timeout: limit, windowsHide: true }, (err, out) => res(err ? null : String(out)));
    } catch {
      res(null);
    }
  });

// This machine's name on your tailnet, such as desktop-abc.tailxxxx.ts.net.
async function tailnetName(exe) {
  const out = await run(exe, ['status', '--json'], 20000);
  if (!out) return null;
  try {
    const name = JSON.parse(out).Self.DNSName || '';
    return name.replace(/\.$/, '') || null;
  } catch {
    return null;
  }
}

// Ask for the certificate, keeping the one we have until it is nearly out.
async function certFor(name, dir) {
  const crt = path.join(dir, 'tailnet.crt');
  const key = path.join(dir, 'tailnet.key');
  const fresh = () => {
    try {
      const { mtimeMs } = fs.statSync(crt);
      return fs.existsSync(key) && Date.now() - mtimeMs < 20 * 24 * 60 * 60 * 1000;
    } catch {
      return false;
    }
  };
  if (fresh()) return { crt, key };
  const exe = tailscaleAt();
  if (!exe) return null;
  fs.mkdirSync(dir, { recursive: true });
  const ok = await run(exe, ['cert', '--cert-file', crt, '--key-file', key, name]);
  return ok !== null && fs.existsSync(crt) && fs.existsSync(key) ? { crt, key } : null;
}

// The https half, on the port above the plain one. It fails quietly: a PC
// without Tailscale, or with it turned off, simply has no secure address.
async function startSecure(plainPort) {
  secureWhy = '';
  const exe = tailscaleAt();
  if (!exe || !certDir) return (secureWhy = 'Tailscale is not installed here.');
  const name = await tailnetName(exe);
  if (!name) return (secureWhy = 'Tailscale is not running, or not signed in.');
  const where = await certFor(name, certDir);
  if (!where) return (secureWhy = `Tailscale would not give a certificate for ${name}.`);
  const want = plainPort + 1;
  try {
    const opts = { cert: fs.readFileSync(where.crt), key: fs.readFileSync(where.key) };
    const s = https.createServer(opts, (req, res) => answer(req, res));
    const w = new WebSocketServer({ server: s, path: '/ws', maxPayload: MAX_WS, perMessageDeflate: { threshold: 256, zlibDeflateOptions: { level: 4, memLevel: 7 }, concurrencyLimit: 4 } });
    w.on('connection', welcome);
    s.on('error', (e) => {
      secureWhy = e.code === 'EADDRINUSE' ? `Port ${want} is already in use.` : e.message;
      secureName = '';
      securePort = 0;
      tellMain();
    });
    s.listen(want, '0.0.0.0', () => {
      secure = s;
      secureWss = w;
      secureName = name;
      securePort = want;
      tellMain();
    });
  } catch (e) {
    secureWhy = e.message; // the plain address still works
  }
}

// ---- the server itself ----

// A phone that has just connected, on either address.
function welcome(ws, req) {
  const c = { id: ++clientSeq, ws, paired: false, subscribed: false, at: Date.now(), ip: (req.socket.remoteAddress || '').replace(/^::ffff:/, '') };
  clients.set(c.id, c);
  // A connection that never pairs is dropped, so a stray scanner cannot sit there.
  const bounce = setTimeout(() => !c.paired && !c.desk && ws.close(), 10000);
  ws.on('message', (data) => handle(c, data));
  c.alive = true;
  ws.on('pong', () => (c.alive = true));
  ws.on('close', () => {
    clearTimeout(bounce);
    clients.delete(c.id);
    taskLists.delete(c.id);
    transcript.unfollow(c.id);
    hooks.toWindow('phone:do', { t: 'gone', c: c.id });
    tellMain();
  });
  ws.on('error', () => ws.close());
}

// What every request gets, plain or secure.
function answer(req, res) {
  // A page served from the web (loop.prismaple.com) reaching a PC on your own
  // network is a "private network request": the browser asks permission first,
  // and without this answer it simply waits and gives up.
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': req.headers.origin || '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': req.headers['access-control-request-headers'] || '*',
      'access-control-allow-private-network': 'true',
      'access-control-max-age': '86400',
    });
    return res.end();
  }
  // Opened from Loop Cloud: a one-time ticket, checked with the cloud, swapped
  // for this browser's own key, and on into the app already paired.
  const route = (req.url || '').split('?')[0];
  if (hooks.deskServe(req, res)) return;
  if (route === '/loop-remote/ping') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ app: 'Loop', host: os.hostname() }));
  }
  if (route === '/loop-remote/open') {
    const ticket = new URLSearchParams((req.url || '').split('?')[1] || '').get('ticket') || '';
    hooks
      .openTicket(ticket)
      .then((r) => {
        if (!r.ok) {
          res.writeHead(403, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          return res.end(`<!doctype html><meta name="viewport" content="width=device-width"><body style="font:15px system-ui;background:#0e161d;color:#dce5ec;display:grid;place-items:center;height:100vh;margin:0"><div style="max-width:340px;padding:24px"><b>This PC did not open</b><p style="color:#93a6b5">${String(r.why || '').replace(/[<&>]/g, '')}</p><a style="color:#7cc4f0" href="https://loop.prismaple.com/cloud#/machines">Back to your machines</a></div>`);
        }
        // The key travels after the #, so it never reaches a server log.
        // Into Loop's own window; the key travels after the #, so no server log sees it.
        res.writeHead(302, { location: `/desk/#k=${r.key}`, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
        res.end();
      })
      .catch(() => {
        res.writeHead(500);
        res.end();
      });
    return;
  }
  // Enough for the app to check it has the right address before pairing, and
  // for a page served elsewhere to ask this PC from a browser.
  if ((req.url || '').split('?')[0] === '/ping') {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    return res.end(JSON.stringify({ app: 'Loop', host: os.hostname(), secure: secureName ? `${secureName}:${securePort}` : '', why: secureWhy }));
  }
  serveApp(req, res);
}

function start(port) {
  stop();
  lastError = '';
  const want = Number(port) || PORT;
  server = http.createServer(answer);
  wss = new WebSocketServer({
    server,
    path: '/ws',
    maxPayload: MAX_WS,
    // Everything here is text, and a phone may be on a slow link far away.
    perMessageDeflate: { threshold: 256, zlibDeflateOptions: { level: 4, memLevel: 7 }, concurrencyLimit: 4 },
  });
  wss.on('connection', welcome);
  server.on('error', (e) => {
    lastError = e.code === 'EADDRINUSE' ? `Port ${want} is already in use. Choose another one.` : e.message;
    listening = 0;
    tellMain();
  });
  server.listen(want, '0.0.0.0', () => {
    listening = want;
    tellMain();
  });
  startSecure(want);
  // A phone that lost its network never closes its side: find out within 30s.
  clearInterval(beat);
  beat = setInterval(() => {
    for (const c of clients.values()) {
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      try {
        c.ws.ping();
      } catch {
        // closing
      }
    }
  }, 15000);
}

function stop() {
  for (const c of clients.values()) {
    try {
      c.ws.close();
    } catch {
      // already closing
    }
  }
  clients.clear();
  if (wss) wss.close();
  if (server) server.close();
  if (secureWss) secureWss.close();
  if (secure) secure.close();
  wss = null;
  server = null;
  secureWss = null;
  secure = null;
  secureName = '';
  securePort = 0;
  listening = 0;
}

// config.phone, filled in on first use: the switch, the port and the pairing token.
function sync(phone) {
  const want = { on: false, port: PORT, ...(phone || {}) };
  if (!want.token || String(want.token).length < 12) want.token = newCode();
  token = String(want.token);
  const port = Number(want.port) || PORT;
  if (want.on && listening !== port) start(port);
  else if (!want.on && listening) stop();
  return want;
}

function init(userData) {
  webRoot = path.join(__dirname, '..', 'web');
  certDir = path.join(userData, 'cert');
  uploads = path.join(userData, 'phone-uploads');
  transcript.setUploadDir(uploads);
  try {
    fs.mkdirSync(uploads, { recursive: true });
    purgeUploads();
  } catch {
    // made again on the first upload
  }
}

module.exports = {
  draft,
  moved,
  init,
  sync,
  stop,
  state,
  fromWindow,
  setHooks: (h) => Object.assign(hooks, h),
  newToken: newCode,
  uploadDir: () => uploads,
  PORT,
};
