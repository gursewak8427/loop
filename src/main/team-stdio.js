#!/usr/bin/env node
// Loop's team tools for sessions on a server, with no Loop around them.
//
// On a PC, Loop serves a project's memory, board and team to its sessions. A
// server keeps its own, apart from the PC's: this runs there as a stdio MCP
// server that Claude Code starts for every session (user scope in
// ~/.claude.json), and works on
//   ~/.loop/memory/<project>/            notes and board, laid out as on the PC
//   ~/.loop/memory/<project>/team.json   the team, written once from Loop
//   ~/.loop/memory/company.json          the company's rules
// Nothing here talks to the PC, so the team keeps working while it is off.
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn, execFileSync } = require('child_process');
const memory = require('./memory');
const { readLive, encodePath, UUID_RE } = require('./scanner');

const HOME = os.homedir();
const ROOT = process.env.LOOP_MEMORY || path.join(HOME, '.loop', 'memory');
const CLAUDE = process.env.LOOP_CLAUDE || path.join(HOME, '.local', 'bin', 'claude');
memory.useRoot(ROOT);

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};

// The project: the nearest folder, from where the session works upwards, that
// has memory here. A session in a sub-folder still belongs to the project.
function projectOf(cwd) {
  const start = path.resolve(cwd);
  for (let dir = start; ; dir = path.dirname(dir)) {
    if (memory.projectFolderSync(encodePath(dir)) || fs.existsSync(path.join(ROOT, encodePath(dir)))) return { dir: encodePath(dir), path: dir };
    if (path.dirname(dir) === dir) return { dir: encodePath(start), path: start };
  }
}
const here = projectOf(process.cwd());

const teamOf = (dir) => {
  const t = readJson(path.join(memory.projectFolderSync(dir) || path.join(ROOT, dir), 'team.json'), null);
  return t && t.members && Array.isArray(t.roles) ? t : null;
};
const nameOf = (t, id) => ((t && t.names) || {})[id] || id.slice(0, 8);

memory.setTeamLookup(teamOf);
memory.setCompanyLookup(() => readJson(path.join(ROOT, 'company.json'), {}));
memory.setProfileLookup((id) => {
  const t = teamOf(here.dir);
  return { role: ((t && t.profiles) || {})[id] || '', name: ((t && t.names) || {})[id] || '' };
});

// Which session this is: the Claude Code process that started this server
// keeps a record of itself, named by its pid.
const NOBODY = '00000000-0000-4000-8000-000000000000';
let me = null;
function whoAmI() {
  if (me) return me;
  const o = readJson(path.join(HOME, '.claude', 'sessions', `${process.ppid}.json`), null);
  if (o && UUID_RE.test(o.sessionId || '')) me = o.sessionId;
  return me || NOBODY;
}

// Start a teammate that is not running, on the message, the way a phone call
// wakes someone. It works in the background and ends when its turn does.
function wake(id, text) {
  const logs = path.join(HOME, '.loop', 'logs');
  fs.mkdirSync(logs, { recursive: true });
  const out = fs.openSync(path.join(logs, `${id}.log`), 'a');
  const root = typeof process.getuid === 'function' && process.getuid() === 0;
  // As root Claude Code will not skip permission prompts; auto mode is the nearest.
  const args = ['-p', text, '--resume', id, root ? '--permission-mode' : '--dangerously-skip-permissions', ...(root ? ['auto'] : [])];
  const child = spawn(CLAUDE, args, { cwd: here.path, detached: true, stdio: ['ignore', out, out], env: { ...process.env, CLAUDE_CODE_MCP_STARTUP_WAIT_MS: '0' } });
  child.on('error', () => {});
  child.unref();
}

// team_manage. The team itself is changed from Loop; here a member reaches a teammate.
async function teamDo(q) {
  if (q.action !== 'tell' && q.action !== 'wake') return 'On this server the team is changed from Loop. Here you can tell or wake a teammate (action tell, session their name, text what you need).';
  const t = teamOf(q.dir);
  if (!t) return 'This project has no team on this server.';
  const want = String(q.session || '').toLowerCase();
  const ids = Object.keys(t.members);
  const id =
    ids.find((x) => nameOf(t, x).toLowerCase() === want) ||
    ids.find((x) => want && x.startsWith(want)) ||
    ids.find((x) => want && nameOf(t, x).toLowerCase().includes(want));
  if (!id) return `No teammate called "${q.session}". The team: ${ids.map((x) => `"${nameOf(t, x)}"`).join(', ')}.`;
  if (id === q.me) return 'That is you.';
  const said = q.text || (q.action === 'wake' ? 'Call role_brief and task_list, then carry on with your tickets.' : '');
  if (!said) return 'Say what you need in text.';
  const msg = `Message from your teammate "${nameOf(t, q.me)}": ${said}`;
  const live = (await readLive()).find((l) => l.sessionId === id);
  if (live) {
    // Open in a Loop terminal on this server: typed into it.
    const tm = 'loop-' + id.slice(0, 13);
    try {
      execFileSync('tmux', ['has-session', '-t', tm], { stdio: 'ignore' });
      execFileSync('tmux', ['send-keys', '-t', tm, '-l', msg.replace(/\s+/g, ' ')]);
      execFileSync('tmux', ['send-keys', '-t', tm, 'Enter']);
      return `Told "${nameOf(t, id)}" in its terminal.`;
    } catch {
      return `"${nameOf(t, id)}" is busy in another session on this server right now. Try again in a few minutes.`;
    }
  }
  wake(id, msg);
  return `Woke "${nameOf(t, id)}" with your message. It works on it now and answers you the same way when done.`;
}
memory.setTeamDo(teamDo);

// The MCP conversation: one JSON-RPC message per line.
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const one = async (m) => (m.id === undefined || m.id === null ? null : memory.handleRpc(m, { dir: here.dir, sessionId: whoAmI() }));
  const out = Array.isArray(msg) ? (await Promise.all(msg.map(one))).filter(Boolean) : await one(msg);
  if (out && (!Array.isArray(out) || out.length)) process.stdout.write(JSON.stringify(out) + '\n');
});
