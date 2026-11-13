// Reads Claude Code's on-disk state: saved transcripts (projects/*/*.jsonl)
// and the live session registry (sessions/<pid>.json).
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const shell = require('./shell');

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');

const TAIL_BYTES = 256 * 1024;
const HEAD_BYTES = 96 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Claude Code names a project folder after its cwd with every
// non-alphanumeric character replaced by a dash.
const encodePath = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');

const metaCache = new Map(); // file -> { mtimeMs, size, meta }
const dirCache = new Map(); // project folder name -> resolved cwd | null

async function isDir(p) {
  try {
    return (await fsp.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

// Where the walk for a project folder starts, and what is left to match:
// D--Work-app is D:\ then Work-app, -Users-me-app is / then Users-me-app.
function rootOf(dirName, platform = process.platform) {
  if (shell.isWin(platform)) {
    const m = /^([A-Za-z])--(.*)$/.exec(dirName);

    return m ? { root: `${m[1].toUpperCase()}:\\`, rest: m[2] } : null;
  }

  return dirName.startsWith('-') ? { root: '/', rest: dirName.slice(1) } : null;
}

// The encoding is lossy, so walk the filesystem to find the folder whose
// encoded path matches.
async function resolveFromDisk(dirName) {
  const start = rootOf(dirName);
  if (!start) return null;
  const walk = async (dir, rest) => {
    if (rest === '') return dir;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    const lower = rest.toLowerCase();
    const candidates = entries
      .filter((e) => e.isDirectory())
      .map((e) => ({ name: e.name, enc: encodePath(e.name).toLowerCase() }))
      .filter((c) => lower === c.enc || lower.startsWith(c.enc + '-'))
      .sort((a, b) => b.enc.length - a.enc.length);
    for (const c of candidates) {
      const next = path.join(dir, c.name);
      if (lower === c.enc) return next;
      const found = await walk(next, rest.slice(c.enc.length + 1));
      if (found) return found;
    }
    return null;
  };
  return walk(start.root, start.rest);
}

async function resolveProjectPath(dirName, cwdHints) {
  if (dirCache.has(dirName)) return dirCache.get(dirName);
  let resolved = null;
  for (const hint of cwdHints) {
    if (hint && encodePath(hint).toLowerCase() === dirName.toLowerCase() && (await isDir(hint))) {
      resolved = hint;
      break;
    }
  }
  if (!resolved) resolved = await resolveFromDisk(dirName);
  if (resolved) dirCache.set(dirName, resolved);
  return resolved;
}

async function readChunk(file, position, length) {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, position);
    return buf.toString('utf8', 0, bytesRead);
  } finally {
    await fh.close();
  }
}

const jsonField = (line, key) => {
  const m = new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`).exec(line);
  if (!m) return null;
  try {
    return JSON.parse(`"${m[1]}"`);
  } catch {
    return null;
  }
};

const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

async function readSessionMeta(file, stat) {
  const hit = metaCache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.meta;

  const meta = { customTitle: null, agentName: null, aiTitle: null, lastPrompt: null, firstPrompt: null, cwd: null, model: null, entrypoint: null };
  const tailLen = Math.min(stat.size, TAIL_BYTES);
  const tail = await readChunk(file, stat.size - tailLen, tailLen);
  const lines = tail.split('\n');
  if (tailLen < stat.size) lines.shift(); // first line is cut mid-record

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    if (line.length < 8192) {
      if (!meta.customTitle && line.startsWith('{"type":"custom-title"')) meta.customTitle = jsonField(line, 'customTitle');
      else if (!meta.agentName && line.startsWith('{"type":"agent-name"')) meta.agentName = jsonField(line, 'agentName');
      else if (!meta.aiTitle && line.startsWith('{"type":"ai-title"')) meta.aiTitle = jsonField(line, 'aiTitle');
      else if (!meta.lastPrompt && line.startsWith('{"type":"last-prompt"')) {
        const lp = jsonField(line, 'lastPrompt');
        if (lp && !/^[#<]/.test(lp.trim())) meta.lastPrompt = lp; // skip injected notices
      }
    }
    if (!meta.cwd && line.includes('"cwd":"')) meta.cwd = jsonField(line, 'cwd');
    // Who wrote to it last: a terminal (cli), a program (sdk-cli) or the Claude app (claude-desktop).
    if (!meta.entrypoint) {
      const ep = /"entrypoint":"([a-z-]{1,40})"/.exec(line);
      if (ep) meta.entrypoint = ep[1];
    }
    // The model of the newest real reply ("<synthetic>" marks Claude Code's own notices).
    if (!meta.model && line.includes('"type":"assistant"')) {
      const m = /"role":"assistant","model":"([^"]{1,100})"/.exec(line) || /"message":\{[^{}]*?"model":"([^"]{1,100})"/.exec(line);
      if (m && m[1] !== '<synthetic>') meta.model = m[1];
    }
    if (meta.customTitle && meta.aiTitle && meta.lastPrompt && meta.cwd && meta.model && meta.entrypoint) break;
  }

  // A long session can end in bookkeeping lines with no reply among them: look
  // further back for the newest reply, a megabyte at a time, up to four.
  for (let end = stat.size - tailLen, read = 0; !meta.model && end > 0 && read < 4; read++) {
    const len = Math.min(end, 1024 * 1024);
    const chunk = await readChunk(file, end - len, len + 512); // a little overlap, so no reply is cut in two
    let last = null;
    for (const m of chunk.matchAll(/"message":\{"model":"([^"]{1,100})"[^{}]{0,300}?"role":"assistant"|"role":"assistant","model":"([^"]{1,100})"/g)) {
      const model = m[1] || m[2];
      if (model !== '<synthetic>') last = model;
    }
    meta.model = last;
    end -= len;
  }

  if (!meta.customTitle && !meta.agentName && !meta.aiTitle && !meta.lastPrompt) {
    const head = await readChunk(file, 0, Math.min(stat.size, HEAD_BYTES));
    for (const line of head.split('\n')) {
      if (!meta.cwd && line.includes('"cwd":"')) meta.cwd = jsonField(line, 'cwd');
      if (!line.includes('"type":"user"')) continue;
      try {
        const rec = JSON.parse(line);
        const c = rec.message && rec.message.content;
        const text = typeof c === 'string' ? c : Array.isArray(c) ? (c.find((p) => p.type === 'text') || {}).text : null;
        if (text && !/^[#<]/.test(text.trim())) {
          meta.firstPrompt = text;
          break;
        }
      } catch {
        // cut-off or oversized line
      }
    }
  }

  for (const k of ['customTitle', 'agentName', 'aiTitle', 'lastPrompt', 'firstPrompt']) {
    if (meta[k]) meta[k] = clean(meta[k]).slice(0, 240);
  }
  metaCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, meta });
  return meta;
}

async function scanProject(dirName) {
  const dir = path.join(PROJECTS_DIR, dirName);
  let names;
  try {
    names = await fsp.readdir(dir);
  } catch {
    return null;
  }
  const sessions = [];
  const cwdHints = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const id = name.slice(0, -6);
    if (!UUID_RE.test(id)) continue;
    const file = path.join(dir, name);
    try {
      const stat = await fsp.stat(file);
      const meta = await readSessionMeta(file, stat);
      if (meta.cwd) cwdHints.push(meta.cwd);
      const title = meta.customTitle || meta.agentName || meta.aiTitle || meta.lastPrompt || meta.firstPrompt;
      const started = new Date(stat.birthtimeMs || stat.mtimeMs).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
      sessions.push({
        id,
        title: title || `Session from ${started}`,
        named: Boolean(meta.customTitle || meta.agentName),
        titled: Boolean(meta.customTitle || meta.agentName || meta.aiTitle),
        // The Claude desktop app has it now (/desktop moves a session there): it is that app's, not Loop's.
        inApp: meta.entrypoint === 'claude-desktop',
        lastPrompt: meta.lastPrompt || meta.firstPrompt || '',
        model: meta.model || '',
        mtime: stat.mtimeMs,
        size: stat.size,
        empty: !title && stat.size < 40000, // opened and closed without real work
      });
    } catch {
      // file vanished or is locked; skip it this round
    }
  }
  if (!sessions.length) return null;
  sessions.sort((a, b) => b.mtime - a.mtime);
  const resolved = await resolveProjectPath(dirName, cwdHints);
  return {
    dir: dirName,
    path: resolved,
    exists: Boolean(resolved),
    name: resolved ? path.basename(resolved) || resolved : dirName,
    sessions,
    mtime: sessions[0].mtime,
  };
}

async function scanProjects() {
  let dirs;
  try {
    dirs = (await fsp.readdir(PROJECTS_DIR, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  const projects = (await Promise.all(dirs.map(scanProject))).filter(Boolean);
  projects.sort((a, b) => b.mtime - a.mtime);
  return projects;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// A session that was killed leaves its registry file behind, and the system
// reuses process ids. So a live pid is not enough: the process behind it has
// to be Claude. Process names are looked up in one batch and cached briefly.
let procNames = new Map();
let procNamesAt = 0;
let procNamesBusy = null;

function refreshProcNames() {
  if (procNamesBusy) return procNamesBusy;
  procNamesBusy = new Promise((resolve) => {
    const [cmd, args] = shell.processListCommand();
    execFile(cmd, args, { windowsHide: true, timeout: 8000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (!err) {
        const next = shell.parseProcessList(stdout);
        if (next.size) {
          procNames = next;
          procNamesAt = Date.now();
        }
      }
      procNamesBusy = null;
      resolve();
    });
  });
  return procNamesBusy;
}

const looksLikeClaude = (name) => /claude|node|bun/.test(name);

// true / false when known, null when the process list has not seen this pid yet
function isClaudeProcess(pid) {
  const name = procNames.get(pid);
  return name === undefined ? null : looksLikeClaude(name);
}

// Sessions that are running right now, anywhere on this machine.
async function readLive() {
  let names;
  try {
    names = await fsp.readdir(SESSIONS_DIR);
  } catch {
    return [];
  }
  // Listing processes is slow on Windows (about 2s of work), so it is never awaited
  // here and only redone when a session shows up that the last list did not have.
  let unknown = false;
  const live = [];
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    try {
      const o = JSON.parse(await fsp.readFile(path.join(SESSIONS_DIR, name), 'utf8'));
      if (!o.sessionId || !pidAlive(o.pid)) continue;
      // A pid newer than the cached process list gets the benefit of the doubt.
      const known = isClaudeProcess(o.pid);
      if (known === false) continue;
      if (known === null) unknown = true;
      live.push({
        sessionId: o.sessionId,
        pid: o.pid,
        name: o.name || '',
        status: o.status || 'idle',
        cwd: o.cwd || '',
        entrypoint: o.entrypoint || '',
        startedAt: o.startedAt || 0,
      });
    } catch {
      // being rewritten; next poll picks it up
    }
  }
  const age = Date.now() - procNamesAt;
  if (age > 120000 || (unknown && age > 4000)) refreshProcNames();
  live.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  return live;
}

// Fresh check, for the one place where being wrong would stop someone else's process.
async function isClaudePid(pid) {
  await refreshProcNames();
  return /claude/.test(procNames.get(pid) || '');
}

// The last few turns of a saved session, for a look before opening it.
async function peek(dirName, sessionId, opts = {}) {
  if (!/^[A-Za-z0-9_-]+$/.test(dirName) || !UUID_RE.test(sessionId)) return [];
  const file = path.join(PROJECTS_DIR, dirName, sessionId + '.jsonl');
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch {
    return [];
  }
  const len = Math.min(stat.size, 768 * 1024);
  const lines = (await readChunk(file, stat.size - len, len)).split('\n');
  if (len < stat.size) lines.shift();
  const turns = [];
  const most = opts.tools ? 40 : 8;
  for (let i = lines.length - 1; i >= 0 && turns.length < most; i--) {
    const line = lines[i];
    if (line.length > 300000 || !(line.includes('"type":"user"') || line.includes('"type":"assistant"'))) continue;
    try {
      const rec = JSON.parse(line);
      if ((rec.type !== 'user' && rec.type !== 'assistant') || rec.isMeta || rec.isSidechain || !rec.message) continue;
      const c = rec.message.content;
      const text =
        typeof c === 'string'
          ? c
          : Array.isArray(c)
            ? c
                .filter((p) => p.type === 'text')
                .map((p) => p.text)
                .join('\n')
            : '';
      // Asked for, the tools a turn used come too, newest last like the rest:
      // Home reads a hand-over (team_manage) from them.
      if (opts.tools && rec.type === 'assistant' && Array.isArray(c)) {
        for (const p of c.filter((x) => x.type === 'tool_use').reverse()) turns.push({ role: 'tool', name: String(p.name || ''), text: p.input && p.input.action ? String(p.input.action) : '', at: Date.parse(rec.timestamp) || 0 });
      }
      const t = text.trim();
      if (!t || t.startsWith('<')) continue; // tool results and injected notices
      turns.push({ role: rec.type, text: t.length > 1500 ? t.slice(0, 1500) + ' …' : t, at: Date.parse(rec.timestamp) || 0 });
    } catch {
      // cut-off line
    }
  }
  return turns.reverse();
}

module.exports = { resolveProjectPath, scanProjects, readLive, isClaudePid, peek, encodePath, rootOf, UUID_RE, CLAUDE_DIR };
