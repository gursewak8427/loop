const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Menu, Tray, nativeImage, safeStorage, powerSaveBlocker } = require('electron');
// Loop's window in a browser answers through the same handlers: they are noted
// as they are registered, so this comes before any of them.
const remoteDesk = require('./remote-desk');
remoteDesk.capture(ipcMain);
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scanProjects, readLive, isClaudePid, peek, resolveProjectPath: scannerResolvePath, CLAUDE_DIR: CLAUDE_DIR_FOR_TOKENS } = require('./scanner');
const scannerResolve = (dir) => scannerResolvePath(dir, []);

// The git remote of a project folder, read from its own config.
function gitRemoteOf(projPath) {
  try {
    const t = fs.readFileSync(path.join(String(projPath || ''), '.git', 'config'), 'utf8');
    const origin = /\[remote "origin"\]([^[]*)/.exec(t);
    const u = /\burl\s*=\s*(\S+)/.exec((origin && origin[1]) || t);
    return u ? u[1] : '';
  } catch {
    return '';
  }
}
const trash = require('./trash');
const ptys = require('./ptys');
const memory = require('./memory');
const subs = require('./subs');
const accounts = require('./accounts');
const llms = require('./llms');
const agents = require('./agents');
const memoryImport = require('./memory-import');
const stats = require('./stats');
const remote = require('./remote');
const servers = require('./servers');
const transcript = require('./transcript');
const voice = require('./voice');
const bgTasks = require('./tasks');
const phone = require('./phone');
const direct = require('./direct');
const relay = require('./relay');
const localTools = require('./localtools');
const whatsapp = require('./whatsapp');
const switches = require('./switches');
const cloud = require('./cloud');
const limits = require('./limits');
const internet = require('./internet');
const chat = require('./chat');
const shellOf = require('./shell');
const updater = require('./updater');
const hub = require('./hub');

if (process.env.SD_USERDATA) app.setPath('userData', process.env.SD_USERDATA);

// Opened from the Dock or a desktop menu, the app has a bare PATH and would not
// find claude. Started from a terminal, it already has the user's own.
if (app.isPackaged && !shellOf.isWin()) {
  const loginPath = shellOf.loginPath();
  if (loginPath) process.env.PATH = loginPath;
}

// The app used to be called Session Deck. Carry its settings, memory and accounts
// over to the new name the first time, before anything opens them.
if (!process.env.SD_USERDATA) {
  try {
    const now = app.getPath('userData');
    const before = path.join(path.dirname(now), 'Session Deck');
    if (fs.existsSync(path.join(before, 'config.json')) && !fs.existsSync(path.join(now, 'config.json'))) {
      // Only ever take the place of a folder that is missing or empty; anything else is not ours to touch.
      if (fs.existsSync(now)) fs.rmdirSync(now);
      fs.renameSync(before, now);
    }
  } catch (e) {
    console.error('Could not carry the old settings over:', e.message);
  }
}

const CONFIG_FILE = () => path.join(app.getPath('userData'), 'config.json');

// Terminals are drawn on the graphics card. On a laptop with two, ask for the
// fast one; this has to be decided before the app is ready.
try {
  const early = JSON.parse(fs.readFileSync(CONFIG_FILE(), 'utf8'));
  if (!early.settings || early.settings.fastGpu !== false) app.commandLine.appendSwitch('force_high_performance_gpu');
} catch {
  app.commandLine.appendSwitch('force_high_performance_gpu');
}
const WS_COLORS = ['#7cc4f0', '#f0b24a', '#57c98a', '#b79cf2', '#ee7b6c', '#5fd0c5', '#e58fc0'];
const DEFAULT_SETTINGS = {
  claudeCmd: 'claude',
  flags: '--dangerously-skip-permissions',
  fontSize: 13,
  memoryEnabled: true,
  memoryDir: '',
  notify: true,
  restoreOnStart: false,
  fastGpu: true,
};

let win = null;
let config = null;
let saveTimer = null;
let lastLive = '';
let liveNow = [];
let memoryWarning = null;
let tray = null;
let quitting = false;

// Settings that belong to one window; an extra window never overwrites the main window's.
const WINDOW_KEYS = ['lastOpen', 'layout', 'activeWorkspace', 'collapsed', 'sidebarHidden'];
const pendingAdopt = new Map(); // webContents id -> terminals a new window starts with
const waiting = new Map(); // request id -> resolve, for questions put to a window
let askSeq = 0;

const everyWindow = () => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
// Tools and environments are set up on the Loop Cloud website. This PC reads
// them every half minute, and at once when Refresh is pressed.
let hubBusy = null;
let hubNote = ''; // why the last read did not work, for the window
function hubRefresh() {
  if (hubBusy) return hubBusy;
  hubBusy = (async () => {
    if (!cloud.state().signedIn) {
      hubNote = '';
      return { ok: false, error: 'Sign in to Loop Cloud first.' };
    }
    try {
      const far = await cloud.hubGet();
      const changed = hub.adopt(far.doc || { at: 0, servers: {}, envs: {} }, far.machine);
      hubNote = '';
      return { ok: true, changed };
    } catch (e) {
      hubNote = e.message;
      return { ok: false, error: e.message };
    } finally {
      hubBusy = null;
    }
  })();
  return hubBusy;
}
const hubView = () => ({ ...hub.state(), signedIn: cloud.state().signedIn, email: cloud.state().email || '', note: hubNote });

const sendAll = (channel, ...args) => {
  everyWindow().forEach((w) => w.webContents.send(channel, ...args));
  remoteDesk.broadcast(channel, ...args); // and Loop open in a browser elsewhere
};

// Ask a window something and wait for its answer (null if it does not answer in time).
function ask(wc, channel, ...args) {
  return new Promise((resolve) => {
    const id = ++askSeq;
    const timer = setTimeout(() => {
      waiting.delete(id);
      resolve(null);
    }, 5000);
    waiting.set(id, (data) => {
      clearTimeout(timer);
      waiting.delete(id);
      resolve(data);
    });
    wc.send(channel, id, ...args);
  });
}

// Nothing opens inside the app: a web link goes to your browser, anything else is refused.
function openOutside({ url }) {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  return { action: 'deny' };
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// Hide to the notification area so running sessions keep working.
function toTray() {
  if (!tray) {
    tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
    tray.on('click', showWindow);
  }
  const n = ptys.count();
  tray.setToolTip(`Loop: ${n} terminal${n === 1 ? '' : 's'} running`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show Loop', click: showWindow },
      { type: 'separator' },
      {
        label: 'Stop all sessions and quit',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  win.hide();
}
const ICON = path.join(__dirname, '..', '..', 'assets', 'icon.png');

// Claude Code's fullscreen view (the input box fixed at the bottom) switches itself
// off for the whole PC when a session dies while starting, and closing a tab or
// this app early is exactly that. Asking for it through the environment keeps
// it on here whenever your Claude settings choose it, and keeps sessions closed
// here from counting against it.
function viewEnv() {
  try {
    const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    return JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).tui === 'fullscreen' ? { CLAUDE_CODE_NO_FLICKER: '1' } : {};
  } catch {
    return {};
  }
}

function loadConfig() {
  let c = {};
  try {
    c = JSON.parse(fs.readFileSync(CONFIG_FILE(), 'utf8'));
  } catch {
    // first run
  }
  return {
    workspaces: null,
    projectWorkspace: {},
    hiddenProjects: [],
    hiddenSessions: [],
    pinnedSessions: [],
    projectAlias: {},
    sessionAlias: {},
    sessionRole: {},
    projectTeam: {},
    // sessionId -> { parent, task, returns, branch, worktree, repo, status, result }
    subSessions: {},
    // sessionId -> what that session wants back from its sub-sessions
    sessionReturns: {},
    roles: [],
    sidebarHidden: false,
    collapsed: {},
    lastOpen: [],
    teams: [],
    accounts: [],
    mainAccount: { name: 'Main', color: WS_COLORS[0] },
    defaultAccount: 'default',
    projectAccount: {},
    sessionAccount: {},
    // session, or project folder -> a model that is not Claude; see llms.js
    sessionLlm: {},
    sessionModel: {}, // session id -> the model it runs on ('' is the account's default)
    projectLlm: {},
    // Loop's own id -> a session of another agent (Codex, Grok ...); see agents.js
    agentSessions: {},
    // logins added for an agent beside its main one: [{ id, agent, name, color }]
    agentAccounts: [],
    // agent -> the account its new sessions use
    agentDefault: {},
    // set once the agents' own memories were brought into Loop's (or the user
    // chose to start fresh); from then on, each agent's own memory is off in Loop
    memoryMoved: 0,
    sessionRemote: {},
    servers: [],
    phone: { on: false, port: phone.PORT, token: '' },
    savedPrompts: [],
    activeWorkspace: 'all',
    layout: 'focus',
    window: null,
    ...c,
    settings: { ...DEFAULT_SETTINGS, ...(c.settings || {}) },
  };
}

function writeConfig() {
  saveTimer = null;
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE()), { recursive: true });
    const tmp = CONFIG_FILE() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
    fs.renameSync(tmp, CONFIG_FILE());
  } catch (e) {
    console.error('Could not save config:', e.message);
  }
}

function saveConfigSoon() {
  if (!saveTimer) saveTimer = setTimeout(writeConfig, 400);
}

// First run: one workspace per top-level folder that holds projects
// (D:\Freelance, D:\Businesses, D:\Jobs ...). Everything is editable later.
function seedWorkspaces(projects) {
  const home = os.homedir().toLowerCase();
  const roots = new Map();
  for (const p of projects) {
    if (!p.path || p.path.toLowerCase().startsWith(home)) continue;
    const parts = p.path.split(path.sep).filter(Boolean);
    if (parts.length < 2) continue;
    const root = path.join(parts[0] + path.sep, parts[1]);
    if (!roots.has(root.toLowerCase())) roots.set(root.toLowerCase(), { root, latest: 0 });
    const r = roots.get(root.toLowerCase());
    r.latest = Math.max(r.latest, p.mtime);
  }
  return [...roots.values()]
    .sort((a, b) => b.latest - a.latest)
    .map((r, i) => ({
      id: 'ws' + (i + 1),
      name: path.basename(r.root),
      color: WS_COLORS[i % WS_COLORS.length],
      roots: [r.root],
    }));
}

async function pollLive() {
  const live = [...(await readLive()), ...servers.live()];
  // A session Loop runs in the background: its runner knows the moment a turn
  // ends, ahead of the status file.
  // A runner just started may not be in the status files yet; it is running all the same.
  for (const id of direct.list()) if (!live.some((l) => l.sessionId === id)) live.push({ sessionId: id, status: direct.turn(id) || 'idle' });
  // Which of them Loop is running itself. A session working in the background
  // for a phone, or because a teammate handed it something, is not "somewhere
  // else": it belongs to this window and can be opened here at any moment.
  const mine = new Set([...direct.list(), ...ptys.held().map((t) => t.sessionId)]);
  for (const l of live) {
    if (mine.has(l.sessionId)) l.bg = true;
    const t = direct.turn(l.sessionId);
    if (t) l.status = t;
    const words = direct.doing(l.sessionId);
    if (words) l.doing = words;
  }
  liveNow = live;
  const s = JSON.stringify(live);
  if (s !== lastLive) {
    lastLive = s;
    sendAll('live', live);
  }
  return live;
}

let teamAsk = 0;
const farCopies = new Map(); // "server|file" -> the copy's promise of its path there
const teamWaits = new Map(); // request id -> the reply for the session that asked
const waWaits = new Map(); // request id -> whether the window delivered a WhatsApp message

// The phone bridge keeps its token and port in the config the window owns, so it
// is set up again whenever that config changes.
function syncPhone() {
  // Phone pairing is switched off; the bridge still runs when this machine is
  // accessible on the internet, which opens it only through Loop Cloud.
  if (!switches.phone) {
    relay.stop();
    const want = phone.sync({ ...config.phone, on: internet.isOn() });
    if (want.token !== (config.phone || {}).token) {
      config.phone = { ...config.phone, token: want.token };
      saveConfigSoon();
    }
    return;
  }
  const want = phone.sync(config.phone);
  if (JSON.stringify(want) !== JSON.stringify(config.phone)) {
    config.phone = want;
    saveConfigSoon();
  }
  syncRelay(phone.state());
}

// The relay can only dial out once the bridge is up, which happens a moment
// after it is asked to: this runs again every time the bridge reports itself.
function syncRelay(s) {
  relay.setDirect(s.secure || ''); // the short way, when this PC has one
  if (s.on) relay.sync(s.port);
  else relay.stop();
  sendAll('phone', { ...s, relay: relay.state() });
}

function createWindow() {
  const b = config.window || {};
  win = new BrowserWindow({
    width: b.width || 1480,
    height: b.height || 900,
    x: b.x,
    y: b.y,
    minWidth: 940,
    minHeight: 560,
    show: false,
    backgroundColor: '#141e27',
    title: 'Loop',
    icon: fs.existsSync(ICON) ? ICON : undefined,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#141e27', symbolColor: '#93a6b5', height: 40 },
    trafficLightPosition: { x: 14, y: 13 }, // macOS: the window buttons, centred in the title bar
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false, // terminals keep up while the window is hidden in the tray
    },
  });
  if (b.maximized) win.maximize();
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.on('focus', () => win.flashFrame(false));

  win.webContents.setWindowOpenHandler(openOutside);
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
  });

  win.on('close', (e) => {
    const n = ptys.count();
    if (n > 0 && !quitting && !process.env.SD_SMOKE) {
      const choice = dialog.showMessageBoxSync(win, {
        type: 'question',
        buttons: ['Keep them running', 'Stop them and close', 'Cancel'],
        defaultId: 0,
        cancelId: 2,
        message: `${n} terminal${n === 1 ? ' is' : 's are'} still open`,
        detail:
          'Keep them running hides Loop in the notification area by the clock; sessions carry on working and you can bring the window back from its icon there.\n\nStopping them is safe for the conversations: they are saved and can be reopened, but any step in progress is lost.',
      });
      if (choice !== 1) {
        e.preventDefault();
        if (choice === 0) toTray();
        return;
      }
    }
    const max = win.isMaximized();
    config.window = { ...(max ? config.window : win.getBounds()), maximized: max };
    if (saveTimer) clearTimeout(saveTimer);
    writeConfig();
    quitting = true;
    for (const w of everyWindow()) if (w !== win) w.destroy();
    ptys.killAll();
  });
}

// An extra window for terminals moved out of another one. It has no project
// list; closing it sends its terminals back to the main window, still running.
function createChild(specs, x, y) {
  const child = new BrowserWindow({
    width: 1040,
    height: 700,
    x: Math.round(x - 160),
    y: Math.round(y - 18),
    minWidth: 520,
    minHeight: 320,
    show: false,
    backgroundColor: '#141e27',
    title: 'Loop',
    icon: fs.existsSync(ICON) ? ICON : undefined,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#141e27', symbolColor: '#93a6b5', height: 36 }, // the height of a tab strip, which is all the chrome it has
    trafficLightPosition: { x: 12, y: 11 },
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, spellcheck: false, backgroundThrottling: false },
  });
  const wc = child.webContents;
  pendingAdopt.set(wc.id, specs);
  child.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  child.once('ready-to-show', () => child.show());
  wc.setWindowOpenHandler(openOutside);
  wc.on('will-navigate', (e) => e.preventDefault());
  wc.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') wc.toggleDevTools();
  });
  let handedBack = false;
  child.on('close', (e) => {
    if (handedBack || quitting || !win || win.isDestroyed() || !ptys.ownedBy(wc).length) return;
    e.preventDefault();
    handedBack = true;
    ask(wc, 'tabs:surrender').then((list) => {
      const back = (list || []).filter((s) => ptys.owner(s.id) === wc);
      for (const s of back) ptys.hold(s.id);
      for (const id of ptys.ownedBy(wc)) ptys.kill(id); // anything it could not hand over
      if (back.length) {
        win.webContents.send('tabs:adopt', back);
        showWindow();
      }
      child.destroy();
    });
  });
  child.on('closed', () => {
    pendingAdopt.delete(wc.id);
    for (const id of ptys.ownedBy(wc)) ptys.kill(id);
  });
}

function registerIpc() {
  ipcMain.handle('state:load', async (e) => {
    const projects = await scanProjects();
    if (!config.workspaces) {
      config.workspaces = seedWorkspaces(projects);
      saveConfigSoon();
    }
    return {
      config,
      projects,
      live: await pollLive(),
      colors: WS_COLORS,
      memoryRoot: memory.root(),
      memoryWarning,
      winBuild: Number(os.release().split('.')[2]) || 19045,
      winId: e.sender.id,
      // A browser elsewhere is a whole window, not a side window.
      child: Boolean(win) && e.sender !== win.webContents && !e.sender.loopRemote,
      remote: Boolean(e.sender.loopRemote),
      adopt: pendingAdopt.get(e.sender.id) || [],
      switches,
    };
  });
  ipcMain.handle('scan', () => scanProjects());
  ipcMain.on('config:save', (e, next) => {
    const own = win && e.sender === win.webContents ? {} : Object.fromEntries(WINDOW_KEYS.map((k) => [k, config[k]]));
    config = { ...next, ...own, window: config.window, settings: { ...DEFAULT_SETTINGS, ...(next.settings || {}) } };
    saveConfigSoon();
    if (switches.servers) servers.sync(config.servers);
    syncPhone();
    for (const w of everyWindow()) if (w.webContents !== e.sender) w.webContents.send('config', config);
  });

  // Terminals moving between windows. The process keeps running throughout.
  ipcMain.on('reply', (_e, id, data) => waiting.has(id) && waiting.get(id)(data));
  ipcMain.handle('win:popout', (e, { specs, x, y }) => {
    const mine = (specs || []).filter((s) => ptys.owner(s.id) === e.sender);
    if (!mine.length) return false;
    for (const s of mine) ptys.hold(s.id);
    createChild(mine, Number(x) || 100, Number(y) || 100);
    return true;
  });
  ipcMain.on('pty:hold', (_e, id) => ptys.hold(String(id)));
  ipcMain.handle('pty:adopt', (e, id) => {
    pendingAdopt.delete(e.sender.id);
    return ptys.adopt(id, e.sender);
  });
  ipcMain.handle('tab:claim', async (e, id) => {
    const from = ptys.owner(id);
    if (!from || from === e.sender || from.isDestroyed()) return null;
    ptys.hold(id);
    const spec = await ask(from, 'tab:release', id);
    if (!spec) ptys.adopt(id, from); // it never let go: leave it where it was
    return spec;
  });
  ipcMain.handle('tab:find', (e, sessionId) => {
    const hit = ptys.find(sessionId, e.sender);
    if (!hit) return false;
    const w = BrowserWindow.fromWebContents(hit.wc);
    if (w) {
      if (w.isMinimized()) w.restore();
      w.show();
      w.focus();
    }
    hit.wc.send('tab:show', hit.id);
    return true;
  });
  ipcMain.on('win:close', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (w && w !== win) w.close();
  });

  const knownAccount = (id) => accounts.isMain(id) || (config.accounts || []).some((a) => a.id === id);

  const allAccounts = (first) => [first || 'default', 'default', ...(config.accounts || []).map((a) => a.id)];

  ipcMain.handle('pty:open', async (e, o) => {
    delete o.remoteCommand;
    delete o.agentCommand;
    // Another agent, signed in with its own plan: its own program, built here from fixed parts.
    if (o.kind === 'agent' || o.kind === 'agentLogin' || o.kind === 'agentInstall') {
      try {
        // The model chosen for this session, kept with its record.
        const rec = (config.agentSessions || {})[String(o.agentSession || '')];
        o.model = rec && rec.agent === o.agent ? String(rec.model || '') : '';
        const agentCommand = agents.command(o);
        if (o.kind !== 'agent') o.cwd = os.homedir();
        else if (!o.cwd || !fs.statSync(o.cwd).isDirectory()) throw new Error(`The project folder no longer exists: ${o.cwd || 'unknown'}`);
        // Which login it runs as: the main one, or one Loop added and still lists.
        const account = String(o.agentAccount || 'default');
        if (account !== 'default' && !(config.agentAccounts || []).some((a) => a.agent === o.agent && a.id === account)) throw new Error('That account was removed. Choose another one.');
        let command = agentCommand;
        if (o.kind === 'agent' && o.agent === 'codex' && config.settings.memoryEnabled !== false) {
          const url = memory.urlFor(String(o.dir || ''), String(o.memberId || ''));
          if (url) {
            await memory.listAll(String(o.dir)).catch(() => []);
            // Plain words only: the line goes through cmd, which acts on these.
            const brief = memory.ownerBrief(String(o.dir), String(o.memberId)).replace(/["%!^&|<>\r\n]/g, ' ').slice(0, 2400);
            command = command.replace(/^codex\b/, `codex -c mcp_servers.loop_memory.url=${url} -c "developer_instructions=${brief}"`);
          }
        }
        ptys.open(e.sender, { ...o, server: null, agentCommand: command }, config.settings, null, o.kind === 'agentInstall' ? {} : agents.envFor(o.agent, account));
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }
    if (o.server) {
      // A tab on a server is an SSH connection from this PC; Claude Code runs over there.
      const server = servers.get(o.server);
      if (!server) return { ok: false, error: 'That server was removed.' };
      try {
        // The Remote Control switch, as for local sessions: on starts connected; off first
        // deletes what a stopped session still points at, so resuming cannot reconnect it.
        const isClaude = o.kind === 'resume' || o.kind === 'new';
        o.remote = isClaude && Boolean((config.sessionRemote || {})[o.sessionId]);
        if (o.kind === 'resume' && !o.remote && !servers.live().some((l) => l.sessionId === o.sessionId)) {
          try {
            const copy = await servers.remotePointer(o.server, o.sessionId);
            if (copy) {
              await remote.deleteWith(copy, [await servers.remoteLogin(o.server)]);
              await servers.remoteClose(o.server, o.sessionId);
            }
          } catch {
            // housekeeping only; the session opens either way
          }
        }
        o.remoteCommand = servers.tabCommand(server, o, config.settings);
        o.account = 'default';
        ptys.open(e.sender, { ...o, cwd: os.homedir() }, config.settings, null, {});
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }
    if (!knownAccount(o.account)) return { ok: false, error: 'That account was removed. Choose another one for this session.' };
    if (o.kind === 'login') o.cwd = os.homedir();
    try {
      if (!o.cwd || !fs.statSync(o.cwd).isDirectory()) throw new Error('not a folder');
    } catch {
      return { ok: false, error: `The project folder no longer exists: ${o.cwd || 'unknown'}` };
    }
    try {
      const isClaude = o.kind === 'resume' || o.kind === 'new';
      const wantsMemory = isClaude && config.settings.memoryEnabled !== false;
      // A session that once had Remote Control on carries a marker in its history, and
      // Claude Code reconnects it on every resume, under whichever account is signed in.
      // The switch on the tab decides. On: start connected. Off: delete whatever copy
      // is still on claude.ai and close the marker before Claude Code can act on it.
      // Remote Control is claude.ai's, so it cannot carry a session on another model.
      const llm = isClaude ? llms.pick(config, o.dir, o.sessionId) : '';
      // On a plan, the model chosen for the session; on an API key, the key's own model.
      o.model = isClaude && !llm ? String((config.sessionModel || {})[o.sessionId] || '') : '';
      o.remote = isClaude && !llm && Boolean((config.sessionRemote || {})[o.sessionId]);
      if (isClaude && !o.remote && o.kind === 'resume' && !liveNow.some((l) => l.sessionId === o.sessionId)) {
        await remote.forget(o.dir, o.sessionId, allAccounts(o.account)).catch(() => {});
      }
      // A team member starts knowing the team as Loop has it now, not as it remembers it.
      delete o.teamBrief;
      if (wantsMemory) o.teamBrief = memory.startBrief(o.dir, o.sessionId);
      const loopOwns = wantsMemory && Boolean(config.memoryMoved);
      if (loopOwns) {
        await memory.listAll(o.dir).catch(() => []);
        o.teamBrief = [memory.ownerBrief(o.dir, o.sessionId), o.teamBrief].filter(Boolean).join(' ');
      }
      delete o.gate; // Loop asks no permission of its own: Claude Code handles that
      const env = { ...accounts.envFor(o.account), ...(isClaude ? viewEnv() : {}), ...llms.envFor(llm), ...(loopOwns ? { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' } : {}) };
      // Right after login the tools on this PC may still be starting; a session that beats them keeps them red.
      if (isClaude) await localTools.ready(env, o.cwd);
      // One file of tools for the session: Loop's memory, and its environment's tools.
      const tools = isClaude ? hub.fileFor(o.dir, o.sessionId, wantsMemory ? memory.urlFor(o.dir, o.sessionId) : null) : { file: null };
      o.strictMcp = Boolean(tools.only);
      ptys.open(e.sender, o, config.settings, tools.file, env);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.on('pty:write', (_e, id, data) => ptys.write(id, data));
  ipcMain.on('pty:resize', (_e, id, cols, rows) => ptys.resize(id, cols, rows));
  ipcMain.on('pty:flow', (_e, id, hold) => ptys.flow(id, hold));
  ipcMain.on('pty:kill', (_e, id, force) => ptys.kill(String(id), Boolean(force)));

  // Models that are not Claude. The key comes in and is never sent back out.
  ipcMain.handle('agent:list', () => agents.statusAll(config.agentAccounts || []));
  ipcMain.handle('agent:removeAccount', async (_e, agent, account) => {
    try {
      if (ptys.usingAgentAccount && ptys.usingAgentAccount(String(agent), String(account))) return { ok: false, error: 'Close the sessions that use this account first.' };
      await new Promise((resolve) => {
        const r = require('child_process').spawn(agents.get(String(agent)).exe, ['logout'], { env: { ...process.env, ...agents.envFor(String(agent), String(account)) }, shell: process.platform === 'win32', windowsHide: true });
        r.on('exit', resolve);
        r.on('error', resolve);
        setTimeout(resolve, 15000);
      });
      agents.removeAccount(String(agent), String(account));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('agent:find', (_e, o) => {
    try {
      return agents.findNative(String(o.agent), String(o.cwd), Number(o.since) || 0);
    } catch {
      return '';
    }
  });
  ipcMain.handle('agent:turns', (_e, o) => {
    try {
      return agents.turns(String(o.agent), String(o.native));
    } catch {
      return [];
    }
  });
  ipcMain.handle('agent:model', (_e, o) => {
    try {
      return agents.modelOf(String(o.agent), String(o.native));
    } catch {
      return '';
    }
  });
  // Loop Cloud: each answers { ok, ... } or { ok: false, text } for the window to show.
  const cloudDo = (fn) => async (_e, ...args) => {
    try {
      return { ok: true, ...((await fn(...args)) || {}) };
    } catch (err) {
      return { ok: false, text: err.message };
    }
  };
  ipcMain.handle('limits:get', (_e, o) => limits.get(String((o && o.agent) || ''), String((o && o.account) || 'default')).catch(() => null));
  // The chat view: a session's conversation, a little at a time.
  ipcMain.handle('chat:read', (_e, o) => chat.read(String((o && o.dir) || ''), String((o && o.sessionId) || ''), Number(o && o.from)).catch(() => ({ size: 0, items: [] })));
  ipcMain.handle('chat:upload', (_e, o) => chat.upload(phone.uploadDir(), o));
  ipcMain.handle('chat:uploadPart', (_e, o) => chat.uploadPart(phone.uploadDir(), o));
  ipcMain.handle('chat:discard', (_e, file) => chat.discard(phone.uploadDir(), file));
  ipcMain.handle('chat:picture', (_e, file) => chat.picture(phone.uploadDir(), file));
  ipcMain.handle('session:rename', (_e, o) => chat.rename(String((o && o.dir) || ''), String((o && o.sessionId) || ''), String((o && o.name) || '')).catch(() => false));
  ipcMain.handle('internet:state', () => internet.check());
  ipcMain.handle('internet:set', cloudDo((on) => internet.setOn(Boolean(on))));
  ipcMain.handle('internet:act', cloudDo((key) => internet.act(String(key || ''))));
  ipcMain.handle('internet:test', cloudDo(() => internet.test()));
  ipcMain.handle('cloud:state', () => cloud.state());
  // What the cloud holds, matched to the projects on this machine.
  ipcMain.handle(
    'cloud:projects',
    cloudDo(async (fresh) => {
      const [held, projects] = await Promise.all([cloud.cloudProjects(Boolean(fresh)), scanProjects()]);
      const locals = projects
        .filter((p) => !p.server && p.exists)
        .map((p) => {
          const mem = memory.projectFolderSync(p.dir);
          return { dir: p.dir, name: p.name || path.basename(p.path || '') || p.dir, remote: gitRemoteOf(p.path), folder: mem ? path.basename(mem) : '' };
        });
      const cs = cloud.state();
      const modeOf = (d) => cs.projects[d] || cs.defaultMode;
      // linked: this cloud project is already this machine's project's memory, kept in step.
      const matched = cloud.matchProjects(held.list, locals).map((c) => ({ ...c, fresh: c.match ? !memory.projectFolderSync(c.match.dir) : false, linked: Boolean(c.match && c.match.how === 'linked' && modeOf(c.match.dir) === 'linked') }));
      return { projects: matched, companyNotes: held.companyNotes, locals: locals.map((l) => ({ dir: l.dir, name: l.name, folder: l.folder, mode: modeOf(l.dir) })) };
    }),
  );
  ipcMain.handle(
    'cloud:bring',
    cloudDo(async (o) => {
      const out = await cloud.bringIn((o && o.items) || [], Boolean(o && o.company));
      for (const it of (o && o.items) || []) await memory.rebuildIndexes(String(it.dir || '')).catch(() => {});
      return out;
    }),
  );
  ipcMain.handle('cloud:notes', cloudDo((o) => cloud.cloudNotes(String((o && o.folder) || ''), String((o && o.dir) || ''))));
  ipcMain.handle(
    'cloud:bringNotes',
    cloudDo(async (o) => {
      const out = await cloud.bringNotes(String((o && o.folder) || ''), String((o && o.dir) || ''), (o && o.rels) || []);
      await memory.rebuildIndexes(String((o && o.dir) || '')).catch(() => {});
      return out;
    }),
  );
  ipcMain.handle('cloud:code', cloudDo((email) => cloud.sendCode(String(email || ''))));
  ipcMain.handle('cloud:verify', cloudDo((email, code) => cloud.verify(String(email || ''), String(code || ''))));
  ipcMain.handle('cloud:signOut', cloudDo(() => cloud.signOut()));
  ipcMain.handle('cloud:mode', cloudDo((mode) => cloud.setMode(String(mode))));
  // Each project's own setting: local, backup or linked.
  ipcMain.handle('cloud:projectMode', cloudDo((dir, mode) => cloud.setProjectMode(String(dir || ''), String(mode || ''))));
  ipcMain.handle('cloud:defaultMode', cloudDo((mode) => cloud.setDefaultMode(String(mode || ''))));
  ipcMain.handle(
    'cloud:link',
    cloudDo(async (dir, folder) => {
      const out = await cloud.link(String(dir || ''), String(folder || ''));
      await memory.rebuildIndexes(String(dir || '')).catch(() => {});
      return out;
    }),
  );
  ipcMain.handle('cloud:sync', cloudDo(() => cloud.syncNow()));
  ipcMain.handle('cloud:backup', cloudDo(() => cloud.backupNow()));
  ipcMain.handle('cloud:backups', cloudDo(async () => ({ list: await cloud.backups() })));
  ipcMain.handle('cloud:restore', cloudDo((id) => cloud.restore(String(id))));
  ipcMain.handle('cloud:refresh', cloudDo(() => cloud.refresh().then(() => cloud.state())));
  ipcMain.on('cloud:site', () => shell.openExternal(cloud.BASE + '/cloud'));

  // Tools and environments: see src/main/hub.js. Set up on the website; chosen here.
  ipcMain.handle('hub:state', () => hubView());
  ipcMain.handle('hub:refresh', async () => {
    const r = await hubRefresh();
    return { ...r, state: hubView() };
  });
  ipcMain.handle('hub:projectEnv', (_e, dir, id) => hub.setProjectEnv(String(dir), String(id || '')));
  ipcMain.handle('hub:defaultEnv', (_e, id) => hub.setDefaultEnv(String(id || '')));
  ipcMain.handle('hub:approve', (_e, key) => hub.approve(String(key)));
  ipcMain.handle('hub:test', (_e, key) => hub.test(String(key)));
  ipcMain.on('hub:site', () => shell.openExternal(cloud.BASE + '/cloud#/tools'));
  // Hands the tools this PC's Claude Code already has to Loop Cloud, once asked.
  ipcMain.handle('hub:import', async () => {
    if (!cloud.state().signedIn) return { ok: false, error: 'Sign in to Loop Cloud first.' };
    const list = hub.fromClaude(accounts.homeOf('default').json);
    if (!list.length) return { ok: true, added: 0 };
    try {
      const r = await cloud.toolsImport(list);
      hub.trust(list); // they are this PC's own programs
      await hubRefresh();
      return { ok: true, added: r.added };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // Updates: see src/main/updater.js.
  ipcMain.handle('update:state', () => updater.get());
  ipcMain.handle('update:check', () => updater.check());
  ipcMain.handle('update:download', () => updater.download());
  ipcMain.on('update:auto', (_e, on) => updater.setAuto(on));
  ipcMain.on('update:page', () => shell.openExternal(updater.get().page));
  ipcMain.handle('update:install', () =>
    updater.install(() => {
      quitting = true; // no "terminals still open" question: the user said restart
    }),
  );
  ipcMain.handle('llm:presets', () => llms.PRESETS);
  ipcMain.handle('llm:list', () => llms.all());
  ipcMain.handle('llm:save', (_e, o) => {
    try {
      return { ok: true, llm: llms.save(o || {}) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('llm:remove', (_e, id) => llms.remove(String(id)));
  ipcMain.handle('llm:models', (_e, o) => llms.models(o || {}));
  ipcMain.handle('llm:check', (_e, o) => llms.check(o || {}));

  ipcMain.handle('acct:status', (_e, ids) =>
    Promise.all(
      (ids || ['default', ...(config.accounts || []).map((a) => a.id)])
        .filter(knownAccount)
        .map((id) => accounts.status(id, config.settings.claudeCmd).catch((err) => ({ id, loggedIn: false, error: err.message }))),
    ),
  );
  // Sign out and delete the account's folder. Sessions are shared, so none are lost.
  ipcMain.handle('acct:remove', async (_e, id) => {
    if (accounts.isMain(id)) return { ok: false, error: 'The main account is the Claude Code login on this PC and cannot be removed here.' };
    if (ptys.usingAccount(id)) return { ok: false, error: 'Close the terminals that use this account first.' };
    try {
      await accounts.logout(id, config.settings.claudeCmd);
      accounts.remove(id);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('mem:list', (_e, { dir, scope }) => memory.list(dir, scope));
  // Each agent's own memory files for one project, and copying the chosen ones into Loop's.
  // `where` is the project's folder, which only the window's project list knows; it is only read from.
  const folderOk = (where) => {
    try {
      return where && fs.statSync(String(where)).isDirectory() ? String(where) : '';
    } catch {
      return '';
    }
  };
  ipcMain.handle('mem:importList', (_e, { dir, path: where }) => memoryImport.list(String(dir), folderOk(where)));
  ipcMain.handle('mem:import', (_e, { dir, path: where, ids }) => memoryImport.bring(String(dir), folderOk(where), (ids || []).map(String)));
  ipcMain.handle('mem:search', (_e, { dir, scope, query }) => memory.search(dir, scope, query));
  ipcMain.handle('mem:save', (_e, note) => memory.saveNote(note));
  ipcMain.handle('mem:delete', (_e, ref) => memory.removeNote(ref));
  ipcMain.handle('mem:setRoot', async (_e, dir) => {
    const r = await memory.setRoot(String(dir));
    if (r.ok) {
      config.settings.memoryDir = r.root;
      memoryWarning = null;
      saveConfigSoon();
    }
    return r;
  });

  ipcMain.handle('task:list', (_e, dir) => memory.taskList(dir));
  // Sub-sessions: which repositories a project has, and a worktree to work in.
  ipcMain.handle('sub:repos', (_e, cwd) => subs.repos(String(cwd || '')));
  ipcMain.handle('sub:worktree', (_e, o) => subs.worktree({ cwd: String(o.cwd || ''), repo: String(o.repo || '.'), name: String(o.name || '') }));
  ipcMain.handle('sub:remove', (_e, o) => subs.removeWorktree({ repo: String(o.repo || ''), path: String(o.path || '') }));
  // The rules Loop ships with, for showing beside the ones the user has written.
  ipcMain.handle('company:house', () => memory.housePlain());
  // What a session has running in the background, for the window's own panel.
  ipcMain.handle('bg:list', async (_e, { dir, sessionId, server }) => {
    const r = server ? await servers.readTranscript(String(server), String(dir), String(sessionId), -1) : await transcript.readLocal(String(dir), String(sessionId), -1);
    return bgTasks.readTasks((r && r.text) || '');
  });
  ipcMain.handle('bg:out', async (_e, { dir, sessionId, server, task }) => {
    const r = server ? await servers.readTranscript(String(server), String(dir), String(sessionId), -1) : await transcript.readLocal(String(dir), String(sessionId), -1);
    const one = bgTasks.readTasks((r && r.text) || '').find((t) => t.id === String(task));
    if (!one || !one.file) return { text: '' };
    return server ? servers.readTaskOut(String(server), one.file) : bgTasks.tailOf(one.file);
  });
  ipcMain.handle('task:add', (_e, { dir, task }) => memory.taskAdd(dir, { ...task, by: 'you' }));
  ipcMain.handle('task:update', (_e, { dir, id, change }) => memory.taskUpdate(dir, id, change, 'you'));
  ipcMain.handle('task:remove', (_e, { dir, id }) => memory.taskRemove(dir, id));
  ipcMain.handle('srv:state', () => servers.snapshot());
  ipcMain.handle('srv:probe', (_e, id) => servers.probe(String(id)));
  ipcMain.handle('srv:resolve', (_e, s) => servers.resolve(s || {}));
  ipcMain.on('srv:refresh', (_e, id) => servers.refresh(String(id)));
  ipcMain.handle('srv:list', (_e, { id, dir }) => servers.listDir(String(id), String(dir || '')));
  ipcMain.handle('srv:clone', (_e, { id, dir, url }) => servers.clone(String(id), String(dir || ''), url));
  ipcMain.handle('srv:adduser', (_e, { id, name }) => servers.addUser(String(id), name));
  ipcMain.handle('srv:mkdir', (_e, { id, dir }) => servers.makeDir(String(id), String(dir || '')));
  ipcMain.handle('srv:stop', async (_e, { server, sessionId }) => {
    const s = servers.get(server);
    // One Loop runs over SSH for the phone ends here too, or it carries on.
    direct.stop(String(sessionId));
    return s ? (await servers.stopSession(s, sessionId)).ok : false;
  });
  ipcMain.handle('dialog:file', async (_e, start) => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'showHiddenFiles'], defaultPath: start || path.join(os.homedir(), '.ssh') });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('remote:pointer', (_e, { dir, sessionId, server }) => (server ? servers.remotePointer(String(server), sessionId) : remote.pointer(dir, sessionId)));
  // Delete a session's copy on claude.ai. `id` is the copy it pointed at before it was disconnected.
  ipcMain.handle('remote:delete', async (_e, { id, account, server }) => ({
    ...(server ? await remote.deleteWith(id, [await servers.remoteLogin(String(server))]) : await remote.deleteCopy(id, allAccounts(account))),
    link: remote.link(id),
  }));
  ipcMain.handle('peek', (_e, { dir, sessionId }) => peek(dir, sessionId));
  ipcMain.handle('session:trash', (_e, { dir, sessionId, title }) => trash.put(dir, sessionId, title));
  ipcMain.on('wa:done', (_e, id, r) => {
    const done = waWaits.get(id);
    waWaits.delete(id);
    if (done) done(r);
  });
  ipcMain.on('team:done', (_e, id, text) => {
    const done = teamWaits.get(id);
    teamWaits.delete(id);
    if (done) done(text);
  });
  // The window's answers to a phone, and the pairing details for the dialog.
  ipcMain.on('phone:out', (_e, msg) => phone.fromWindow(msg));
  ipcMain.handle('phone:state', () => ({ ...phone.state(), relay: relay.state() }));
  // Turning the web address on or off, and making new secrets for it.
  ipcMain.handle('relay:set', (_e, o) => {
    relay.set({ ...o, name: (o && o.name) || os.hostname() }, phone.state().port);
    syncPhone();
    return relay.state();
  });
  // A message for a session that has no terminal open: it goes straight in.
  ipcMain.handle('direct:send', async (_e, o) => {
    if (!o || !o.cwd) return 'That session has nowhere to run.';
    if (o.server) {
      const spawnWith = servers.directSpawn(String(o.server), { sessionId: String(o.sessionId), cwd: String(o.cwd) }, config.settings);
      if (!spawnWith) return 'That server is not connected.';
      return direct.send({ sessionId: String(o.sessionId), cwd: String(o.cwd), text: String(o.text || ''), warm: Boolean(o.warm), settings: config.settings, spawn: spawnWith, env: {} });
    }
    const account = knownAccount(o.account) ? o.account : 'default';
    // Switch off, and nothing of ours running it: delete whatever copy it still
    // points at on claude.ai and close the marker, so this start cannot
    // reconnect it. The same housekeeping a terminal start does.
    if (!(config.sessionRemote || {})[o.sessionId] && !direct.list().includes(String(o.sessionId))) {
      await remote.forget(o.dir, String(o.sessionId), allAccounts(account)).catch(() => {});
    }
    const llm = llms.pick(config, o.dir, String(o.sessionId));
    const loopOwns = config.settings.memoryEnabled !== false && Boolean(config.memoryMoved);
    if (loopOwns) await memory.listAll(String(o.dir)).catch(() => []);
    let env;
    try {
      env = { ...accounts.envFor(account), ...viewEnv(), ...llms.envFor(llm), ...(loopOwns ? { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' } : {}) };
    } catch (err) {
      return err.message;
    }
    if (!direct.list().includes(String(o.sessionId))) await localTools.ready(env, o.cwd);
    const tools = hub.fileFor(String(o.dir), String(o.sessionId), config.settings.memoryEnabled !== false ? memory.urlFor(o.dir, o.sessionId) : null);
    return direct.send({
      sessionId: String(o.sessionId),
      cwd: String(o.cwd),
      text: String(o.text || ''),
      warm: Boolean(o.warm),
      // A session Loop has never run before: start it rather than resume it.
      fresh: Boolean(o.fresh),
      // The switch decides here too: on starts it connected to claude.ai.
      remote: !llm && Boolean((config.sessionRemote || {})[o.sessionId]),
      settings: config.settings,
      mcpConfig: tools.file,
      strictMcp: Boolean(tools.only),
      brief: config.settings.memoryEnabled !== false ? [loopOwns ? memory.ownerBrief(String(o.dir), String(o.sessionId)) : '', memory.startBrief(o.dir, o.sessionId)].filter(Boolean).join(' ') : '',
      env,
    });
  });
  // ---- voice mode ----
  // The models run beside Loop (see voice.js); the window does the listening
  // and the playing, so what crosses here is only words and sound.
  const voiceVoice = () => String((config.settings && config.settings.voiceName) || 'af_heart');
  voice.setListener((e) => sendAll('voice:event', e));
  ipcMain.handle('voice:state', () => ({ ...voice.state(), voice: voiceVoice() }));
  ipcMain.handle('voice:warm', (_e, what) => voice.warm(String(what || 'say'), voiceVoice()).then(() => true));
  ipcMain.handle('voice:rules', () => voice.VOICE_RULES);
  // What is worth hearing of something a session wrote, and in what pieces.
  ipcMain.handle('voice:plan', (_e, text) => {
    const spoken = voice.speakable(String(text || ''));
    return { spoken, parts: spoken ? voice.sentences(spoken) : [] };
  });
  ipcMain.handle('voice:say', async (_e, text) => {
    const r = await voice.say(String(text || ''), voiceVoice());
    return { pcm: voice.pcmFloats(r.pcm), rate: r.rate, seconds: r.seconds };
  });
  ipcMain.handle('voice:hear', async (_e, { pcm, rate, names }) => {
    const r = await voice.hear(voice.pcmBase64(pcm), Number(rate) || 16000);
    return { text: voice.fixNames(r.text || '', Array.isArray(names) ? names : []) };
  });
  ipcMain.handle('voice:voices', async () => (await voice.voices()).list);
  // The session's own words, as they are written, so the voice can read them.
  ipcMain.on('voice:follow', (e, { dir, sessionId, server }) => {
    transcript.follow('voice', { dir: String(dir || ''), sessionId: String(sessionId || ''), server: String(server || '') }, (msg) => {
      if (!e.sender.isDestroyed()) e.sender.send('voice:chat', msg);
    }, servers.readTranscript);
  });
  ipcMain.on('voice:unfollow', () => transcript.unfollow('voice'));
  // A lead's latest plan or report, for the phone's Home.
  ipcMain.handle('lead:report', async (_e, o) => transcript.leadReport(await peek(String((o && o.dir) || ''), String((o && o.sessionId) || ''), { tools: true })));
  // What a goal cost, for the Done card on the phone: the whole project since it was given.
  ipcMain.handle('goal:tokens', (_e, o) => transcript.goalTokens(path.join(CLAUDE_DIR_FOR_TOKENS, 'projects'), String((o && o.dir) || ''), Number((o && o.since) || 0)));
  // Usage and context for the phone and the web, from the session's own account.
  ipcMain.handle('direct:info', (_e, o) => {
    if (!o || !o.cwd) return { ok: false, text: 'That session has nowhere to run.' };
    if (o.server) return { ok: false, text: 'Usage and context are shown for sessions on this PC.' };
    const account = knownAccount(o.account) ? o.account : 'default';
    if (llms.pick(config, o.dir, String(o.sessionId || ''))) return { ok: false, text: 'Usage is shown by the provider of the model this session runs on.' };
    return direct.info({ what: String(o.what), sessionId: String(o.sessionId || ''), cwd: String(o.cwd), settings: config.settings, env: accounts.envFor(account) });
  });
  ipcMain.handle('direct:stop', (_e, sessionId) => direct.stop(String(sessionId)));
  ipcMain.handle('direct:interrupt', (_e, sessionId) => direct.interrupt(String(sessionId)));
  ipcMain.handle('direct:list', () => direct.list());
  ipcMain.handle('srv:runningThere', (_e, { server, sessionId }) => servers.runningThere(String(server), String(sessionId)));
  // Claude waiting on you in a session with no terminal, and your answer.
  ipcMain.handle('direct:asks', () => direct.asks());
  ipcMain.handle('direct:answer', (_e, sessionId, key, text) => direct.answer(String(sessionId), String(key || ''), String(text || '')));
  // Only files the bridge itself saved can be sent this way.
  // A picture copied to the server while the message was still being written
  // is not copied again when it is sent.
  ipcMain.handle('phone:put', (_e, { server, file }) => {
    if (path.dirname(String(file)) !== phone.uploadDir()) return null;
    const key = `${server}|${file}`;
    if (!farCopies.has(key)) farCopies.set(key, servers.putUpload(String(server), String(file)));
    return farCopies.get(key);
  });
  // A picture dropped on a server session's terminal goes to the server the way
  // a phone upload does; other files stay on this PC (the server cannot read them).
  ipcMain.handle('drop:server', async (_e, { server, file }) => {
    const ext = path.extname(String(file || '')).toLowerCase();
    if (!/^.(png|jpe?g|gif|webp|bmp)$/.test(ext)) return null;
    try {
      fs.mkdirSync(phone.uploadDir(), { recursive: true });
      const copy = path.join(phone.uploadDir(), `phone-${require('crypto').randomUUID()}${ext}`);
      fs.copyFileSync(String(file), copy);
      return await servers.putUpload(String(server), copy);
    } catch {
      return null;
    }
  });
  ipcMain.handle('phone:token', () => phone.newToken());
  ipcMain.handle('trash:list', () => trash.list());
  ipcMain.handle('trash:restore', (_e, { dir, sessionId }) => trash.restore(dir, sessionId));
  // Close a session that is running in another terminal so it can be opened
  // here. Only pids that Claude Code itself lists as live sessions qualify.
  ipcMain.handle('live:close', async (_e, sessionId, force) => {
    const hit = liveNow.find((l) => l.sessionId === sessionId);
    if (!hit) return true;
    try {
      if (!(await isClaudePid(hit.pid))) return false; // the pid now belongs to something else
      // Asking it to go, or insisting: insisting takes whatever it started too.
      if (force) shellOf.killTree(hit.pid);
      else process.kill(hit.pid);
    } catch {
      return false;
    }
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 200));
      if (!(await pollLive()).some((l) => l.sessionId === sessionId)) return true;
    }
    return false;
  });
  ipcMain.on('focus', showWindow);
  ipcMain.on('attention', () => {
    if (win && !win.isFocused()) win.flashFrame(true);
  });
  // Where one scope's notes are, to show it and to open it.
  ipcMain.handle('mem:folder', async (_e, { dir, scope }) => {
    try {
      return await memory.scopeFolder(String(dir), String(scope));
    } catch {
      return memory.root();
    }
  });
  ipcMain.on('mem:open', async (_e, { dir, scope }) => {
    let where = memory.root();
    try {
      where = await memory.scopeFolder(String(dir), String(scope));
      fs.mkdirSync(where, { recursive: true });
    } catch {
      // the whole folder, then
    }
    shell.openPath(where);
  });
  // Memory as a zip: one session, the project (shared notes, every session, the board), or all of it.
  ipcMain.handle('mem:export', async (e, { dir, scope, name }) => {
    try {
      const what = String(scope);
      const folder = what === 'all' ? memory.root() : what === 'project' ? await memory.projectFolder(String(dir)) : await memory.scopeFolder(String(dir), what);
      if (!fs.existsSync(folder)) return { ok: false, text: 'There is no memory there to export yet.' };
      const day = new Date().toISOString().slice(0, 10);
      const label = String(name || 'memory').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'memory';
      const pick = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender), {
        title: 'Export memory',
        defaultPath: path.join(app.getPath('documents'), `loop-memory-${label}-${day}.zip`),
        filters: [{ name: 'Zip', extensions: ['zip'] }],
      });
      if (pick.canceled || !pick.filePath) return { ok: false, canceled: true };
      // Windows' own tar writes zip files; backups of old layouts stay out.
      await new Promise((resolve, reject) =>
        require('child_process').execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-a', '-c', '-f', pick.filePath, '--exclude', '.backup-*', '-C', folder, '.'], { windowsHide: true, timeout: 120000 }, (err) => (err ? reject(err) : resolve())),
      );
      return { ok: true, file: pick.filePath };
    } catch (err) {
      return { ok: false, text: `Could not export: ${err.message}` };
    }
  });
  ipcMain.on('mem:reveal', async (_e, dir) => {
    try {
      shell.openPath(await memory.projectFolder(String(dir)));
    } catch {
      shell.openPath(memory.root());
    }
  });

  ipcMain.handle('clip:read', () => clipboard.readText());
  ipcMain.on('clip:write', (_e, text) => clipboard.writeText(String(text)));
  ipcMain.on('shell:reveal', (_e, p) => shell.openPath(String(p)));
  ipcMain.on('shell:show', (_e, p) => shell.showItemInFolder(String(p)));
  ipcMain.on('shell:external', (_e, url) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });
  ipcMain.handle('dialog:folder', async (_e, start) => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], defaultPath: start || undefined });
    return r.canceled ? null : r.filePaths[0];
  });
}

// Test hook: run a script in the window, save a screenshot, quit.
function smoke() {
  // Longest stall of this process, reported with the result.
  let stall = 0;
  let beat = Date.now();
  setInterval(() => {
    stall = Math.max(stall, Date.now() - beat - 10);
    beat = Date.now();
  }, 10);
  win.webContents.once('did-finish-load', async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    try {
      await wait(1800);
      if (process.env.SD_SMOKE_JS) {
        const out = await win.webContents.executeJavaScript(fs.readFileSync(process.env.SD_SMOKE_JS, 'utf8'), true);
        if (out !== undefined) console.log('SMOKE_RESULT ' + JSON.stringify(out));
      }
      await wait(Number(process.env.SD_SMOKE_WAIT || 1500));
      console.log('SMOKE_MAIN_STALL ' + stall);
      for (const w of everyWindow()) {
        if (w !== win) fs.writeFileSync(process.env.SD_SMOKE.replace(/.png$/, '.child.png'), (await w.webContents.capturePage()).toPNG());
      }
      fs.writeFileSync(process.env.SD_SMOKE, (await win.webContents.capturePage()).toPNG());
    } catch (e) {
      console.log('SMOKE_ERROR ' + e.message);
    }
    app.quit();
  });
  win.webContents.on('console-message', (e) => console.log('RENDERER ' + e.message));
  console.log('ICON_OK ' + !nativeImage.createFromPath(ICON).isEmpty());
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.whenReady().then(async () => {
    // macOS reads copy, paste and quit from the menu, so it keeps a minimal one.
    Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]) : null);
    config = loadConfig();
    app.setAppUserModelId('com.prismaple.loop');
    memory.setProfileLookup((id) => ({
      role: (config.sessionRole || {})[id] || '',
      name:
        (config.sessionAlias || {})[id] ||
        Object.values(config.projectTeam || {})
          .map((t) => (t.names || {})[id])
          .find(Boolean) ||
        '',
    }));
    // A team names its roles; what a role knows and who it hands to is global.
    memory.setTeamLookup((dir) => {
      const t = (config.projectTeam || {})[dir];
      if (!t) return null;
      return { ...t, roles: t.roles.map((r) => (config.roles || []).find((x) => x.key === r.key) || r) };
    });
    // The company: the rules every team works by, and how long the CEO waits
    // for an update. The user and the CEO both change it, so it is read fresh.
    memory.setCompanyLookup(() => config.company || {});
    memory.setSubLookup((id) => (config.subSessions || {})[id] || null);
    memory.onBoard((dir) => sendAll('board', dir));
    // A session asked to change the team: the window owns the settings, so it does the work.
    memory.setTeamDo(
      (req) =>
        new Promise((resolve) => {
          if (!win || win.isDestroyed()) return resolve('The Loop window is closed, so the team cannot be changed right now.');
          const id = ++teamAsk;
          const timer = setTimeout(() => {
            teamWaits.delete(id);
            resolve('Loop did not answer in time. Nothing may have changed; call team_info to check.');
          }, 20000);
          teamWaits.set(id, (text) => {
            clearTimeout(timer);
            resolve(String(text));
          });
          win.webContents.send('team:do', id, req);
        }),
    );
    // WhatsApp messages from the people a session listens to: the window delivers
    // them, the way it delivers a phone's message.
    whatsapp.init(
      app.getPath('userData'),
      (dir, sessionId, text) =>
        new Promise((resolve) => {
          if (!win || win.isDestroyed()) return resolve(false);
          const id = ++teamAsk;
          const timer = setTimeout(() => {
            waWaits.delete(id);
            resolve(false);
          }, 120000);
          waWaits.set(id, (r) => {
            clearTimeout(timer);
            resolve(Boolean(r && r.ok));
          });
          win.webContents.send('wa:deliver', id, dir, sessionId, text);
        }),
    );
    memory.setWhatsApp((dir, me, contact, stop) => whatsapp.listen(dir, me, contact, stop));
    phone.init(app.getPath('userData'));
    relay.init(app.getPath('userData'));
    // A session running without a terminal still shows as working in the list.
    direct.setListener(() => pollLive());
    relay.setListener(() => sendAll('phone', { ...phone.state(), relay: relay.state() }));
    // The words of an answer, on their way to the phone as they are written.
    direct.setTextListener((sessionId, text, done) => phone.draft(sessionId, text, done));
    direct.setAskListener((sessionId, ask) => sendAll('direct:ask', sessionId, ask));
    // /clear in a session with no terminal: the window moves its name, role and
    // seat to the new conversation, and phones reading it follow.
    direct.setResetListener((from, to) => {
      sendAll('direct:reset', from, to);
      phone.moved(from, to);
      whatsapp.moved(from, to);
    });
    phone.setHooks({
      openTicket: (ticket) => internet.openTicket(ticket),
      deskServe: (req, res) => remoteDesk.serve(req, res),
      deskAttach: (ws) => remoteDesk.attach(ws),
      visitorOk: (key) => internet.visitorOk(key),
      toWindow: (channel, payload) => {
        if (!win || win.isDestroyed()) return false;
        if (channel !== 'phone:ping') win.webContents.send(channel, payload);
        return true;
      },
      onCount: (s) => syncRelay(s),
      remoteRead: (server, dir, sessionId, from) => servers.readTranscript(server, dir, sessionId, from),
      remoteTail: (server, file) => servers.readTaskOut(server, file),
      toServer: (server, file, onProgress) => {
        const key = `${server}|${file}`;
        const p = servers.putUpload(server, file, onProgress);
        farCopies.set(key, p);
        if (farCopies.size > 50) farCopies.delete(farCopies.keys().next().value);
        return p;
      },
    });
    memory.setProjectNamer(async (dir) => {
      const where = await scannerResolve(dir).catch(() => null);
      return where ? path.basename(where) : '';
    });
    memory.setSessionNamer((id) => {
      const agentRec = Object.values(config.agentSessions || {}).find((r) => r.memberId === id);
      // The name the user gave it, its name in the team, or the first words of its role.
      const teamName = Object.values(config.projectTeam || {})
        .map((t) => (t.names || {})[id])
        .find(Boolean);
      const role = String((config.sessionRole || {})[id] || '').split(/\s+/).slice(0, 3).join(' ');
      return (config.sessionAlias || {})[id] || teamName || (agentRec && agentRec.name) || role || '';
    });
    memory.setRemoteLookup(async (dir) => {
      const where = await scannerResolve(dir).catch(() => null);
      return where ? gitRemoteOf(where) : '';
    });
    memoryWarning = await memory.init(app.getPath('userData'), config.settings.memoryDir);
    accounts.init(app.getPath('userData'));
    agents.init(app.getPath('userData'));
    llms.init(app.getPath('userData'), {
      encrypt: (text) => safeStorage.encryptString(text).toString('base64'),
      decrypt: (b64) => safeStorage.decryptString(Buffer.from(b64, 'base64')),
    });
    limits.init({ file: path.join(app.getPath('userData'), 'limits.json'), claudeHome: (account) => accounts.homeOf(account).dir, claudeJson: (account) => accounts.homeOf(account).json, codexHome: (account) => agents.homeOf('codex', account) });
    cloud.init(app.getPath('userData'), {
      encrypt: (text) => safeStorage.encryptString(text).toString('base64'),
      decrypt: (b64) => safeStorage.decryptString(Buffer.from(b64, 'base64')),
      root: () => memory.root(),
      onChange: (s) => sendAll('cloud', s),
      afterPull: () => memory.forget(),
    });
    await hub.init(app.getPath('userData'), { onChange: () => sendAll('hub', hubView()) });
    setInterval(() => hubRefresh().catch(() => {}), 30e3).unref();
    setTimeout(() => hubRefresh().catch(() => {}), 6e3).unref();
    remoteDesk.init({
      renderer: path.join(__dirname, '..', 'renderer'),
      nodeModules: path.join(__dirname, '..', '..', 'node_modules'),
      preload: path.join(__dirname, 'preload.js'),
      // A browser that went away leaves its sessions running here, held for the next window.
      onGone: (sender) => {
        for (const id of ptys.ownedBy(sender)) ptys.hold(id);
      },
    });
    internet.init(app.getPath('userData'), {
      cloud,
      shell,
      powerSaveBlocker,
      phonePort: () => Number((config.phone || {}).port) || phone.PORT,
      phoneOn: () => syncPhone(),
      onChange: (s) => sendAll('internet', s),
    });
    // Claude sessions do not need this, so Loop opens whether or not it starts.
    await llms.start().catch((err) => console.error('Could not start the model bridge:', err.message));
    trash.init(app.getPath('userData'));
    accounts.watchConnectors(); // connector sign-ins are the same under every account
    // A server reports every few seconds; pass on only what changed.
    let lastServers = '';
    servers.setListener(() => {
      const snap = servers.snapshot();
      const key = JSON.stringify(snap.map((x) => ({ ...x, at: 0 })));
      if (key === lastServers) return;
      lastServers = key;
      sendAll('servers', snap);
      pollLive();
    });
    if (switches.servers) servers.sync(config.servers);
    syncPhone();
    registerIpc();
    createWindow();
    ptys.start(); // have the terminal helper warm before the first click
    if (process.env.SD_SMOKE) smoke();
    else updater.init({ onState: (st) => sendAll('update', st), autoDownload: config.settings.autoUpdate !== false });
    setInterval(pollLive, 2000);
    setInterval(() => {
      if (everyWindow().some((w) => w.isVisible() && !w.isMinimized())) sendAll('stats', stats.sample(app.getAppMetrics()));
    }, 3000);
  });
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => {
    updater.stop();
    hub.stop();
    stats.stop();
    accounts.stopWatching();
    llms.stop();
    servers.stopAll();
    phone.stop();
    direct.stopAll();
    relay.stop();
    whatsapp.stop();
    cloud.stop();
    internet.stop();
  });
}
