// Brings each agent's own memory and instructions into Loop's memory, so Loop
// holds one memory that every agent in a session reads. The agents' files are
// only read; Loop keeps a copy. Where each agent keeps them: see sources().
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const memory = require('./memory');
const { CLAUDE_DIR } = require('./scanner');

const HOME = os.homedir();
const MAX = 400 * 1024; // a memory file larger than this is not a memory

const idOf = (file) => crypto.createHash('sha1').update(path.resolve(file).toLowerCase()).digest('hex').slice(0, 12);

function stat(file) {
  try {
    const s = fs.statSync(file);
    return s.isFile() && s.size > 0 && s.size <= MAX ? s : null;
  } catch {
    return null;
  }
}

function mdIn(folder) {
  try {
    return fs
      .readdirSync(folder)
      .filter((n) => n.toLowerCase().endsWith('.md'))
      .map((n) => path.join(folder, n));
  } catch {
    return [];
  }
}

// The title a file gives itself, or one made from its name.
function titleOf(raw, file, fallback) {
  const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (head) {
    const name = /^(?:title|name):\s*(.+)$/m.exec(head[1]);
    if (name) return name[1].replace(/^"(.*)"$/, '$1').replace(/-/g, ' ').trim();
  }
  const h1 = /^#\s+(.+)$/m.exec(raw);
  if (h1 && !fallback && !['MEMORY', 'CLAUDE', 'AGENTS', 'GEMINI'].includes(path.basename(file, '.md'))) return h1[1].trim();
  return fallback || path.basename(file, '.md').replace(/[-_]/g, ' ');
}

// Every Markdown file in a folder and its sub-folders, a few levels deep.
function mdTree(folder, depth = 3, skip = []) {
  const out = [];
  const walk = (d, left) => {
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && left > 0) walk(p, left - 1);
      else if (e.isFile() && e.name.toLowerCase().endsWith('.md') && !skip.includes(e.name)) out.push(p);
    }
  };
  walk(folder, depth);
  return out;
}

// Instruction files further down the project: a sub-project's own CLAUDE.md,
// AGENTS.md or GEMINI.md. Code that is downloaded or built is not looked in.
const NOT_HERE = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'vendor', '.venv', 'venv', 'target', 'Pods', '.dart_tool', '.gradle']);
function nested(projectPath, names, depth = 3) {
  const out = [];
  const walk = (d, left) => {
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || NOT_HERE.has(e.name) || e.name.startsWith('.')) continue;
      const sub = path.join(d, e.name);
      for (const n of names) {
        const f = path.join(sub, n);
        if (fs.existsSync(f)) out.push(f);
      }
      if (left > 1) walk(sub, left - 1);
    }
  };
  if (projectPath) walk(projectPath, depth);
  return out;
}

const slugOf = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

// What there is to bring in for one project, from every agent Loop runs.
// Where each agent keeps things (as documented, Nov 2026):
//
//   Claude Code  CLAUDE.md, .claude/CLAUDE.md, CLAUDE.local.md, .claude/rules/*.md in the project;
//                ~/.claude/CLAUDE.md and ~/.claude/rules/*.md for every project;
//                its own memory in ~/.claude/projects/<project>/memory/*.md (MEMORY.md is the index)
//   Codex        AGENTS.md, AGENTS.override.md in the project; the same two in ~/.codex;
//                its memories, one set for all projects, in ~/.codex/memories (or memories_v2)
//   Kimi Code    AGENTS.md, .kimi-code/AGENTS.md in the project; ~/.kimi-code/AGENTS.md;
//                ~/.agents/AGENTS.md, which any agent may read
//   Grok Build   AGENTS.md (and CLAUDE.md), .grok/rules/*.md in the project; ~/.grok/AGENTS.md;
//                its memory in ~/.grok/memory: MEMORY.md for all projects, a folder per workspace
//   Gemini       GEMINI.md, .agent/rules/*.md (Antigravity) in the project; ~/.gemini/GEMINI.md,
//                which also holds what it was told to remember; Antigravity knowledge items
//
// A file of one project goes to that project's memory; a file for every project
// goes to the company shelf.
function sources(dir, projectPath, home = HOME, claudeDir = CLAUDE_DIR) {
  const out = [];
  const add = (agent, file, scope, title) => {
    if (!file) return;
    const s = stat(file);
    if (!s || out.some((x) => x.file === file && x.agent === agent)) return;
    out.push({ id: idOf(file), agent, file, scope, title, size: s.size, updated: s.mtimeMs });
  };
  const inProject = (...parts) => (projectPath ? path.join(projectPath, ...parts) : '');
  const rel = (f) => (projectPath ? path.relative(projectPath, f).replace(/\\/g, '/') : path.basename(f));
  const codexHome = process.env.CODEX_HOME || path.join(home, '.codex');
  const kimiHome = process.env.KIMI_CODE_HOME || path.join(home, '.kimi-code');
  const name = slugOf(projectPath ? path.basename(projectPath) : '');

  // Claude Code
  for (const f of mdIn(path.join(claudeDir, 'projects', dir, 'memory'))) if (path.basename(f) !== 'MEMORY.md') add('claude', f, 'project');
  add('claude', inProject('CLAUDE.md'), 'project', 'Project instructions (CLAUDE.md)');
  add('claude', inProject('.claude', 'CLAUDE.md'), 'project', 'Project instructions (.claude/CLAUDE.md)');
  add('claude', inProject('CLAUDE.local.md'), 'project', 'Your own notes for this project (CLAUDE.local.md)');
  for (const f of mdTree(inProject('.claude', 'rules'), 2)) add('claude', f, 'project', `Project rule: ${rel(f)}`);
  for (const f of nested(projectPath, ['CLAUDE.md', 'CLAUDE.local.md'])) add('claude', f, 'project', `Instructions in ${rel(f)}`);
  add('claude', path.join(claudeDir, 'CLAUDE.md'), 'company', 'Your instructions for every project (CLAUDE.md)');
  for (const f of mdTree(path.join(claudeDir, 'rules'), 2)) add('claude', f, 'company', `Your rule for every project: ${path.basename(f, '.md')}`);

  // Codex
  add('codex', inProject('AGENTS.md'), 'project', 'Project instructions (AGENTS.md)');
  add('codex', inProject('AGENTS.override.md'), 'project', 'Project instructions (AGENTS.override.md)');
  for (const f of nested(projectPath, ['AGENTS.md', 'AGENTS.override.md'])) add('codex', f, 'project', `Instructions in ${rel(f)}`);
  add('codex', path.join(codexHome, 'AGENTS.md'), 'company', 'Your instructions for every project (AGENTS.md)');
  add('codex', path.join(codexHome, 'AGENTS.override.md'), 'company', 'Your instructions for every project (AGENTS.override.md)');
  for (const folder of ['memories', 'memories_v2']) {
    add('codex', path.join(codexHome, folder, 'MEMORY.md'), 'company', 'What Codex remembers, for every project (MEMORY.md)');
    add('codex', path.join(codexHome, folder, 'memory_summary.md'), 'company', 'Codex memory summary, for every project');
  }

  // Kimi Code
  add('kimi', inProject('AGENTS.md'), 'project', 'Project instructions (AGENTS.md)');
  add('kimi', inProject('.kimi-code', 'AGENTS.md'), 'project', 'Project instructions (.kimi-code/AGENTS.md)');
  add('kimi', path.join(kimiHome, 'AGENTS.md'), 'company', 'Your Kimi instructions for every project (AGENTS.md)');
  add('kimi', path.join(home, '.agents', 'AGENTS.md'), 'company', 'Instructions any agent reads (~/.agents/AGENTS.md)');

  // Grok Build
  add('grok', inProject('AGENTS.md'), 'project', 'Project instructions (AGENTS.md)');
  for (const f of mdTree(inProject('.grok', 'rules'), 2)) add('grok', f, 'project', `Project rule: ${rel(f)}`);
  add('grok', path.join(home, '.grok', 'AGENTS.md'), 'company', 'Your Grok instructions for every project (AGENTS.md)');
  const grokMemory = path.join(home, '.grok', 'memory');
  add('grok', path.join(grokMemory, 'MEMORY.md'), 'company', 'What Grok remembers, for every project (MEMORY.md)');
  for (const f of mdTree(path.join(grokMemory, 'topics'), 1)) add('grok', f, 'company', `What Grok remembers: ${path.basename(f, '.md')}`);
  let workspaces = [];
  try {
    workspaces = fs.readdirSync(grokMemory, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== 'topics');
  } catch {
    // no Grok memory here
  }
  // A workspace folder is named after its project; only this project's is taken.
  for (const w of workspaces) {
    if (!name || !slugOf(w.name).includes(name)) continue;
    for (const f of mdTree(path.join(grokMemory, w.name), 2)) add('grok', f, 'project', `What Grok remembers here: ${path.basename(f, '.md')}`);
  }

  // Gemini (Antigravity)
  add('antigravity', inProject('GEMINI.md'), 'project', 'Project instructions (GEMINI.md)');
  for (const f of nested(projectPath, ['GEMINI.md'])) add('antigravity', f, 'project', `Instructions in ${rel(f)}`);
  for (const f of mdTree(inProject('.agent', 'rules'), 2)) add('antigravity', f, 'project', `Project rule: ${rel(f)}`);
  add('antigravity', path.join(home, '.gemini', 'GEMINI.md'), 'company', 'Your instructions and what Gemini remembers, for every project (GEMINI.md)');
  for (const f of mdTree(path.join(home, '.gemini', 'antigravity', 'knowledge'), 3)) add('antigravity', f, 'company', `Antigravity knowledge: ${path.basename(f, '.md')}`);
  return out;
}

// The list for the window: what each file is called, where it goes, and
// whether Loop already holds a copy (a note tagged with the file's id).
async function list(dir, projectPath) {
  const notes = await memory.listAll(dir);
  const have = new Set();
  for (const n of notes) for (const t of n.tags || []) if (t.startsWith('from-')) have.add(t.slice(5));
  return sources(dir, projectPath).map((s) => {
    let raw = '';
    try {
      raw = fs.readFileSync(s.file, 'utf8');
    } catch {
      // unreadable now; shown without a title of its own
    }
    return { ...s, title: titleOf(raw, s.file, s.title), imported: have.has(s.id) };
  });
}

// Copies the chosen files into Loop's memory. Returns how many were added.
async function bring(dir, projectPath, ids) {
  const want = new Set(ids);
  const all = await list(dir, projectPath);
  let added = 0;
  for (const s of all) {
    if (!want.has(s.id) || s.imported) continue;
    const raw = fs.readFileSync(s.file, 'utf8');
    const head = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
    const description = head && /^description:\s*(.+)$/m.exec(head[1]);
    const body = ((description ? description[1].replace(/^"(.*)"$/, '$1').trim() + '\n\n' : '') + (head ? head[2] : raw).trim()).trim();
    await memory.saveNote({ dir, scope: s.scope, title: s.title, body, tags: ['imported', s.agent, `from-${s.id}`], author: `Imported from ${s.agent}` });
    added++;
  }
  return added;
}

module.exports = { list, bring, sources, mdTree };
