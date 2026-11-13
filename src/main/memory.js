// Team memory. Every project has shared notes; every session (a team member)
// has its own knowledge base. Notes are plain markdown files, so they can be
// read, edited and versioned outside the app. Where they live is in
// memory-layout.js:
//
//   <root>/company/<note>.md
//   <root>/projects/<project>/shared/<note>.md
//   <root>/projects/<project>/sessions/<session>--<id>/<note>.md
//
// Memory belongs to the session, not to the agent working in it, so every
// agent a session uses reads and writes the same notes.
// The root is a folder the user picks. It holds nothing but these files, so
// it can be copied, moved or put on a USB stick and pointed at again.
// Claude Code's own per-project memory files are read alongside (never
// written) so that what a project already knows is searchable from day one.
//
// Sessions reach memory through a local MCP server and get back only the
// passages that match, trimmed to a token budget, instead of whole files.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { readLive, encodePath, UUID_RE, CLAUDE_DIR } = require('./scanner');
const layout = require('./memory-layout');

let ROOT = null;
let MCP_DIR = null;
let server = null;
let port = 0;
const secret = crypto.randomBytes(18).toString('hex');
const cache = new Map(); // project dir -> notes[]
let profileOf = () => ({}); // sessionId -> { role, name } as set by the user in the app

layout.attach(() => ROOT);
const INDEX = 'loop.md'; // the list of a folder's notes, kept by Loop and read first
const safeDir = (dir) => /^[A-Za-z0-9_-]+$/.test(dir);
const estimateTokens = (text) => Math.ceil((text || '').length / 3.7);

// ---------- text processing ----------

const STOP = new Set(
  'a an the and or of to in on for with is are was were be been it this that as at by from not but if then so we you i they them our your its into about can will just do does did have has had'.split(
    ' ',
  ),
);

function stem(t) {
  if (t.length > 5 && t.endsWith('ing')) return t.slice(0, -3);
  if (t.length > 4 && t.endsWith('ed')) return t.slice(0, -2);
  if (t.length > 4 && t.endsWith('es')) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) return t.slice(0, -1);
  return t;
}

function terms(text) {
  return (text || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // camelCase -> camel Case
    .toLowerCase()
    .split(/[^a-z0-9ऀ-ॿ]+/)
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map(stem);
}

// Split a note into passages of roughly 220 tokens along paragraph breaks.
function chunk(body) {
  const out = [];
  let cur = '';
  const paras = [];
  for (const para of (body || '').split(/\n\s*\n/)) {
    if (estimateTokens(para) <= 300) {
      paras.push(para);
      continue;
    }
    // A wall of text: cut it at line and sentence ends so no passage is huge.
    let piece = '';
    for (const bit of para.split(/(?<=[.!?])\s+|\n/)) {
      if (piece && estimateTokens(piece) + estimateTokens(bit) > 220) {
        paras.push(piece);
        piece = '';
      }
      piece = piece ? piece + ' ' + bit : bit;
    }
    if (piece) paras.push(piece);
  }
  for (const para of paras) {
    const p = para.trim();
    if (!p) continue;
    if (cur && estimateTokens(cur) + estimateTokens(p) > 220) {
      out.push(cur);
      cur = '';
    }
    cur = cur ? cur + '\n\n' + p : p;
  }
  if (cur) out.push(cur);
  return out.length ? out : [''];
}

// ---------- storage ----------

function parseNote(raw, file, scope) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  const head = {};
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const i = line.indexOf(':');
      if (i > 0) head[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
  const unquote = (s) => (s || '').replace(/^"(.*)"$/, '$1');
  const description = unquote(head.description);
  const body = ((description ? description + '\n\n' : '') + (m ? m[2] : raw)).trim();
  const id = path.basename(file, '.md');
  const title = unquote(head.title) || unquote(head.name).replace(/-/g, ' ') || id;
  return {
    id,
    scope,
    file,
    title,
    body,
    tags: (head.tags || '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
    author: head.author || '',
    updated: Date.parse(head.updated || head.modified) || 0,
    tokens: estimateTokens(title + '\n' + body),
  };
}

const serialize = (n) =>
  `---\ntitle: ${n.title.replace(/\r?\n/g, ' ')}\ntags: ${n.tags.join(', ')}\nauthor: ${n.author.replace(/\r?\n/g, ' ')}\nupdated: ${new Date(n.updated).toISOString()}\n---\n\n${n.body.trim()}\n`;

async function readNotesIn(folder, scope) {
  let names;
  try {
    names = await fsp.readdir(folder);
  } catch {
    return [];
  }
  const notes = [];
  for (const name of names) {
    if (!name.endsWith('.md') || name === INDEX) continue;
    const file = path.join(folder, name);
    try {
      notes.push(parseNote(await fsp.readFile(file, 'utf8'), file, scope));
    } catch {
      // unreadable file; leave it for the user to look at
    }
  }
  return notes;
}

async function loadProject(dir) {
  if (!safeDir(dir)) throw new Error('Invalid project');
  if (cache.has(dir)) return cache.get(dir);
  await layout.ready();
  const shared = await layout.sharedDir(dir, { create: false });
  const notes = shared ? await readNotesIn(shared, 'project') : [];
  if (shared) await indexIfMissing(shared, notes, 'project');
  // The company's own shelf: one folder beside the projects, read from every
  // project, so a policy or a document is written once and found everywhere.
  const company = await readNotesIn(layout.companyDir(), 'company');
  await indexIfMissing(layout.companyDir(), company, 'company');
  for (const n of company) n.id = 'co-' + n.id;
  notes.push(...company);
  for (const m of await layout.sessionDirs(dir)) {
    const mine = await readNotesIn(m.folder, m.id);
    await indexIfMissing(m.folder, mine, m.id);
    notes.push(...mine);
  }
  // Claude Code's own memory for this project: read-only here.
  const own = (await readNotesIn(path.join(CLAUDE_DIR, 'projects', dir, 'memory'), 'claude')).filter((n) => n.id !== 'MEMORY');
  for (const n of own) {
    n.id = 'claude-' + n.id;
    n.readOnly = true;
    n.author = 'Claude Code';
    if (!n.updated) n.updated = fs.statSync(n.file).mtimeMs;
  }
  notes.push(...own);
  notes.sort((a, b) => b.updated - a.updated);
  cache.set(dir, notes);
  return notes;
}

const headingOf = (scope) => (scope === 'company' ? 'Company memory' : scope === 'project' ? 'Project memory, shared by every session' : 'This session\'s memory');

// Rewrites a folder's loop.md from the notes in it.
async function reindex(folder, scope) {
  await layout.writeIndex(folder, headingOf(scope), await readNotesIn(folder, scope));
}

async function indexIfMissing(folder, notes, scope) {
  if (!notes.length || fs.existsSync(path.join(folder, INDEX))) return;
  await layout.writeIndex(folder, headingOf(scope), notes).catch(() => {});
}

const statsOf = (notes) => ({ notes: notes.length, tokens: notes.reduce((n, x) => n + x.tokens, 0) });
const publicNote = ({ file, ...n }) => n;
const inScope = (notes, scope) => notes.filter((n) => n.scope === scope);

const countsOf = (all) => {
  const byScope = {};
  for (const n of all) byScope[n.scope] = (byScope[n.scope] || 0) + 1;
  return { project: byScope.project || 0, claude: byScope.claude || 0, company: byScope.company || 0, byScope };
};

async function list(dir, scope) {
  const all = await loadProject(dir);
  const notes = inScope(all, scope);
  return { notes: notes.map(publicNote), stats: statsOf(notes), counts: countsOf(all) };
}

async function saveNote({ dir, scope, id, title, body, tags, author }) {
  if (scope !== 'project' && scope !== 'company' && !UUID_RE.test(scope || '')) throw new Error('Invalid scope');
  const notes = await loadProject(dir);
  const existing = id ? notes.find((n) => n.id === id && !n.readOnly) : null;
  const folder = scope === 'company' ? layout.companyDir() : scope === 'project' ? await layout.sharedDir(dir) : await layout.sessionDir(dir, scope, { create: true });
  let file;
  if (existing) file = existing.file;
  else {
    let slug =
      (title || 'note')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48) || 'note';
    if (slug === 'loop' || slug === 'readme') slug += '-note'; // loop.md is the folder's index
    file = path.join(folder, `${slug}.md`);
    for (let n = 2; fs.existsSync(file); n++) file = path.join(folder, `${slug}-${n}.md`);
  }
  const note = {
    title: (title || 'Untitled note').trim().slice(0, 160),
    body: String(body || ''),
    tags: (tags || [])
      .map((t) => String(t).trim().replace(/,/g, ' '))
      .filter(Boolean)
      .slice(0, 12),
    author: author || (existing && existing.author) || '',
    updated: Date.now(),
  };
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, serialize(note));
  await reindex(path.dirname(file), scope);
  cache.delete(dir);
  return path.basename(file, '.md');
}

async function removeNote({ dir, id }) {
  const note = (await loadProject(dir)).find((n) => n.id === id);
  if (!note || note.readOnly) return false;
  await fsp.rm(note.file, { force: true });
  await reindex(path.dirname(note.file), note.scope);
  cache.delete(dir);
  return true;
}

// BM25 over passages; a note ranks by its best passage.
function rank(notes, query) {
  const q = [...new Set(terms(query))];
  if (!q.length) return [];
  const docs = [];
  for (const note of notes) {
    const titleTerms = terms(note.title + ' ' + note.tags.join(' '));
    for (const text of chunk(note.body)) {
      const t = [...titleTerms, ...titleTerms, ...terms(text)]; // title and tags count double
      const tf = new Map();
      for (const w of t) tf.set(w, (tf.get(w) || 0) + 1);
      docs.push({ note, text, tf, len: t.length });
    }
  }
  if (!docs.length) return [];
  const avg = docs.reduce((n, d) => n + d.len, 0) / docs.length || 1;
  const k1 = 1.4;
  const b = 0.75;
  const idf = new Map(
    q.map((w) => {
      const df = docs.filter((d) => d.tf.has(w)).length;
      return [w, Math.log(1 + (docs.length - df + 0.5) / (df + 0.5))];
    }),
  );
  const best = new Map();
  for (const d of docs) {
    let score = 0;
    for (const w of q) {
      const f = d.tf.get(w);
      if (f) score += (idf.get(w) * (f * (k1 + 1))) / (f + k1 * (1 - b + (b * d.len) / avg));
    }
    if (score <= 0) continue;
    const cur = best.get(d.note.id);
    if (!cur) best.set(d.note.id, { note: d.note, score, passages: [{ text: d.text, score }] });
    else {
      cur.score = Math.max(cur.score, score);
      cur.passages.push({ text: d.text, score });
    }
  }
  return [...best.values()].map((r) => ({ ...r, passages: r.passages.sort((x, y) => y.score - x.score) })).sort((x, y) => y.score - x.score);
}

async function search(dir, scope, query) {
  const all = await loadProject(dir);
  const notes = inScope(all, scope);
  const hits = rank(notes, query);
  return { notes: hits.map((r) => ({ ...publicNote(r.note), snippet: r.passages[0].text })), stats: statsOf(notes), counts: countsOf(all) };
}

// ---------- task board: who is doing what in a project ----------

const STATUSES = ['todo', 'doing', 'review', 'blocked', 'done'];
let onBoard = () => {}; // told the project whenever its board changes, so an open board redraws
let teamDo = async () => 'Loop cannot change the team right now.'; // carries a team_manage request to the app
let waDo = async () => 'WhatsApp is not set up in Loop.'; // whatsapp_listen, answered by whatsapp.js
let teamOf = () => null; // project dir -> { roles: [{ key, title, manages }], members: { sessionId: key } }
let companyOf = () => ({}); // the company as the user set it in Loop: { rules, checkMins }
let subOf = () => null; // sessionId -> { parent, task } when it is a sub-session

// Who may do what on a project's board. With a project manager on the team,
// the manager alone adds, assigns and edits tickets; everyone else comments
// and moves the tickets assigned to them. Without one the board is open to all.
function boardRights(team, me) {
  const roles = (team && team.roles) || [];
  const members = (team && team.members) || {};
  const manages = (key) => roles.some((r) => r.key === key && r.manages);
  const managers = Object.keys(members).filter((id) => manages(members[id]));
  return { managed: managers.length > 0, manager: manages(members[me]), managers };
}

const isMine = (task, me, myName) => (task.assigneeId ? task.assigneeId === me : Boolean(task.assignee) && task.assignee.toLowerCase() === String(myName).toLowerCase());
const boardFile = async (dir, create) => {
  await layout.ready();
  const proj = await layout.projectDir(dir, { create });
  return proj && path.join(proj, 'board.json');
};

async function boardLoad(dir) {
  if (!safeDir(dir)) throw new Error('Invalid project');
  try {
    const file = await boardFile(dir, false);
    if (!file) return { seq: 0, tasks: [] };
    const b = JSON.parse(await fsp.readFile(file, 'utf8'));
    return { seq: b.seq || 0, tasks: Array.isArray(b.tasks) ? b.tasks : [] };
  } catch {
    return { seq: 0, tasks: [] };
  }
}

async function boardSave(dir, board) {
  const file = await boardFile(dir, true);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(board, null, 2));
  await fsp.rename(tmp, file);
  onBoard(dir);
}

// A column is a queue: the one at the top is the one to take next. Tickets
// without a rank yet (made before this) fall in under the ranked ones, newest
// first, so an old board still reads sensibly.
const rankOf = (t) => (typeof t.rank === 'number' ? t.rank : Number.MAX_SAFE_INTEGER);
const sortTasks = (tasks) =>
  tasks.slice().sort((a, b) => STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status) || rankOf(a) - rankOf(b) || b.updated - a.updated);

// Where a new ticket goes: the bottom of its column.
const nextRank = (tasks, status) => Math.max(0, ...tasks.filter((t) => t.status === status).map((t) => rankOf(t)).filter((r) => r < Number.MAX_SAFE_INTEGER)) + 1;

async function taskList(dir) {
  return sortTasks((await boardLoad(dir)).tasks);
}

async function taskAdd(dir, { title, details, assignee, assigneeId, by }) {
  const board = await boardLoad(dir);
  const task = {
    id: 'T' + ++board.seq,
    title: String(title || 'Untitled task')
      .trim()
      .slice(0, 200),
    details: String(details || '').trim(),
    assignee: String(assignee || '')
      .trim()
      .slice(0, 80),
    assigneeId: assignee && UUID_RE.test(assigneeId || '') ? assigneeId : '',
    status: 'todo',
    rank: nextRank(board.tasks, 'todo'),
    progress: 0,
    createdBy: by || '',
    created: Date.now(),
    updated: Date.now(),
    notes: [],
  };
  board.tasks.push(task);
  await boardSave(dir, board);
  return task;
}

async function taskUpdate(dir, id, change, by) {
  const board = await boardLoad(dir);
  const task = board.tasks.find((t) => t.id.toLowerCase() === String(id).toLowerCase());
  if (!task) return null;
  // What happened to a ticket is worth as much as what it says: a move or a
  // handover is written down beside the comments, by whoever did it.
  const log = (text, kind) => task.notes.push({ by: by || '', at: Date.now(), kind, text });
  if (change.status && STATUSES.includes(change.status) && change.status !== task.status) {
    log(`moved it from ${task.status} to ${change.status}`, 'status');
    // Moving column puts it at the bottom of the new one, unless it is being
    // ranked in the same breath.
    task.rank = nextRank(board.tasks.filter((t) => t !== task), change.status);
    task.status = change.status;
    if (change.status === 'done') task.progress = 100;
  }
  // How far along it is, as the one doing it sees it.
  if (change.progress !== undefined && change.progress !== null && change.progress !== '') {
    const pc = Math.max(0, Math.min(100, Math.round(Number(change.progress))));
    if (Number.isFinite(pc) && pc !== (task.progress || 0)) {
      log(`moved it to ${pc}% done`, 'progress');
      task.progress = pc;
    }
  }
  // Where it sits in its column: the top is what the next free teammate takes.
  if (change.rank === 'top' || change.rank === 'bottom' || typeof change.rank === 'number') {
    const others = board.tasks.filter((t) => t !== task && t.status === task.status);
    task.rank = change.rank === 'top' ? Math.min(0, ...others.map(rankOf)) - 1 : change.rank === 'bottom' ? nextRank(board.tasks.filter((t) => t !== task), task.status) : Number(change.rank);
    if (change.rank === 'top') log('put it at the top of the column', 'rank');
  }
  if (change.title !== undefined) task.title = String(change.title).trim().slice(0, 200) || task.title;
  if (change.details !== undefined) task.details = String(change.details).trim();
  if (change.assignee !== undefined) {
    const now = String(change.assignee).trim().slice(0, 80);
    if (now !== task.assignee) log(now ? `gave it to ${now}` : `took it off ${task.assignee || 'nobody'}`, 'assign');
    task.assignee = now;
    task.assigneeId = task.assignee && UUID_RE.test(change.assigneeId || '') ? change.assigneeId : '';
  }
  if (change.note) log(String(change.note).trim().slice(0, 2000));
  if (task.notes.length > 60) task.notes = task.notes.slice(-60);
  task.updated = Date.now();
  await boardSave(dir, board);
  return task;
}

async function taskRemove(dir, id) {
  const board = await boardLoad(dir);
  const before = board.tasks.length;
  board.tasks = board.tasks.filter((t) => t.id !== id);
  if (board.tasks.length !== before) await boardSave(dir, board);
  return board.tasks.length !== before;
}

function taskLine(t, full = false) {
  const said = t.notes.filter((n) => !n.kind);
  const last = said[said.length - 1];
  const how = t.status === 'doing' && t.progress ? `, ${t.progress}% done` : '';
  return [
    `${t.id} [${t.status}${how}] ${t.title}${t.assignee ? ` (assigned to ${t.assignee})` : ' (unassigned)'}`,
    t.details ? '   ' + t.details.replace(/\s+/g, ' ').slice(0, full ? 2000 : 240) : null,
    last ? `   latest note, ${last.by || 'someone'}: ${last.text.replace(/\s+/g, ' ').slice(0, 240)}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

// ---------- MCP server for the sessions ----------

const INSTRUCTIONS = [
  'The team of this project (its roles, and which session holds each) is set by the user in Loop and can change: for any question about the team, call team_info, which reads it from Loop as it is now, and answer from its result, never from what this conversation or your notes remember.',
  'Loop team memory. It survives restarts and is the only memory shared between the sessions working on this project.',
  'Two scopes: "project" is shared by every session in the project; "mine" is your own knowledge base as one member of the team.',
  'Before unfamiliar work, call memory_search with a few keywords; it returns only matching passages within a token budget.',
  'When you learn something that will still matter in a later session (a decision and its reason, where something lives, a fix for a recurring problem, a preference of the user), save it with memory_save. Use "project" when teammates need it, "mine" for knowledge specific to your role.',
  'The project also has a board of tickets (task_list, task_add, task_update): check it when you start and keep the status of your own tickets current so teammates and the user can see progress. If the project has a project manager, they alone add, assign and edit tickets; everyone else comments on tickets and moves the ones assigned to them, and asks the manager for anything else.',
  'Keep each note to one topic with a specific title. Update an existing note (pass its id) instead of saving a near-duplicate. Never store passwords, keys or tokens.',
].join(' ');

const TOOLS = [
  {
    name: 'memory_search',
    description: 'Search team memory by keywords. Returns the best-matching passages, most relevant first, trimmed to a token budget.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords or a short question' },
        scope: {
          type: 'string',
          enum: ['all', 'project', 'company', 'mine', 'team', 'parent'],
          description:
            "all (default): project + your notes + teammates' notes + the company shelf + Claude Code's own saved memory for this project. company: the company's knowledge base, documents and policies, the same in every project. team: only teammates' knowledge bases. parent: for a sub-session, the notes of the main session that started it.",
        },
        max_tokens: { type: 'number', description: 'Budget for the reply, default 1200' },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_save',
    description:
      'Save a note, or update one by passing its id. Scope "project" is shared with every session in this project; "mine" is your own knowledge base; "company" is the company shelf (knowledge base, documents, policies) that every project reads, and only the CEO may write there.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Specific, searchable title' },
        content: { type: 'string', description: 'The note in markdown. One topic, concise.' },
        scope: { type: 'string', enum: ['project', 'company', 'mine'] },
        tags: { type: 'array', items: { type: 'string' } },
        id: { type: 'string', description: 'Id of an existing note to replace' },
      },
      required: ['title', 'content', 'scope'],
    },
  },
  {
    name: 'memory_list',
    description: 'List note titles with ids and sizes, without their content. Cheap way to see what memory holds.',
    inputSchema: { type: 'object', properties: { scope: { type: 'string', enum: ['all', 'project', 'company', 'mine', 'team', 'parent'] } } },
  },
  {
    name: 'memory_read',
    description: 'Read one note in full by id.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'task_list',
    description: 'Show the project task board: what needs doing, who has it, and its state. Open tasks by default.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'todo', 'doing', 'review', 'blocked', 'done', 'all'] },
        assignee: { type: 'string', description: '"me", or a teammate name' },
      },
    },
  },
  {
    name: 'task_add',
    description: 'Put a task on the project board, optionally assigned to a teammate by name (or "me"). Tell the teammate with SendMessage if it is urgent.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        details: { type: 'string', description: 'The ticket itself: the goal, the files or links, and how to check it is done. 150 words or fewer.' },
        assignee: { type: 'string' },
      },
      required: ['title'],
    },
  },
  {
    name: 'task_update',
    description:
      'Change a ticket: set its status (todo, doing, review, blocked, done), say how far along it is, reassign it, move it up or down its column, or add a comment. Mark your tickets doing when you start, keep "progress" roughly current while you work, and review or done when you finish. Anyone may comment on any ticket.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Task id such as T3' },
        status: { type: 'string', enum: ['todo', 'doing', 'review', 'blocked', 'done'] },
        progress: { type: 'number', description: 'How far along, 0 to 100, as you judge it. Keep it honest: it is what the user watches.' },
        rank: { description: '"top" to make it the next one taken, "bottom" to put it last', type: 'string', enum: ['top', 'bottom'] },
        note: { type: 'string' },
        assignee: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'task_take',
    description:
      'Take the next ticket: the one at the top of the to-do column that is yours or unassigned. It is assigned to you and moved to doing. Call it whenever you are free and the user has not told you what to do. If taking it would clash with work someone else has in hand, do not quietly take the one below: say so with "instead", which leaves the ticket where it is and tells you who to raise it with.',
    inputSchema: {
      type: 'object',
      properties: { instead: { type: 'string', description: 'Why the top ticket cannot be taken right now. Leave empty to take it.' } },
    },
  },
  {
    name: 'team_list',
    description:
      'List the other Claude Code sessions running on this machine right now: their names (use these with SendMessage), roles, whether they are busy, and which share your project.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'team_info',
    description:
      'The team of this project exactly as the user has it in Loop right now: each role and the session that holds it, plus the sessions that are not on the team. Short and cheap. Call it before answering anything about the team or deciding who should do something; never rely on memory for it. Pass "role" for what one role does and who it hands work to.',
    inputSchema: { type: 'object', properties: { role: { type: 'string', description: 'A role name such as CTO, for that role in full' } } },
  },
  {
    name: 'team_manage',
    description:
      'Change the team or the sessions of this project in Loop. Actions: tell (give "session" the work in "text" - it wakes the teammate if it is not running, which is how you hand anything over), assign (give "session" the "role"), unassign ("session"), add_role ("role", optional "duty"), drop_role ("role"), start (a new session called "name", optional "role"), wake (open a teammate "session" without saying anything yet), rename ("session" to "name"), close ("session"), rules (write the rules in "text": scope "company" for every team on this machine, "project" for this project only, "member" for the one in "session"; the CEO alone may do this). "session" is a session name, or "me". Any session may rename itself and any team member may tell or wake a teammate; the rest is for the CEO and the CTO, or anyone while the project has no team.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['tell', 'assign', 'unassign', 'add_role', 'drop_role', 'start', 'wake', 'rename', 'close', 'rules'] },
        scope: { type: 'string', enum: ['company', 'project', 'member'], description: 'For the rules action: who the rules are for. Default project.' },
        session: { type: 'string' },
        role: { type: 'string' },
        name: { type: 'string' },
        duty: { type: 'string' },
        text: { type: 'string', description: 'What to say to the teammate, for the tell action; the rules themselves, for the rules action' },
      },
      required: ['action'],
    },
  },
  {
    name: 'subsession_start',
    description:
      'Start a sub-session: a separate session of yours for one task, so you keep working on your own while it does that. It gets the task, what you tell it in "context", your notes, and (for code) its own git worktree and branch. When it is done it hands back what you ask for in "returns" (for code: the branch and commits; otherwise a short report), as a message to you. Use it for work that can run beside yours. "repo": the repository folder to branch from, relative to the project folder; default the one the project is in. "worktree": false for work that is not code.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'What the sub-session must do, in full: it does not see your conversation.' },
        returns: { type: 'string', description: 'What you want back when it is done.' },
        context: { type: 'string', description: 'What it needs to know: decisions, files, links. Keep it short.' },
        repo: { type: 'string' },
        worktree: { type: 'boolean' },
        name: { type: 'string', description: 'A short name for it.' },
      },
      required: ['task'],
    },
  },
  {
    name: 'subsession_done',
    description:
      'For a sub-session: hand your result back to the main session that started you, and finish. "result" is exactly what it asked for (for code: the branch, the commits and a 3-line summary). If you cannot finish, say what is missing instead.',
    inputSchema: { type: 'object', properties: { result: { type: 'string' } }, required: ['result'] },
  },
  {
    name: 'subsession_list',
    description: 'Your sub-sessions: what each is doing, whether it is done, and what it handed back.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'subsession_close',
    description:
      'Delete one of your sub-sessions: it is stopped, its worktree removed (only if nothing is left uncommitted; its branch stays for you to merge) and it leaves the list. "session": its name from subsession_list, or "done" for every one that has handed back.',
    inputSchema: { type: 'object', properties: { session: { type: 'string' } }, required: ['session'] },
  },
  {
    name: 'subsession_returns',
    description:
      'Say what you want back from sub-sessions started for you, including ones the user starts. It is used whenever a sub-session is started without its own "returns".',
    inputSchema: { type: 'object', properties: { returns: { type: 'string' } }, required: ['returns'] },
  },
  {
    name: 'whatsapp_listen',
    description:
      "Have new WhatsApp messages from one person delivered to you as they arrive (the user's own WhatsApp on this PC). Use it when the user asks you to listen to, watch or follow someone on WhatsApp. contact: their name as saved in the phone, or their number. stop: true to stop (contact \"all\" stops every one). No contact: who you listen to now.",
    inputSchema: { type: 'object', properties: { contact: { type: 'string' }, stop: { type: 'boolean' } } },
  },
  {
    name: 'role_brief',
    description:
      "Your role on this project's team: what you are responsible for, how the role works, and which teammate you hand work to next. Call it when you start and whenever you are given a goal.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'memory_delete',
    description: "Delete a note that is wrong or obsolete. You can delete project notes and your own, not a teammate's.",
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
];

// The company shelf belongs to the CEO. Anyone reads it; one role writes it.
// A project with no team has no CEO, so nothing is locked.
function isCeo(dir, me) {
  const t = teamOf(dir);
  if (!t || !t.members) return true;
  return t.members[me] === 'ceo' || !Object.values(t.members).includes('ceo');
}

function pick(notes, scope, me) {
  if (scope === 'project') return notes.filter((n) => n.scope === 'project');
  if (scope === 'company') return notes.filter((n) => n.scope === 'company');
  if (scope === 'mine') return notes.filter((n) => n.scope === me);
  if (scope === 'parent') {
    const up = (subOf(me) || {}).parent;
    return up ? notes.filter((n) => n.scope === up) : [];
  }
  if (scope === 'team') return notes.filter((n) => n.scope !== 'project' && n.scope !== 'claude' && n.scope !== 'company' && n.scope !== me);
  return notes;
}

const scopeLabel = (n, me) =>
  n.scope === 'company'
    ? 'company, set by the CEO'
    : n.scope === 'project'
    ? 'project'
    : n.scope === 'claude'
      ? 'Claude Code auto-memory, read-only'
      : n.scope === me
        ? 'mine'
        : `teammate ${n.author || n.scope.slice(0, 8)}`;
const day = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : 'unknown date');

async function memberName(sessionId) {
  const live = await readLive();
  const hit = live.find((l) => l.sessionId === sessionId);
  return (hit && hit.name) || 'session ' + sessionId.slice(0, 8);
}

// Teammates are other sessions in Loop, not subagents of this one: the Task
// tool and ListAgents cannot see them, and one that is not running is not
// visible anywhere until it is woken. One tool covers both.
// The board is a queue, not a pile. Everyone works it the same way, so the user
// can read progress off it without having to ask anyone.
const BOARD_RULES = [
  'How this board works:',
  '- Take work with task_take: it gives you the top ticket of the to-do column that is yours or unassigned, and puts it in doing. The top one is the most important: do not pick one further down because it looks easier.',
  '- If taking the top one would clash with what someone else has in hand, do not skip it quietly: call task_take with "instead" saying why. The ticket stays where it is and whoever gave you the work decides, asking the user when it is their call.',
  '- While you work, keep task_update "progress" roughly honest, 0 to 100. It is what the user watches to see how far along things are.',
  '- Finish by moving it to review or done, with a comment saying what changed.',
].join('\n');

// The policy the user wrote for this team in Loop: how they want it to work.
// It is kept with the team, so every member is told the same thing.
function policyOf(dir) {
  const t = teamOf(dir);
  return t && typeof t.policy === 'string' ? t.policy.trim().slice(0, 4000) : '';
}

// ---------- the rules every team works by ----------
// One company, one set of rules. A project may add its own on top, and a single
// member may be given extra. The team is lean: two front doors, no relay, short
// handoffs, because every word between members is paid for twice.
const HOUSE_RULES = [
  'Save tokens above all. Keep every message to a line or two. Read only the files you need, and only the parts you need. Never paste conversation history to a teammate.',
  'Two front doors. The user gives business goals to the CEO and technical goals to the CTO, and talks to them directly. Other members take work from the CEO, the CTO, or the user when the user speaks to them.',
  'No relay. The CEO or CTO hands each ticket straight to the teammate who does the work. Never pass work through a middle role.',
  'Do small jobs yourself. A job under about 30 minutes is done by whoever received it. Wake a teammate only for work that is big or needs their speciality, and only the ones it needs.',
  'Short handoffs. A handoff is a ticket of 150 words or fewer: the goal, the files or links, and how to check it is done.',
  'Short replies. When your part is done, reply to whoever gave it to you in 3 lines or fewer, plus the commit, PR or file link. Never answer a reply, and never send an acknowledgement, an acceptance or a thank-you: the reply closes the work, and each extra message costs a turn for nothing. Report to the user once.',
  'Remember your own work. Keep what you learn about the project in your own memory notes, so the next ticket does not start from zero.',
  'Reporting to the user: first a message that starts with "Plan:" and gives the plan in 3 bullets; then quiet while you work; then one final report that starts with "Done:", has at most 5 bullets of 15 words or fewer, and ends with the line "Need from you:" (or "Need from you: nothing"). Only the lead the user gave the goal to writes these. No progress chatter and no timed check-ins.',
];

const housePlain = () => HOUSE_RULES.map((r, i) => (i + 1) + '. ' + r).join('\n');

// The company's rules: what the user or the CEO has written, else Loop's own.
function companyRules() {
  const c = companyOf() || {};
  const own = typeof c.rules === 'string' ? c.rules.trim() : '';
  return own ? own.slice(0, 6000) : housePlain();
}

// How long a quiet board is left before the CEO asks for an update. Off (0)
// unless the user or a project sets it: the lean team reports when work moves.
function checkMins(dir) {
  const t = teamOf(dir);
  const mine = t && Number(t.checkMins);
  if (Number.isFinite(mine) && mine >= 0) return mine;
  const c = Number((companyOf() || {}).checkMins);
  return Number.isFinite(c) && c >= 0 ? c : 0;
}

// Rules written for one member alone, on top of the company's and the project's.
function memberRules(dir, me) {
  const t = teamOf(dir);
  const r = t && t.memberRules && t.memberRules[me];
  return typeof r === 'string' ? r.trim().slice(0, 2000) : '';
}

// Everything this member must follow, in the order of who decided it.
function rulesFor(dir, me) {
  const out = ["The company's rules. The CEO sets them, and they outrank your own habits and anything earlier in this conversation:\n" + companyRules()];
  const extra = policyOf(dir);
  if (extra) out.push("This project's own rules, on top of the company's:\n" + extra);
  const own = memberRules(dir, me);
  if (own) out.push('Rules for you in particular:\n' + own);
  const mins = checkMins(dir);
  if (mins) out.push('No update for ' + mins + ' minutes means the CEO asks for one: send a line before that runs out rather than waiting to be asked.');
  return out.join('\n\n');
}

const REACH =
  'Say what you need, what is already decided and the ticket id if there is one. Hand it over with team_manage (action tell, session the name in quotes, text what you need): that wakes the teammate if it is not running, the way a phone call wakes someone, and it starts on what you said. Do not look for teammates with ListAgents or the Task tool: they are not subagents of yours and will not be there. SendMessage also reaches one that team_info already shows running.';

async function teamList(dir, me) {
  const live = await readLive();
  const self = live.find((l) => l.sessionId === me);
  const others = live.filter((l) => l.sessionId !== me);
  const line = (l) => {
    const role = profileOf(l.sessionId).role;
    const state = l.status === 'idle' ? 'idle' : 'busy';
    // The name the user gave it in Loop first: Claude's own process name can be a stale auto-name.
    return `- "${profileOf(l.sessionId).name || l.name || l.sessionId.slice(0, 8)}": ${state}${role ? `, role: ${role}` : ''}${l.cwd ? `, in ${l.cwd}` : ''}`;
  };
  const same = others.filter((l) => encodePath(l.cwd).toLowerCase() === dir.toLowerCase());
  const rest = others.filter((l) => !same.includes(l));
  const myRole = profileOf(me).role;
  const out = [`You are "${(self && self.name) || 'this session'}"${myRole ? `, role: ${myRole}` : ''}.`];
  out.push(same.length ? 'Teammates in your project:\n' + same.map(line).join('\n') : 'No other session is running in your project right now.');
  const roles = await teamLines(dir);
  if (roles) out.push("This project's team, by role:\n" + roles + '\nCall team_info for what each role does, and role_brief for your own role and who you hand work to.');
  if (roles) {
    const team = teamOf(dir);
    const outside = same.filter((l) => !team.members[l.sessionId]);
    if (outside.length) out.push('External members (running here without a team role): ' + outside.map((l) => `"${l.name || l.sessionId.slice(0, 8)}"`).join(', '));
  }
  if (rest.length) out.push('Sessions in other projects:\n' + rest.map(line).join('\n'));
  out.push('Reach any of them with team_manage (action tell), which wakes one that is not running; SendMessage also works for one shown here, and a busy session reads it when it finishes its current step. ListAgents and the Task tool do not see teammates.');
  return out.join('\n\n');
}

// Who holds each role of the project's team, with the name to message them by.
async function teamHolders(dir) {
  const team = teamOf(dir);
  if (!team) return null;
  const live = await readLive();
  const who = (id) => {
    const l = live.find((x) => x.sessionId === id);
    const known = profileOf(id).name;
    if (l) return `"${known || l.name || id.slice(0, 8)}" (${l.status === 'idle' ? 'idle' : 'busy'})`;
    return `${known ? `"${known}"` : 'session ' + id.slice(0, 8)} (not running)`;
  };
  const ids = (key) => Object.keys(team.members).filter((id) => team.members[id] === key);
  return { team, ids, names: (key, not) => ids(key).filter((id) => id !== not).map(who) };
}

async function teamLines(dir) {
  const t = await teamHolders(dir);
  if (!t) return '';
  return t.team.roles.map((r) => `- ${r.title}: ${t.names(r.key).join(', ') || 'nobody yet'}`).join('\n');
}

// What a session is told about its role: the role's own playbook, which is the
// same in every project, and who in this project it hands work to next.
async function roleBrief(dir, me) {
  const t = await teamHolders(dir);
  const role = t && t.team.roles.find((r) => r.key === t.team.members[me]);
  if (!role) return 'You have no team role in this project. Call team_list to see who is here.';
  const held = (r) => t.ids(r.key).some((id) => id !== me);
  const next = (role.next || []).map((k) => t.team.roles.find((r) => r.key === k)).filter((r) => r && held(r));
  const front = role.key === 'ceo' || role.key === 'cto';
  const rights = boardRights(t.team, me);
  const out = [`You are the ${role.title} on this project's team.`];
  if (role.duty) out.push(`Responsible for: ${role.duty}`);
  if (role.guide) out.push(`How you work: ${role.guide}`);
  if (rights.managed) {
    out.push(
      rights.manager
        ? 'Board: you maintain it. You alone add, assign and edit tickets.'
        : 'Board: the project manager maintains it. Comment on any ticket and move the ones assigned to you; ask the manager for anything else.',
    );
  }
  if (next.length) {
    out.push(
      'Who does the work: do small jobs yourself; hand bigger work straight to the teammate whose speciality it is, as a short ticket.\n' +
        next.map((r) => `- ${r.title}: ${t.names(r.key, me).join(', ')}`).join('\n') +
        '\n' +
        REACH,
    );
  }
  out.push(
    front
      ? "Report to the user in the company's report format when the goal is done or stuck."
      : 'When your ticket is done, reply to whoever gave it to you: 3 lines or fewer, plus the commit, PR or file link.',
  );
  out.push(BOARD_RULES);
  out.push(rulesFor(dir, me));
  out.push('The team:\n' + (await teamLines(dir)));
  out.push('The company keeps its knowledge base, its documents and its policies in one place: memory_search or memory_list with scope "company" reads them. Only the CEO writes there.');
  return out.join('\n\n');
}

// The team as the user has it in Loop at this moment: read from Loop's own
// settings on every call, so it is never a copy that can go stale. Short by
// default (who holds what); one role in full only when asked for.
async function teamInfo(dir, me, want) {
  const t = await teamHolders(dir);
  if (!t) return 'This project has no team set up in Loop. Call team_list to see which sessions are running.';
  const { team } = t;
  const title = (key) => (team.roles.find((r) => r.key === key) || {}).title;
  if (want) {
    const q = String(want).toLowerCase();
    const r = team.roles.find((x) => x.title.toLowerCase() === q || x.key === q) || team.roles.find((x) => x.title.toLowerCase().includes(q));
    if (!r) return `No role called "${want}" on this team. The roles are: ${team.roles.map((x) => x.title).join(', ')}.`;
    const next = (r.next || []).map(title).filter(Boolean);
    return [
      `${r.title}, held by: ${t.names(r.key).join(', ') || 'nobody yet'}`,
      r.duty ? `Responsible for: ${r.duty}` : '',
      r.guide ? `How it works: ${r.guide}` : '',
      next.length ? `Hands work to: ${next.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }
  const mine = team.roles.find((r) => r.key === team.members[me]);
  const live = await readLive();
  const outside = live.filter((l) => !team.members[l.sessionId] && encodePath(l.cwd).toLowerCase() === dir.toLowerCase());
  return [
    `Team of this project, as set in Loop right now. ${mine ? `You are the ${mine.title}.` : 'You have no role in it: you are an external member.'}`,
    team.roles.map((r) => `- ${r.title}: ${t.names(r.key).join(', ') || 'nobody yet'}`).join('\n'),
    outside.length ? 'External members (no team role): ' + outside.map((l) => `"${l.name || l.sessionId.slice(0, 8)}"`).join(', ') : '',
    team.roles.some((r) => r.manages && t.ids(r.key).length) ? 'Only the project manager adds, assigns and edits tickets.' : '',
    'This is the truth about the team. Where it differs from what you remember or have in notes, it wins: use it without asking the user which is right, and fix your own notes.',
    'For what one role does and who it hands work to, call team_info with its name in "role".',
    'Hand work to any of them, running or not, with team_manage (action tell): it wakes them.',
  ]
    .filter(Boolean)
    .join('\n');
}

// Goes into a member's system prompt when Loop starts or resumes it. It holds no
// copy of the team, only which tool has it and that the tool outranks what the
// conversation remembers.
function startBrief(dir, me) {
  const team = teamOf(dir);
  if (!team || !team.members[me]) return '';
  return (
    'You are a member of the team the user set up for this project in Loop. The team is kept in Loop, not in this conversation, and the user changes it there, ' +
    'so anything about the team, its roles or who does what that appears earlier in this conversation or in your notes may be out of date. ' +
    'Whenever you need to know who is on the team, who holds which role, what a role does or who should do something, call the team_info tool first and answer only from its result, role by role. Its result always wins over what you remember: do not ask the user which is current. ' +
    'When you are given a goal, call role_brief, do small jobs yourself and hand bigger work straight to the teammate who does it. ' +
    'Hand work over with the team_manage tool: action "tell", session the teammate name from team_info, text what you need. That wakes a teammate that is not running, the way a phone call wakes someone, and it starts on what you said. ' +
    'Your teammates are separate sessions in Loop, not subagents of yours: ListAgents and the Task tool do not see them, and SendMessage only reaches one that team_info already shows running. ' +
    BOARD_RULES.replace(/\n/g, ' ') +
    ' ' +
    rulesFor(dir, me).replace(/\s+/g, ' ') +
    ' The company knowledge base, documents and policies are in memory under scope "company", which only the CEO writes to. Call role_brief for the rules in full.'
  );
}

async function callTool(name, args, ctx) {
  const { dir, sessionId: me } = ctx;
  if (name === 'team_list') return teamList(dir, me);
  if (name === 'role_brief') return roleBrief(dir, me);
  if (name === 'whatsapp_listen') return waDo(dir, me, args.contact == null ? '' : String(args.contact).slice(0, 100), Boolean(args.stop));
  if (name === 'team_info') return teamInfo(dir, me, args.role);
  // Sub-sessions are started and ended by the Loop window, which runs them.
  if (name.startsWith('subsession_')) {
    const sub = {};
    for (const k of ['task', 'returns', 'context', 'repo', 'name', 'result', 'session']) if (args[k] != null) sub[k] = String(args[k]).slice(0, k === 'result' || k === 'context' ? 8000 : 2000);
    if (args.worktree != null) sub.worktree = Boolean(args.worktree);
    return teamDo({ dir, me, action: name, sub });
  }
  if (name === 'team_manage') {
    const pick = (k) => (args[k] == null ? '' : String(args[k]).trim().slice(0, 300));
    return teamDo({ dir, me, action: pick('action'), session: pick('session'), role: pick('role'), name: pick('name'), duty: pick('duty'), scope: pick('scope'), text: args.text == null ? '' : String(args.text).slice(0, 6000) });
  }
  if (name.startsWith('task_')) {
    const myName = await memberName(me);
    const who = (a) =>
      String(a || '')
        .trim()
        .toLowerCase() === 'me'
        ? myName
        : String(a || '').trim();
    const rights = boardRights(teamOf(dir), me);
    const closed = rights.managed && !rights.manager;
    const boss = async () => (await Promise.all(rights.managers.map(memberName))).map((n) => `"${n}"`).join(' or ');
    // A name becomes the session behind it, so "assigned to me" survives a rename.
    const idOf = async (a) => {
      if (String(a || '').trim().toLowerCase() === 'me') return me;
      const hit = (await readLive()).find((l) => l.name && l.name.toLowerCase() === who(a).toLowerCase());
      return hit ? hit.sessionId : '';
    };
    if (name === 'task_add') {
      if (closed) return `Only the project manager (${await boss()}) adds tickets on this board. Send them what is needed with SendMessage, or comment on an existing ticket with task_update.`;
      // Models often call the body "description": it is the same thing, and dropping it silently loses the spec.
      const t = await taskAdd(dir, { title: args.title, details: args.details || args.description, assignee: who(args.assignee), assigneeId: await idOf(args.assignee), by: myName });
      return `Added ${t.id}: ${t.title}${t.assignee ? `, assigned to ${t.assignee}` : ''}.`;
    }
    if (name === 'task_take') {
      const all = await taskList(dir);
      const free = all.filter((t) => t.status === 'todo' && (!t.assignee || isMine(t, me, myName)));
      const top = free[0];
      if (!top) return 'Nothing is waiting in to-do for you. Ask whoever gave you the work what is next, or report that you are free.';
      const why = String(args.instead || '').trim();
      if (why) {
        // The rule is to take the top one. Not taking it is a decision someone
        // has to make, so it goes to whoever runs the board, not into silence.
        await taskUpdate(dir, top.id, { note: `Did not take this: ${why.slice(0, 500)}` }, myName);
        const ask = (await boss()) || 'the CEO';
        return `Left ${top.id} where it is and written your reason on it. Tell ${ask} now with team_manage (action tell): say what ${top.id} would clash with and what you suggest instead. Wait for their answer rather than starting the next ticket down.`;
      }
      const t = await taskUpdate(dir, top.id, { status: 'doing', assignee: myName, assigneeId: me }, myName);
      return `Taken.
${taskLine(t, true)}
Keep it current with task_update: progress as you go, review or done when you finish.`;
    }
    if (name === 'task_update') {
      const change = { status: args.status, note: args.note, progress: args.progress, rank: args.rank };
      if (args.assignee !== undefined) {
        change.assignee = who(args.assignee);
        change.assigneeId = await idOf(args.assignee);
      }
      const refused = [];
      if (closed) {
        const task = (await boardLoad(dir)).tasks.find((x) => x.id.toLowerCase() === String(args.id).toLowerCase());
        if (!task) return `No task has the id ${args.id}. Call task_list to see the board.`;
        if (change.assignee !== undefined) {
          delete change.assignee;
          delete change.assigneeId;
          refused.push('assigning tickets');
        }
        if (change.status && !isMine(task, me, myName)) {
          delete change.status;
          refused.push('the status of a ticket that is not assigned to you');
        }
        if (refused.length && !change.status && !change.note)
          return `Not changed: ${refused.join(' and ')} is for the project manager (${await boss()}). You can comment on ${task.id} with a note, or message them with SendMessage.`;
      }
      const t = await taskUpdate(dir, args.id, change, myName);
      if (!t) return `No task has the id ${args.id}. Call task_list to see the board.`;
      return `${refused.length ? `Your comment was added. Not changed: ${refused.join(' and ')} is for the project manager (${await boss()}).` : 'Updated.'}\n${taskLine(t)}`;
    }
    let tasks = await taskList(dir);
    const status = args.status || 'open';
    if (status === 'open') tasks = tasks.filter((t) => t.status !== 'done');
    else if (status !== 'all') tasks = tasks.filter((t) => t.status === status);
    if (args.assignee) tasks = tasks.filter((t) => t.assignee.toLowerCase() === who(args.assignee).toLowerCase());
    if (!tasks.length) return 'No matching tasks on the board.';
    return tasks.slice(0, 40).map(taskLine).join('\n') + (tasks.length > 40 ? `\n(${tasks.length - 40} more not shown)` : '');
  }
  const notes = await loadProject(dir);
  if (name === 'memory_search') {
    const budget = Math.min(6000, Math.max(200, Number(args.max_tokens) || 1200));
    const hits = rank(pick(notes, args.scope || 'all', me), String(args.query || ''));
    if (!hits.length) return 'No notes match. Try other keywords, or memory_list to see what exists.';
    const out = [];
    let used = 0;
    let shown = 0;
    for (const r of hits) {
      const head = `## ${r.note.title} [id: ${r.note.id}] (${scopeLabel(r.note, me)}, ${day(r.note.updated)})`;
      const parts = [];
      let cost = estimateTokens(head);
      for (const p of r.passages.slice(0, 3)) {
        const c = estimateTokens(p.text);
        if (used + cost + c > budget) break;
        parts.push(p.text);
        cost += c;
      }
      if (!parts.length) break;
      out.push(head + '\n' + parts.join('\n\n'));
      used += cost;
      shown++;
    }
    if (!out.length)
      return `The best match "${hits[0].note.title}" [id: ${hits[0].note.id}] is larger than the budget. Read it with memory_read or raise max_tokens.`;
    if (shown < hits.length) out.push(`(${hits.length - shown} more matching notes not shown. Narrow the query or raise max_tokens.)`);
    return out.join('\n\n');
  }
  if (name === 'memory_save') {
    const want = args.id ? (notes.find((n) => n.id === args.id) || {}).scope : args.scope;
    if (want === 'company' && !isCeo(dir, me)) {
      return 'The company shelf is the CEO’s: knowledge base, documents and policies are written there by the CEO alone. Send the CEO what should go on it, or save it as a project note instead.';
    }
    const scope = args.scope === 'project' ? 'project' : args.scope === 'company' ? 'company' : me;
    if (args.id) {
      const cur = notes.find((n) => n.id === args.id);
      if (!cur) return `No note has the id ${args.id}.`;
      if (cur.scope !== 'project' && cur.scope !== 'company' && cur.scope !== me) return 'That note is read-only for you. Save your own note instead.';
    }
    const id = await saveNote({
      dir,
      scope: args.id ? notes.find((n) => n.id === args.id).scope : scope,
      id: args.id,
      title: String(args.title || ''),
      body: String(args.content || ''),
      tags: Array.isArray(args.tags) ? args.tags : [],
      author: await memberName(me),
    });
    return `Saved to ${scope === 'project' ? 'project memory' : scope === 'company' ? 'the company shelf, where every project reads it' : 'your knowledge base'} as [id: ${id}].`;
  }
  if (name === 'memory_list') {
    const sel = pick(notes, args.scope || 'all', me);
    if (!sel.length) return 'Memory is empty for that scope.';
    return sel
      .map((n) => `- ${n.title} [id: ${n.id}] (${scopeLabel(n, me)}, ${day(n.updated)}, ~${n.tokens} tokens)${n.tags.length ? ' #' + n.tags.join(' #') : ''}`)
      .join('\n');
  }
  if (name === 'memory_read') {
    const n = notes.find((x) => x.id === args.id);
    if (!n) return `No note has the id ${args.id}.`;
    return `# ${n.title}\n(${scopeLabel(n, me)}, ${day(n.updated)}${n.tags.length ? ', tags: ' + n.tags.join(', ') : ''})\n\n${n.body}`;
  }
  if (name === 'memory_delete') {
    const n = notes.find((x) => x.id === args.id);
    if (!n) return `No note has the id ${args.id}.`;
    if (n.scope === 'company' && !isCeo(dir, me)) return 'Only the CEO removes anything from the company shelf.';
    if (n.scope !== 'project' && n.scope !== 'company' && n.scope !== me) return 'That note is read-only for you and was left alone.';
    await removeNote({ dir, id: n.id });
    return `Deleted "${n.title}".`;
  }
  throw new Error(`Unknown tool ${name}`);
}

// A short table of contents, so a session knows what is worth searching for
// without spending a tool call to find out.
async function contentsLine(ctx) {
  try {
    const notes = (await loadProject(ctx.dir)).filter((n) => n.scope === 'project' || n.scope === ctx.sessionId).slice(0, 18);
    if (!notes.length) return ' Memory is empty so far.';
    return ' Notes currently saved: ' + notes.map((n) => `"${n.title}"${n.scope === 'project' ? '' : ' (mine)'}`).join('; ') + '.';
  } catch {
    return '';
  }
}

// Said first, so it is never the part that gets cut off.
function roleLine(ctx) {
  const team = teamOf(ctx.dir);
  const role = team && team.roles.find((r) => r.key === team.members[ctx.sessionId]);
  if (!role) return '';
  return `You are the ${role.title} on this project's team. Before you act on a goal, call role_brief: it holds how your role works and which teammate you hand work to next, so the user never has to tell you. `;
}

async function handleRpc(msg, ctx) {
  const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: (msg.params && msg.params.protocolVersion) || '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'session-deck-memory', version: '0.1.0' },
        instructions:
          roleLine(ctx) +
          INSTRUCTIONS +
          (profileOf(ctx.sessionId).role ? ` Your role on this team: ${profileOf(ctx.sessionId).role}` : '') +
          ' Call team_list to see which teammates are running and how to reach them.' +
          (await contentsLine(ctx)),
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call':
      try {
        const text = await callTool(msg.params.name, msg.params.arguments || {}, ctx);
        return reply({ content: [{ type: 'text', text }] });
      } catch (e) {
        return reply({ content: [{ type: 'text', text: `Memory error: ${e.message}` }], isError: true });
      }
    default:
      return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
  }
}

function startServer() {
  server = http.createServer((req, res) => {
    const send = (code, body) => {
      res.writeHead(code, body ? { 'Content-Type': 'application/json' } : {});
      res.end(body ? JSON.stringify(body) : undefined);
    };
    const m = /^\/mcp\/([a-f0-9]+)\/([A-Za-z0-9_-]+)\/([0-9a-f-]{36})\/?$/.exec(req.url || '');
    if (!m || m[1] !== secret || !UUID_RE.test(m[3])) return send(404);
    if (req.method === 'DELETE') return send(200);
    if (req.method !== 'POST') return send(405);
    const ctx = { dir: m[2], sessionId: m[3] };
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 4e6) req.destroy();
    });
    req.on('end', async () => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      }
      const batch = Array.isArray(msg) ? msg : [msg];
      const out = [];
      for (const one of batch) {
        if (one.id === undefined || one.id === null) continue; // notification
        out.push(await handleRpc(one, ctx));
      }
      if (!out.length) return send(202);
      send(200, Array.isArray(msg) ? out : out[0]);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    });
  });
}

// The memory server's address for one session, for agents that take it directly.
function urlFor(dir, sessionId) {
  if (!port || !safeDir(dir) || !UUID_RE.test(sessionId || '')) return null;
  return `http://127.0.0.1:${port}/mcp/${secret}/${dir}/${sessionId}`;
}

// When Loop owns memory: what a session is told at its start, whatever agent it
// is. It does what an agent's own memory does (an index read at the start, notes
// saved as it learns), but the notes are Loop's, so any agent can pick them up.
function ownerBrief(dir, sessionId) {
  const notes = (cache.get(dir) || []).filter((n) => n.scope === 'project' || n.scope === 'company' || (sessionId && n.scope === sessionId));
  const index = notes
    .slice(0, 40)
    .map((n) => `- ${n.title}${n.scope === sessionId ? ' (yours)' : ''}`)
    .join('\n');
  return (
    'Your memory is kept by Loop, not by you, and it belongs to this session: whichever agent works in this session reads and writes the same notes. Never write memory files of your own (no MEMORY.md, no notes folder). ' +
    'Before unfamiliar work, call memory_search with a few keywords. When you learn something that will still matter later (a decision and its reason, where something lives, a fix, a preference of the user), save it with memory_save, one topic per note, and update an existing note rather than adding a near-duplicate. ' +
    'Never save passwords, keys or tokens. ' +
    (index ? 'Notes this project already has, by title: ' + index.replace(/\n/g, '; ') : 'This project has no notes yet.')
  );
}

// Writes the --mcp-config file for one session and returns its path.
function configFor(dir, sessionId) {
  if (!port || !safeDir(dir) || !UUID_RE.test(sessionId || '')) return null;
  const file = path.join(MCP_DIR, `${sessionId}.json`);
  const url = `http://127.0.0.1:${port}/mcp/${secret}/${dir}/${sessionId}`;
  fs.mkdirSync(MCP_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { 'team-memory': { type: 'http', url } } }));
  return file;
}

// ---------- where memory lives ----------

const MARKER = 'session-deck-memory.json';
const ABOUT = [
  '# Loop memory',
  '',
  'Plain markdown notes written by you and by the agents in your Loop sessions.',
  '',
  '- `company/` is shared by every project',
  '- `projects/<project>/shared/` is shared by every session in that project',
  "- `projects/<project>/sessions/<session>/` is one session's own memory, whichever agent works in it",
  '',
  'Each folder has a `loop.md` that lists its notes. Loop keeps it.',
  '',
  'This folder is self-contained. Move or copy it anywhere, then choose it',
  'again in Loop under Settings > Memory folder.',
  '',
].join('\n');

async function stamp(dir) {
  await fsp.mkdir(dir, { recursive: true });
  const marker = path.join(dir, MARKER);
  if (!fs.existsSync(marker)) await fsp.writeFile(marker, JSON.stringify({ app: 'session-deck', format: 2 }, null, 2));
  await fsp.writeFile(path.join(dir, 'README.md'), ABOUT);
}

// Point memory at another folder. A folder that already holds Loop
// memory is adopted as it is; otherwise the current notes move there.
async function setRoot(target) {
  let dest = path.resolve(target);
  if (dest.toLowerCase() === ROOT.toLowerCase()) return { ok: true, root: ROOT, message: 'Memory already lives there.' };
  if (dest.toLowerCase().startsWith(ROOT.toLowerCase() + path.sep))
    return { ok: false, root: ROOT, message: 'Choose a folder outside the current memory folder.' };
  try {
    let entries = [];
    try {
      entries = await fsp.readdir(dest);
    } catch {
      // does not exist yet
    }
    let adopted = entries.includes(MARKER);
    if (!adopted && entries.length) {
      // Not ours and not empty: keep memory in its own subfolder there.
      dest = path.join(dest, 'Loop Memory');
      adopted = fs.existsSync(path.join(dest, MARKER));
    }
    if (!adopted) {
      await fsp.mkdir(dest, { recursive: true });
      await fsp.cp(ROOT, dest, { recursive: true, errorOnExist: false, force: false });
      await fsp.rm(ROOT, { recursive: true, force: true });
    }
    await stamp(dest);
    ROOT = dest;
    cache.clear();
    return { ok: true, root: ROOT, message: adopted ? `Now using the memory already in ${dest}.` : `Memory moved to ${dest}.` };
  } catch (e) {
    return { ok: false, root: ROOT, message: `Could not use that folder: ${e.message}` };
  }
}

// Returns a warning when the chosen folder cannot be reached (for example a
// drive that is not plugged in) and memory fell back to the default place.
async function init(userData, chosen) {
  const fallback = path.join(userData, 'memory');
  MCP_DIR = path.join(userData, 'mcp');
  let warning = null;
  ROOT = chosen || fallback;
  try {
    await stamp(ROOT);
  } catch {
    warning = `The memory folder ${ROOT} is not available, so notes are being kept in ${fallback} for now.`;
    ROOT = fallback;
    await stamp(ROOT);
  }
  const moved = await layout.ready();
  if (moved && moved.error) warning = `Memory could not be moved into the new layout: ${moved.error}. Nothing was lost; a copy is in the memory folder.`;
  await startServer();
  return warning;
}
module.exports = {
  urlFor,
  ownerBrief,
  // Where a project's memory is, made if needed; and naming projects and sessions.
  projectFolder: async (dir) => {
    await layout.ready();
    return (await layout.projectDir(dir, { create: false })) || path.join(ROOT, 'projects');
  },
  projectFolderSync: (dir) => layout.projectDirSync(dir),
  // The folder one scope's notes are in: company, project or a session id.
  scopeFolder: async (dir, scope) => {
    await layout.ready();
    if (scope === 'company') return layout.companyDir();
    if (scope === 'all') return ROOT;
    if (scope === 'project') return (await layout.sharedDir(dir, { create: false })) || path.join(ROOT, 'projects');
    return (await layout.sessionDir(dir, scope)) || (await layout.projectDir(dir, { create: false })) || path.join(ROOT, 'projects');
  },
  knownProjects: () => layout.knownProjects(),
  setProjectNamer: (fn) => layout.setProjectNamer(fn),
  setSessionNamer: (fn) => layout.setSessionNamer(fn),
  setRemoteLookup: (fn) => layout.setRemoteLookup(fn),
  // Notes arrived from outside (Loop Cloud): read afresh and rewrite the indexes.
  rebuildIndexes: async (dir) => {
    cache.delete(dir);
    await layout.ready();
    const shared = await layout.sharedDir(dir, { create: false });
    if (shared && fs.existsSync(shared)) await reindex(shared, 'project').catch(() => {});
    for (const s of await layout.sessionDirs(dir)) await reindex(s.folder, s.id).catch(() => {});
    if (fs.existsSync(layout.companyDir())) await reindex(layout.companyDir(), 'company').catch(() => {});
    cache.delete(dir);
  },
  listAll: (dir) => loadProject(dir),
  setProfileLookup: (fn) => (profileOf = fn),
  setTeamLookup: (fn) => (teamOf = fn),
  setCompanyLookup: (fn) => (companyOf = fn),
  setSubLookup: (fn) => (subOf = fn),
  setTeamDo: (fn) => (teamDo = fn),
  setWhatsApp: (fn) => (waDo = fn),
  onBoard: (fn) => (onBoard = fn),
  stop: () => server && server.close(),
  taskList,
  taskAdd,
  taskUpdate,
  taskRemove,
  init,
  list,
  search,
  saveNote,
  removeNote,
  configFor,
  handleRpc,
  // For the server copy (team-stdio.js): memory in a folder of its own, no app around it.
  useRoot: (dir) => {
    ROOT = dir;
    cache.clear();
  },
  // Files changed under it from elsewhere (Loop Cloud): read everything again.
  forget: () => {
    cache.clear();
    layout.reload();
  },
  startBrief,
  HOUSE_RULES,
  housePlain,
  checkMins,
  setRoot,
  root: () => ROOT,
  _test: { rank, chunk, terms, estimateTokens, parseNote, boardRights, isMine, callTool, rulesFor, companyRules, memberRules, setRootForTest: (dir) => (ROOT = dir) },
};
