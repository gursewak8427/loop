// One terminal per open tab (ConPTY on Windows). Every tab is a real shell at
// the project root: cmd.exe on Windows, the user's own shell elsewhere;
// Claude tabs start with the claude command already typed in, so when Claude
// exits you are left at a normal prompt in that folder.
//
// The terminals themselves live in a helper process (pty-host.js). This file
// is the thin part that stays with the window: it checks what is asked for,
// passes it on, and hands output back to the tab it belongs to.
const path = require('path');
const { UUID_RE } = require('./scanner');
const shell = require('./shell');

const tabs = new Map(); // tab id -> { wc, account, sessionId, buffer, exited }; wc is null while the tab is between windows
let host = null;
let ready = false;
let backlog = [];

// Text that goes inside double quotes on the command line. cmd acts on & | < > ^ % !;
// a POSIX shell still expands $, ` and \ inside double quotes.
const unsafe = (platform) => (shell.isWin(platform) ? /["&|<>^%!\r\n]/g : /["&|<>^%!\r\n$`\\]/g);

function buildCommand(o, settings, mcpConfig, platform = process.platform) {
  if (o.agentCommand) return o.agentCommand; // another agent: built by the main process from fixed parts
  if (o.remoteCommand) return o.remoteCommand; // a tab on a server: set by the main process, never by the page
  if (o.kind === 'shell') return null;
  if (o.kind === 'login') return `${settings.claudeCmd || 'claude'} auth login`;
  if (!UUID_RE.test(o.sessionId || '')) throw new Error('Invalid session id');
  const parts = [settings.claudeCmd || 'claude'];
  if (settings.flags) parts.push(settings.flags);
  if (mcpConfig) parts.push('--mcp-config', `"${mcpConfig}"`);
  // A tool environment set to "only these tools": the agent's own list is left out.
  if (mcpConfig && o.strictMcp) parts.push('--strict-mcp-config');
  if (o.remote) {
    const label = (o.title || o.name || '').replace(unsafe(platform), '').trim();
    parts.push('--remote-control', `"${label || 'Loop'}"`);
  }
  // What the session must know about its team from its first moment, as one safe line.
  const brief = String(o.teamBrief || '')
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/"/g, "'")
    .replace(unsafe(platform), '')
    .slice(0, 3800)
    .trim();
  if (brief) parts.push('--append-system-prompt', `"${brief}"`);
  if (o.model && /^[A-Za-z0-9._[]-]{1,80}$/.test(o.model)) parts.push('--model', o.model);
  if (o.kind === 'resume') parts.push('--resume', o.sessionId);
  else parts.push('--session-id', o.sessionId);
  const name = (o.name || '').replace(unsafe(platform), '').trim();
  if (name) parts.push('-n', `"${name}"`);
  return parts.join(' ');
}

function closed(id) {
  const tab = tabs.get(id);
  if (!tab) return;
  tabs.delete(id);
  if (tab.wc && !tab.wc.isDestroyed()) tab.wc.send('pty:exit', id);
}

function startHost() {
  const { utilityProcess } = require('electron');
  host = utilityProcess.fork(path.join(__dirname, 'pty-host.js'), [], { serviceName: 'Loop terminals' });
  host.once('spawn', () => {
    ready = true;
    for (const m of backlog) host.postMessage(m);
    backlog = [];
  });
  host.on('message', (m) => {
    const tab = tabs.get(m.id);
    if (!tab) return;
    if (m.t === 'data') {
      if (tab.wc && !tab.wc.isDestroyed()) tab.wc.send('pty:data', m.id, m.d);
      else if (!tab.wc && tab.buffer.length < 8e6) tab.buffer += m.d; // kept for the window that takes it over
    } else if (m.t === 'exit') {
      if (tab.wc) closed(m.id);
      else tab.exited = true;
    }
  });
  // If the helper dies, its terminals die with it. Say so; the next tab starts a new helper.
  host.once('exit', () => {
    host = null;
    ready = false;
    backlog = [];
    for (const id of [...tabs.keys()]) closed(id);
  });
}

function send(m) {
  if (!host) startHost();
  if (ready) host.postMessage(m);
  else backlog.push(m);
}

// extraEnv selects the account: CLAUDE_CONFIG_DIR for anything but the main one.
function open(wc, o, settings, mcpConfig, extraEnv) {
  if (tabs.has(o.id)) return;
  const command = buildCommand(o, settings, mcpConfig);
  tabs.set(o.id, { wc, account: o.account || 'default', agent: o.agent || null, agentAccount: o.agentAccount || 'default', sessionId: o.sessionId || null, buffer: '', exited: false });
  // A tab on a server ends when its connection does; a local one drops back to a prompt in the project folder.
  send({ t: 'open', id: o.id, command, once: Boolean(o.remoteCommand), cwd: o.cwd, cols: o.cols, rows: o.rows, env: extraEnv || {} });
}

const write = (id, data) => tabs.has(id) && send({ t: 'write', id, d: data });
const resize = (id, cols, rows) => tabs.has(id) && send({ t: 'resize', id, cols, rows });
const flow = (id, hold) => tabs.has(id) && send({ t: 'flow', id, hold: Boolean(hold) });

function kill(id, force) {
  if (!tabs.has(id)) return;
  tabs.delete(id);
  send({ t: 'kill', id, force: Boolean(force) });
}

// Terminals that are still running with no window showing them: a session you
// closed the tab of, which carries on working in Loop.
const held = () => [...tabs].filter(([, t]) => !t.wc && !t.exited && t.sessionId).map(([id, t]) => ({ id, sessionId: t.sessionId }));

function killAll() {
  tabs.clear();
  if (!host) return;
  const h = host;
  if (ready) h.postMessage({ t: 'killAll' });
  setTimeout(() => h.kill(), 300);
}

// ---- moving a terminal from one window to another ----

// Stop sending to its window and keep what it prints until another window adopts it.
function hold(id) {
  const tab = tabs.get(id);
  if (tab) tab.wc = null;
}

function adopt(id, wc) {
  const tab = tabs.get(id);
  if (!tab) return false;
  tab.wc = wc;
  if (tab.buffer) wc.send('pty:data', id, tab.buffer);
  tab.buffer = '';
  if (tab.exited) closed(id);
  return true;
}

const owner = (id) => (tabs.get(id) || {}).wc || null;
const ownedBy = (wc) => [...tabs].filter(([, t]) => t.wc === wc).map(([id]) => id);

function find(sessionId, except) {
  for (const [id, t] of tabs) if (sessionId && t.sessionId === sessionId && t.wc && t.wc !== except) return { id, wc: t.wc };
  return null;
}

const usingAccount = (id) => [...tabs.values()].some((e) => e.account === id);

// Whether an open tab runs as this login of another agent.
const usingAgentAccount = (agent, account) => [...tabs.values()].some((t) => !t.exited && t.agent === agent && t.agentAccount === account);

module.exports = {
  usingAgentAccount,
  open,
  write,
  resize,
  flow,
  kill,
  killAll,
  held,
  hold,
  adopt,
  owner,
  ownedBy,
  find,
  usingAccount,
  buildCommand,
  start: () => host || startHost(),
  count: () => tabs.size,
};
