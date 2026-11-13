// Loop's own window, in a browser anywhere: the same files the desktop app
// shows, with the `deck` bridge carried over the secure connection instead of
// Electron's IPC.
//
// The bridge the window uses is defined once, in preload.js. That file is read
// here with a stand-in for Electron, so each method's channel is known without
// keeping a second list: a call from the browser becomes exactly the IPC call
// the desktop window would make, answered by the same handlers, and events the
// handlers send back (terminal output, state changes) reach the browser too.
//
// What would act on this PC's own screen (file pickers, Explorer, window
// controls) is refused for a browser; links open in the browser instead.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const handlers = new Map(); // channel -> ipcMain.handle function
const listeners = new Map(); // channel -> ipcMain.on function
const clients = new Set(); // the browsers connected now, as stand-in senders
let api = null; // the bridge object, as preload.js builds it
let props = {}; // its values that are not functions
let renderer = '';
let nodeModules = '';
let seq = 0;
let onGone = () => {};

// Things a browser far away must not do to this PC.
const REFUSED = new Set([
  'win:close',
  'win:popout',
  'dialog:file',
  'dialog:folder',
  'mem:export',
  'mem:open',
  'mem:reveal',
  'shell:reveal',
  'shell:show',
  'shell:external',
  'cloud:site',
  'drop:server',
]);

// Remembers every handler as it is registered, before any is: call this first.
function capture(ipcMain) {
  const handle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (ch, fn) => {
    handlers.set(ch, fn);
    return handle(ch, fn);
  };
  const on = ipcMain.on.bind(ipcMain);
  ipcMain.on = (ch, fn) => {
    listeners.set(ch, fn);
    return on(ch, fn);
  };
}

function init(opts) {
  renderer = opts.renderer;
  if (opts.onGone) onGone = opts.onGone;
  nodeModules = opts.nodeModules;
  // preload.js, run against a stand-in that describes each call instead of making it.
  const ipc = {
    invoke: (ch, ...a) => ({ k: 'invoke', ch, a }),
    send: (ch, ...a) => ({ k: 'send', ch, a }),
    on: (ch) => ({ k: 'on', ch }),
  };
  const electron = {
    contextBridge: { exposeInMainWorld: (_n, a) => (api = a) },
    ipcRenderer: ipc,
    webUtils: { getPathForFile: () => '' },
  };
  const src = fs.readFileSync(opts.preload, 'utf8');
  new Function('require', 'process', src)((m) => (m === 'electron' ? electron : require(m)), process);
  props = {};
  for (const [k, v] of Object.entries(api || {})) if (typeof v !== 'function') props[k] = v;
}

// Every event the windows get, the browsers get too.
function broadcast(ch, ...args) {
  for (const s of clients) s.send(ch, ...args);
}

// A browser that showed a key this PC gave out: from now on it is a window.
function attach(ws) {
  const sender = Object.assign(new EventEmitter(), {
    id: 900000 + ++seq,
    loopRemote: true,
    closed: false,
    isDestroyed: () => sender.closed,
    send: (ch, ...args) => {
      if (sender.closed || ws.readyState !== 1) return;
      try {
        ws.send(JSON.stringify({ t: 'ev', ch, args }));
      } catch {
        // gone; the close below tidies up
      }
    },
  });
  clients.add(sender);
  const event = { sender, senderFrame: null, reply: (ch, ...args) => sender.send(ch, ...args) };
  ws.on('message', async (raw) => {
    let m;
    try {
      m = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!m || m.t !== 'call' || typeof m.name !== 'string') return;
    const reply = (o) => {
      try {
        ws.send(JSON.stringify({ t: 'ret', id: m.id, ...o }));
      } catch {
        // gone
      }
    };
    try {
      const fn = api && api[m.name];
      if (typeof fn !== 'function') return reply({ ok: false, error: 'No such call' });
      const d = fn(...(Array.isArray(m.args) ? m.args : []));
      if (!d || !d.k) return reply({ ok: true, value: d === undefined ? null : d });
      if (REFUSED.has(d.ch)) return reply({ ok: false, error: 'Not from a browser' });
      if (d.k === 'on') return reply({ ok: true, value: { sub: d.ch } });
      if (d.k === 'send') {
        const l = listeners.get(d.ch);
        if (l) l(event, ...d.a);
        return reply({ ok: true, value: null });
      }
      const h = handlers.get(d.ch);
      if (!h) return reply({ ok: false, error: `Nothing answers ${d.ch}` });
      const value = await h(event, ...d.a);
      reply({ ok: true, value: value === undefined ? null : value });
    } catch (e) {
      reply({ ok: false, error: e.message });
    }
  });
  const gone = () => {
    if (sender.closed) return;
    sender.closed = true;
    clients.delete(sender);
    try {
      onGone(sender);
    } catch {
      // nothing to hold
    }
    sender.emit('destroyed');
  };
  ws.on('close', gone);
  ws.on('error', gone);
  ws.send(JSON.stringify({ t: 'desk-ready' }));
  return true;
}

// ---- the window's own files ----

const TYPES = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json' };

function sendFile(res, file, type) {
  fs.readFile(file, (err, body) => {
    if (err) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'content-type': type || TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(body);
  });
}

// Inside one folder only, whatever the address asks for.
const inside = (base, rel) => {
  const f = path.join(base, path.normalize(rel).replace(/^([\\/]|\.\.)+/, ''));
  return f.startsWith(base + path.sep) ? f : '';
};

// The page, files, and the bridge client. Returns whether it answered.
function serve(req, res) {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (url === '/desk' ) {
    res.writeHead(302, { location: '/desk/' });
    res.end();
    return true;
  }
  if (url === '/desk/' || url === '/desk/index.html') {
    let page = fs.readFileSync(path.join(renderer, 'index.html'), 'utf8');
    // The desktop page's own policy is for Electron; the browser gets this one.
    page = page.replace(/<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/, '');
    page = page.split('../../node_modules/').join('/desk-nm/');
    page = page.replace('<script src="app.js"></script>', '<script src="/desk/remote-deck.js"></script>\n    <script src="app.js"></script>');
    res.writeHead(200, { 'content-type': TYPES['.html'], 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
    res.end(page);
    return true;
  }
  if (url === '/desk/remote-deck.js') {
    const client = fs.readFileSync(path.join(__dirname, 'remote-deck-client.js'), 'utf8');
    res.writeHead(200, { 'content-type': TYPES['.js'], 'cache-control': 'no-store' });
    res.end(`window.__deskProps = ${JSON.stringify(props)};\n${client}`);
    return true;
  }
  if (url.startsWith('/desk/')) {
    const f = inside(renderer, url.slice('/desk/'.length));
    if (!f) return false;
    sendFile(res, f);
    return true;
  }
  if (url.startsWith('/desk-nm/@xterm/')) {
    const f = inside(nodeModules, url.slice('/desk-nm/'.length));
    if (!f) return false;
    sendFile(res, f);
    return true;
  }
  return false;
}

module.exports = { capture, init, attach, broadcast, serve, count: () => clients.size };
