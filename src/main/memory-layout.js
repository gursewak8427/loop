// Where each piece of memory lives in the memory folder:
//
//   <root>/company/                              shared by every project
//   <root>/projects/<project>/shared/            shared by every session in the project
//   <root>/projects/<project>/sessions/<name>--<id6>/   one session's own memory
//   <root>/projects/<project>/board.json, team.json      the project's board and team
//
// Folder names are readable (the project's folder name, the session's name),
// so the files can be found by hand. What each folder belongs to is written
// inside it (.loop-project, .loop-session), and loop-memory.json at the root
// remembers it all, so the layout can always be rebuilt from the folders.
//
// Memory is the session's, not the agent's: whichever agent works in a session
// reads and writes the same folder.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const MAP = 'loop-memory.json';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_DIR = /^[A-Za-z0-9_-]+$/;

let rootOf = () => null;
let nameOfProject = async () => '';
let nameOfSession = () => '';
let map = null;
let readyFor = null; // the root the layout was last made ready for
let readyPromise = null;

const slug = (s, max = 40) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');

// A project folder name from Claude Code's folder key, when nothing better is known:
// D--Freelance-projects-Venli -> venli.
const fallbackName = (dir) => slug(String(dir).split('-').filter(Boolean).pop()) || 'project';

function attach(getRoot) {
  rootOf = getRoot;
}
const setProjectNamer = (fn) => (nameOfProject = fn);
const setSessionNamer = (fn) => (nameOfSession = fn);
let remoteOf = async () => '';
const setRemoteLookup = (fn) => (remoteOf = fn);

const root = () => rootOf();
const mapFile = () => path.join(root(), MAP);
const projectsRoot = () => path.join(root(), 'projects');
const companyDir = () => path.join(root(), 'company');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function loadMap() {
  const m = readJson(mapFile());
  map = m && m.format === 2 ? { format: 2, projects: m.projects || {}, sessions: m.sessions || {} } : { format: 2, projects: {}, sessions: {} };
  // The folders say what they are; the map only remembers it.
  let entries = [];
  try {
    entries = fs.readdirSync(projectsRoot(), { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    // no projects yet
  }
  for (const d of entries) {
    const p = readJson(path.join(projectsRoot(), d.name, '.loop-project'));
    if (!p || !SAFE_DIR.test(p.dir || '')) continue;
    map.projects[p.dir] = { folder: d.name };
    let sessions = [];
    try {
      sessions = fs.readdirSync(path.join(projectsRoot(), d.name, 'sessions'), { withFileTypes: true }).filter((x) => x.isDirectory());
    } catch {
      // no sessions yet
    }
    for (const s of sessions) {
      const meta = readJson(path.join(projectsRoot(), d.name, 'sessions', s.name, '.loop-session'));
      if (meta && UUID_RE.test(meta.id || '')) map.sessions[meta.id] = { dir: p.dir, folder: s.name };
    }
  }
  return map;
}

async function saveMap() {
  const tmp = mapFile() + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(map, null, 2));
  await fsp.rename(tmp, mapFile());
}

const taken = (folder) => Object.values(map.projects).some((p) => p.folder === folder);

// The project's folder, made the first time something is saved to it. With
// create false, a project without one gets null and nothing is made.
async function projectDir(dir, { create = true } = {}) {
  if (!SAFE_DIR.test(dir || '')) throw new Error('Invalid project');
  if (!map) loadMap();
  let p = map.projects[dir];
  if (!p && !create) return null;
  if (!p) {
    let name = '';
    try {
      name = slug(await nameOfProject(dir));
    } catch {
      // no name to be had; the fallback will do
    }
    const base = name || fallbackName(dir);
    let folder = base;
    for (let n = 2; taken(folder) || fs.existsSync(path.join(projectsRoot(), folder)); n++) folder = `${base}-${n}`;
    p = map.projects[dir] = { folder };
    await fsp.mkdir(path.join(projectsRoot(), folder), { recursive: true });
    // The git remote names the project across machines, whatever its path there.
    let remote = '';
    try {
      remote = String((await remoteOf(dir)) || '');
    } catch {
      // no remote to be had
    }
    await fsp.writeFile(path.join(projectsRoot(), folder, '.loop-project'), JSON.stringify({ dir, remote }, null, 2));
    await saveMap();
  }
  return path.join(projectsRoot(), p.folder);
}

// Without making anything: the project's folder if it has one.
function projectDirSync(dir) {
  if (!map) loadMap();
  const p = map.projects[dir];
  return p ? path.join(projectsRoot(), p.folder) : null;
}

async function sharedDir(dir, opts) {
  const base = await projectDir(dir, opts);
  return base && path.join(base, 'shared');
}

const wantedFolder = (id) => `${slug(nameOfSession(id), 32) || 'session'}--${id.slice(0, 6)}`;

// One session's folder. With create, it is made, and renamed when the
// session's name has changed since.
async function sessionDir(dir, id, { create = false } = {}) {
  if (!UUID_RE.test(id || '')) throw new Error('Invalid session');
  if (!map) loadMap();
  const proj = await projectDir(dir, { create });
  if (!proj) return null;
  const base = path.join(proj, 'sessions');
  let s = map.sessions[id];
  if (!s || s.dir !== dir) {
    if (!create) return null;
    s = map.sessions[id] = { dir, folder: wantedFolder(id) };
    await fsp.mkdir(path.join(base, s.folder), { recursive: true });
    await fsp.writeFile(path.join(base, s.folder, '.loop-session'), JSON.stringify({ id, dir }, null, 2));
    await saveMap();
    return path.join(base, s.folder);
  }
  const want = wantedFolder(id);
  if (create && want !== s.folder && !fs.existsSync(path.join(base, want))) {
    try {
      await fsp.rename(path.join(base, s.folder), path.join(base, want));
      s.folder = want;
      await saveMap();
    } catch {
      // in use right now; renamed another time
    }
  }
  return path.join(base, s.folder);
}

// Every session of a project that has memory: [{ id, folder }].
async function sessionDirs(dir) {
  if (!map) loadMap();
  const proj = await projectDir(dir, { create: false });
  if (!proj) return [];
  const base = path.join(proj, 'sessions');
  return Object.entries(map.sessions)
    .filter(([, s]) => s.dir === dir)
    .map(([id, s]) => ({ id, folder: path.join(base, s.folder) }));
}

const knownProjects = () => {
  if (!map) loadMap();
  return Object.keys(map.projects);
};

// The index an agent reads first in a folder: every note, by title, with its file.
async function writeIndex(folder, heading, notes) {
  const lines = [`# ${heading}`, '', 'Loop keeps this list. Each note is one file in this folder.', ''];
  for (const n of [...notes].sort((a, b) => a.title.localeCompare(b.title))) {
    const first = (n.body || '').split(/\r?\n/).find((l) => l.trim() && !l.startsWith('#')) || '';
    lines.push(`- [${n.title}](${path.basename(n.file)})${first ? ` — ${first.trim().slice(0, 120)}` : ''}`);
  }
  if (!notes.length) lines.push('No notes yet.');
  await fsp.mkdir(folder, { recursive: true });
  await fsp.writeFile(path.join(folder, 'loop.md'), lines.join('\n') + '\n');
}

// ---- moving memory kept in the first layout ----
//
//   <root>/_company/              -> company/
//   <root>/<dir>/project/         -> projects/<project>/shared/
//   <root>/<dir>/members/<id>/    -> projects/<project>/sessions/<name>--<id6>/
//   <root>/<dir>/<anything else>  -> projects/<project>/
//
// Everything is copied to <root>/.backup-before-new-layout-<time>/ first.

async function moveInto(from, to) {
  await fsp.mkdir(to, { recursive: true });
  for (const e of await fsp.readdir(from, { withFileTypes: true })) {
    let target = path.join(to, e.name);
    if (fs.existsSync(target)) {
      const ext = path.extname(e.name);
      for (let n = 2; fs.existsSync(target); n++) target = path.join(to, `${path.basename(e.name, ext)}-${n}${ext}`);
    }
    await fsp.rename(path.join(from, e.name), target);
  }
}

async function migrate() {
  const r = root();
  let entries = [];
  try {
    entries = await fsp.readdir(r, { withFileTypes: true });
  } catch {
    return { moved: 0 };
  }
  const old = entries.filter((d) => d.isDirectory() && SAFE_DIR.test(d.name) && d.name !== 'projects' && d.name !== 'company');
  if (!old.length) return { moved: 0 };
  const backup = path.join(r, `.backup-before-new-layout-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  for (const d of old) await fsp.cp(path.join(r, d.name), path.join(backup, d.name), { recursive: true });
  for (const d of old) {
    const from = path.join(r, d.name);
    if (d.name === '_company') {
      await moveInto(from, companyDir());
    } else {
      const proj = await projectDir(d.name);
      for (const e of await fsp.readdir(from, { withFileTypes: true })) {
        const p = path.join(from, e.name);
        if (e.isDirectory() && e.name === 'project') await moveInto(p, path.join(proj, 'shared'));
        else if (e.isDirectory() && e.name === 'members') {
          for (const m of await fsp.readdir(p, { withFileTypes: true })) {
            if (!m.isDirectory() || !UUID_RE.test(m.name)) continue;
            await moveInto(path.join(p, m.name), await sessionDir(d.name, m.name, { create: true }));
          }
        } else if (!fs.existsSync(path.join(proj, e.name))) await fsp.rename(p, path.join(proj, e.name));
      }
    }
    await fsp.rm(from, { recursive: true, force: true });
  }
  return { moved: old.length, backup };
}

// Called before memory is read or written: loads the layout for the current
// root, and moves memory kept in the first layout, once.
async function prune() {
  let changed = false;
  for (const [dir, p] of Object.entries(map.projects)) {
    const folder = path.join(projectsRoot(), p.folder);
    let names = [];
    try {
      names = await fsp.readdir(folder);
    } catch {
      names = [];
    }
    if (names.some((n) => n !== '.loop-project')) continue;
    await fsp.rm(path.join(folder, '.loop-project'), { force: true });
    await fsp.rmdir(folder).catch(() => {});
    delete map.projects[dir];
    changed = true;
  }
  if (changed) await saveMap();
}

// Markers from before remotes were kept get theirs filled in, once.
async function noteRemotes() {
  for (const [dir, p] of Object.entries(map.projects)) {
    const marker = path.join(projectsRoot(), p.folder, '.loop-project');
    const have = readJson(marker);
    if (!have || 'remote' in have) continue;
    let remote = '';
    try {
      remote = String((await remoteOf(dir)) || '');
    } catch {
      // unknown; written as empty so this is not asked again
    }
    await fsp.writeFile(marker, JSON.stringify({ ...have, remote }, null, 2)).catch(() => {});
  }
}

function ready() {
  const r = root();
  if (readyFor === r && readyPromise) return readyPromise;
  readyFor = r;
  map = null;
  loadMap();
  readyPromise = migrate()
    .then(async (out) => {
      await prune().catch(() => {});
      await noteRemotes().catch(() => {});
      return out;
    })
    .catch((e) => ({ moved: 0, error: e.message }));
  return readyPromise;
}

// Folders were added from elsewhere: read the layout from them again.
const reload = () => {
  map = null;
};

module.exports = {
  attach,
  reload,
  setProjectNamer,
  setSessionNamer,
  setRemoteLookup,
  ready,
  projectDir,
  projectDirSync,
  sharedDir,
  companyDir,
  sessionDir,
  sessionDirs,
  knownProjects,
  writeIndex,
  fallbackName,
  slug,
};
