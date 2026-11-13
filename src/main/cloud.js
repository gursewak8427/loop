// Loop Cloud on this machine: signing in with an emailed code, and keeping
// each project's memory at loop.prismaple.com the way that project is set:
//
//   local   This PC only: nothing goes up.
//   backup  Backed up: every change goes up a few seconds after it is made.
//           The cloud is a safety copy; nothing comes down on its own.
//   linked  Linked: the project's memory is the cloud's. Changes go up within
//           seconds and changes from other machines come down within seconds.
//           A linked project has the cloud project's folder name here, so
//           both machines use the same paths, whatever their project folders
//           are called.
//
// Notes for every project (company/) follow the account: kept in step on every
// machine unless new projects start as This PC only.
//
// Only the memory goes up: notes (.md), the folder markers Loop writes, and a
// project's board and team. Nothing is ever deleted here because of the cloud:
// a file deleted elsewhere is moved to <memory>/.removed-by-sync/, and when both
// sides changed a note, the cloud's copy is kept next to it.
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const BASE = (process.env.LOOP_CLOUD_URL || 'https://loop.prismaple.com').replace(/\/+$/, '');
const MAX_FILE = 1024 * 1024;
const LINK_EVERY = 20e3; // a linked project looks for other machines' changes this often
const SCAN_EVERY = 10 * 60e3; // and everything is checked this often, in case a change was missed
const SETTLE = 3e3; // a change goes up once the memory has been still this long
const BACKUP_EVERY = 24 * 3600e3; // one restorable snapshot a day
const MODES = ['off', 'backup', 'sync']; // the old single switch, still understood
const PROJECT_MODES = ['local', 'backup', 'linked'];

let file = ''; // userData/cloud.json: who is signed in, the token (encrypted), the mode
let syncFile = ''; // userData/cloud-sync.json: what each file was at the last sync
let crypt = { encrypt: (s) => s, decrypt: (s) => s };
let rootOf = () => '';
let onChange = () => {};
let afterPull = () => {};
let st = { email: '', token: '', deviceId: '', mode: 'off', projects: {}, defaultMode: 'backup', lastSync: 0, lastBackup: 0, used: 0, quota: 0, error: '' };
let dirty = false; // something in the memory changed since the last sync
let settle = null;
let watcher = null;
let watchedRoot = '';
let busy = null; // the sync or backup running now
let timer = null;

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    let token = '';
    try {
      token = raw.token ? crypt.decrypt(raw.token) : '';
    } catch {
      token = ''; // made on another Windows login: sign in again
    }
    st = { ...st, ...raw, token, mode: MODES.includes(raw.mode) ? raw.mode : 'off', error: '' };
    if (!raw.projects || typeof raw.projects !== 'object') {
      // From the single switch of before: Off, Backup, or Sync (every project linked).
      st.projects = {};
      st.defaultMode = st.mode === 'off' ? 'local' : 'backup';
      st.linkAllOnce = st.mode === 'sync';
    }
    if (!PROJECT_MODES.includes(st.defaultMode)) st.defaultMode = 'backup';
  } catch {
    // not signed in yet
  }
}

function save() {
  const { token, ...rest } = st;
  const out = { ...rest, token: token ? crypt.encrypt(token) : '' };
  try {
    fs.writeFileSync(file, JSON.stringify(out, null, 2));
  } catch {
    // kept in memory until the next save
  }
}

// What the window may see: never the token.
function state() {
  return {
    signedIn: Boolean(st.token),
    email: st.email,
    mode: st.mode,
    projects: st.projects,
    defaultMode: st.defaultMode,
    lastSync: st.lastSync,
    lastBackup: st.lastBackup,
    used: st.used,
    quota: st.quota,
    error: st.error,
    busy: busy ? busy.what : '',
    site: BASE,
  };
}

function changed() {
  save();
  onChange(state());
}

async function call(method, url, body, opts = {}) {
  const headers = { 'User-Agent': 'Loop' };
  if (st.token && !opts.anon) headers.Authorization = `Bearer ${st.token}`;
  if (body) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(BASE + url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(opts.timeout || 60e3) });
  } catch (e) {
    throw new Error(`Could not reach Loop Cloud (${e.cause ? e.cause.code || e.cause.message : e.message}).`);
  }
  if (res.status === 401 && !opts.anon) {
    // Signed out from the website or another machine.
    st.token = '';
    st.error = 'Signed out of Loop Cloud. Sign in again to keep backing up.';
    changed();
    throw new Error(st.error);
  }
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error((data && data.error) || `Loop Cloud answered ${res.status}.`);
  return data;
}

// ---- signing in ----

async function sendCode(email) {
  await call('POST', '/api/auth/code', { email: String(email || '').trim() }, { anon: true });
  return { ok: true };
}

async function verify(email, code) {
  const r = await call('POST', '/api/auth/verify', { email: String(email || '').trim(), code: String(code || ''), kind: 'machine', name: os.hostname() }, { anon: true });
  // What was sent before belongs to that sign-in: the account may since have
  // been deleted and made again under the same email. Starting fresh costs one
  // look at every file; the cloud keeps anything identical it already has.
  await fsp.rm(syncFile, { force: true }).catch(() => {});
  // A fresh sign-in: everything goes up and a first snapshot is made at once.
  st = { ...st, email: r.email, token: r.token, deviceId: r.deviceId, error: '', mode: st.mode === 'off' ? 'backup' : st.mode, lastSync: 0, lastBackup: 0 };
  changed();
  await refresh().catch(() => {});
  schedule();
  setTimeout(() => tick(true), 1500);
  return state();
}

async function signOut() {
  if (st.token) await call('POST', '/api/auth/logout').catch(() => {});
  st = { ...st, token: '', deviceId: '', error: '' };
  changed();
  return state();
}

async function refresh() {
  const me = await call('GET', '/api/me');
  st.used = me.used;
  st.quota = me.quota;
  changed();
  return me;
}

function setMode(mode) {
  if (!MODES.includes(mode)) throw new Error('No such mode');
  st.mode = mode;
  st.error = '';
  if (mode === 'sync') {
    st.defaultMode = 'linked';
    for (const dir of folderDirs(rootOf()).values()) st.projects[dir] = 'linked';
  } else {
    st.defaultMode = mode === 'off' ? 'local' : 'backup';
    for (const dir of Object.keys(st.projects)) if (st.projects[dir] === 'linked') st.projects[dir] = st.defaultMode;
  }
  changed();
  schedule();
  if (mode !== 'off') setTimeout(() => tick(true), 500);
  return state();
}

// ---- project by project ----

// Each memory folder here and the project it belongs to, from its marker. A
// folder with no marker (from before markers) goes by its own name.
function folderDirs(root) {
  const out = new Map();
  if (!root) return out;
  let names = [];
  try {
    names = fs.readdirSync(path.join(root, 'projects'), { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.'));
  } catch {
    return out;
  }
  for (const d of names) {
    let dir = '';
    try {
      dir = String(JSON.parse(fs.readFileSync(path.join(root, 'projects', d.name, '.loop-project'), 'utf8')).dir || '');
    } catch {
      // no marker
    }
    out.set(d.name, dir || `folder:${d.name}`);
  }
  return out;
}

const modeOf = (dir) => (PROJECT_MODES.includes(st.projects[dir]) ? st.projects[dir] : st.defaultMode);
const companyMode = () => (st.defaultMode === 'local' ? 'local' : 'linked');

// How a file in the memory folder is kept, by the project it belongs to.
function modeOfPath(rel, dirs) {
  const seg = rel.split('/');
  if (seg[0] === 'company') return companyMode();
  if (seg[0] !== 'projects' || !seg[1]) return 'local';
  return modeOf(dirs.get(seg[1]) || `folder:${seg[1]}`);
}

function setProjectMode(dir, mode) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(dir)) || !PROJECT_MODES.includes(mode)) throw new Error('No such setting');
  st.projects[dir] = mode;
  st.error = '';
  changed();
  if (mode !== 'local') {
    dirty = true;
    setTimeout(() => tick(true).catch(() => {}), 300);
  }
  return state();
}

function setDefaultMode(mode) {
  if (!PROJECT_MODES.includes(mode)) throw new Error('No such setting');
  st.defaultMode = mode;
  changed();
  setTimeout(() => tick(true).catch(() => {}), 300);
  return state();
}

// ---- the files ----

const SAFE_PART = /^[A-Za-z0-9._ -]+$/;
function wanted(rel) {
  const parts = rel.split('/');
  if (parts.length > 8 || rel.length > 400) return false;
  for (const p of parts) if (!SAFE_PART.test(p) || p === '.' || p === '..' || p.length > 120) return false;
  if (parts.slice(0, -1).some((p) => p.startsWith('.'))) return false;
  if (parts[0] !== 'company' && parts[0] !== 'projects') return false;
  const name = parts[parts.length - 1];
  if (name === '.loop-project' || name === '.loop-session') return true;
  if (name.startsWith('.')) return false;
  if (/\.md$/i.test(name)) return true;
  return parts.length === 3 && parts[0] === 'projects' && (name === 'board.json' || name === 'team.json');
}

// Every file to keep, with its hash. Hashes are reused while size and time match.
async function scan(root, known) {
  const out = new Map();
  let skipped = 0;
  const walk = async (dir, rel) => {
    let entries = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!e.name.startsWith('.')) await walk(path.join(dir, e.name), r);
        continue;
      }
      if (!e.isFile() || !wanted(r)) continue;
      const full = path.join(dir, e.name);
      const s = await fsp.stat(full).catch(() => null);
      if (!s) continue;
      if (s.size > MAX_FILE) {
        skipped++;
        continue;
      }
      const k = known[r];
      if (k && k.size === s.size && k.mtime === Math.round(s.mtimeMs)) out.set(r, { hash: k.hash, size: s.size, mtime: k.mtime });
      else out.set(r, { hash: sha(await fsp.readFile(full)), size: s.size, mtime: Math.round(s.mtimeMs) });
    }
  };
  await walk(path.join(root, 'company'), 'company');
  await walk(path.join(root, 'projects'), 'projects');
  return { files: out, skipped };
}

function readSync() {
  try {
    const s = JSON.parse(fs.readFileSync(syncFile, 'utf8'));
    if (s.email === st.email && s.root === rootOf()) return { cursor: s.cursor || 0, files: s.files || {} };
  } catch {
    // never synced
  }
  return { cursor: 0, files: {} };
}

function writeSync(m) {
  fs.writeFileSync(syncFile, JSON.stringify({ email: st.email, root: rootOf(), cursor: m.cursor, files: m.files }));
}

const inRoot = (root, rel) => {
  const full = path.resolve(root, ...rel.split('/'));
  if (!full.startsWith(path.resolve(root) + path.sep)) throw new Error('Outside the memory folder');
  return full;
};

async function writeFile(root, rel, text) {
  const full = inRoot(root, rel);
  await fsp.mkdir(path.dirname(full), { recursive: true });
  const tmp = full + '.cloud-tmp';
  await fsp.writeFile(tmp, text);
  await fsp.rename(tmp, full);
  const s = await fsp.stat(full);
  return { size: s.size, mtime: Math.round(s.mtimeMs) };
}

// Kept, not deleted: <memory>/.removed-by-sync/<time>/<path>.
async function setAside(root, rel, stamp) {
  const from = inRoot(root, rel);
  const to = path.join(root, '.removed-by-sync', stamp, ...rel.split('/'));
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await fsp.rename(from, to);
}

const conflictName = (rel) => {
  const t = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  return rel.replace(/(\.md)$/i, `.from-cloud-${t}$1`);
};

// Sends local changes up in batches of a few megabytes.
async function push(root, ups, dels) {
  let batch = [];
  let size = 0;
  const results = [];
  const flush = async (del) => {
    if (!batch.length && !(del && del.length)) return;
    const r = await call('POST', '/api/files/batch', { put: batch, del: del || [] }, { timeout: 120e3 });
    results.push(...r.results);
    st.used = r.used;
    st.quota = r.quota;
    batch = [];
    size = 0;
  };
  for (const rel of ups) {
    const content = await fsp.readFile(inRoot(root, rel), 'utf8').catch(() => null);
    if (content == null) continue;
    const s = await fsp.stat(inRoot(root, rel)).catch(() => null);
    batch.push({ path: rel, content, updated: s ? Math.round(s.mtimeMs) : Date.now() });
    size += Buffer.byteLength(content);
    if (size > 6 * 1024 * 1024 || batch.length >= 500) await flush();
  }
  await flush(dels);
  return results;
}

// Two ways: what changed elsewhere comes down, what changed here goes up.
// Backup mode only sends this machine's memory up.
async function run() {
  const root = rootOf();
  if (!root || !fs.existsSync(root)) throw new Error('There is no memory folder yet.');
  const m = readSync();
  const { files: local } = await scan(root, m.files);
  const dirs = folderDirs(root);
  if (st.linkAllOnce) {
    // Sync was on before projects had their own settings: every project here is linked.
    for (const dir of dirs.values()) st.projects[dir] = 'linked';
    st.linkAllOnce = false;
    save();
  }
  const how = (rel) => modeOfPath(rel, dirs);
  // Projects this machine does not have stay in the cloud until one is linked here.
  const localFolders = new Set(dirs.keys());
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let pulled = 0;
  const both = companyMode() === 'linked' || [...dirs.values()].some((d) => modeOf(d) === 'linked');

  if (both) {
    let more = true;
    while (more) {
      const r = await call('GET', `/api/files?since=${m.cursor}`);
      for (const f of r.files) {
        if (!wanted(f.path) || f.path.endsWith('/.loop-project')) continue; // each machine keeps its own marker
        const seg = f.path.split('/');
        if (seg[0] === 'projects' && !localFolders.has(seg[1])) continue;
        if (how(f.path) !== 'linked') continue; // backed up or this PC only: nothing comes down
        const base = m.files[f.path];
        const here = local.get(f.path);
        const changedHere = here ? !base || here.hash !== base.hash : Boolean(base);
        if (f.deleted) {
          if (here && !changedHere) {
            await setAside(root, f.path, stamp);
            local.delete(f.path);
            pulled++;
          }
          delete m.files[f.path];
          continue;
        }
        if (here && here.hash === f.hash) {
          m.files[f.path] = { ...here };
          continue;
        }
        const text = await call('GET', `/api/files/content?path=${encodeURIComponent(f.path)}`);
        if (here && changedHere) {
          // Both sides changed it: this machine's stays, the cloud's sits beside it.
          if (/\.md$/i.test(f.path)) {
            const side = conflictName(f.path);
            const w = await writeFile(root, side, text);
            local.set(side, { hash: sha(Buffer.from(text)), ...w });
            pulled++;
          }
          continue;
        }
        const w = await writeFile(root, f.path, text);
        const entry = { hash: sha(Buffer.from(text)), ...w };
        local.set(f.path, entry);
        m.files[f.path] = entry;
        pulled++;
      }
      m.cursor = r.cursor;
      more = r.more;
    }
  }

  const ups = [...local.entries()].filter(([rel, f]) => how(rel) !== 'local' && (!m.files[rel] || m.files[rel].hash !== f.hash)).map(([rel]) => rel);
  const dels = Object.keys(m.files).filter((rel) => !local.has(rel) && how(rel) !== 'local');
  await push(root, ups, dels);
  for (const rel of ups) m.files[rel] = local.get(rel);
  for (const rel of dels) delete m.files[rel];
  // This machine's own changes come back in the next list, where their hashes
  // match and nothing is downloaded.
  writeSync(m);
  if (pulled) afterPull();
  return { pulled, pushed: ups.length, deleted: dels.length };
}

function once(what, fn, quiet) {
  if (busy) return busy.promise;
  const hadError = st.error;
  const promise = (async () => {
    let out;
    try {
      out = await fn();
      st.error = '';
      return out;
    } catch (e) {
      st.error = e.message;
      throw e;
    } finally {
      busy = null;
      // A background check that moved nothing is not news.
      const moved = out && (out.pulled || out.pushed || out.deleted);
      if (quiet && !moved && !st.error && !hadError) save();
      else changed();
    }
  })();
  busy = { what, promise };
  if (!quiet) onChange(state());
  return promise;
}

function syncNow(quiet) {
  if (!st.token) return Promise.reject(new Error('Sign in to Loop Cloud first.'));
  return once(
    'sync',
    async () => {
      const out = await run();
      st.lastSync = Date.now();
      return out;
    },
    quiet,
  );
}

function backupNow() {
  if (!st.token) return Promise.reject(new Error('Sign in to Loop Cloud first.'));
  return once('backup', async () => {
    const out = await run();
    const b = await call('POST', '/api/backups', { label: `From ${os.hostname()}` });
    st.lastSync = Date.now();
    st.lastBackup = Date.now();
    return { ...out, backup: b };
  });
}

const backups = () => call('GET', '/api/backups');

// Puts a backup's files back. Every file it would replace is copied first to
// <memory>/.backup-before-restore-<time>/; files not in the backup stay.
async function restore(id) {
  if (!/^\d+$/.test(String(id))) throw new Error('No such backup');
  return once('restore', async () => {
    const root = rootOf();
    const list = await call('GET', `/api/backups/${id}/files`);
    const keep = path.join(root, `.backup-before-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    let put = 0;
    for (const f of list) {
      if (!wanted(f.path)) continue;
      const full = inRoot(root, f.path);
      const now = fs.existsSync(full) ? await fsp.readFile(full) : null;
      if (now && sha(now) === f.hash) continue;
      if (now) {
        const copy = path.join(keep, ...f.path.split('/'));
        await fsp.mkdir(path.dirname(copy), { recursive: true });
        await fsp.writeFile(copy, now);
      }
      await writeFile(root, f.path, await call('GET', `/api/backups/${id}/content?path=${encodeURIComponent(f.path)}`));
      put++;
    }
    afterPull();
    return { restored: put, keptIn: put && fs.existsSync(keep) ? keep : '' };
  });
}

// ---- now and then ----

async function tick(force) {
  if (!st.token || busy) return;
  if (rootOf() !== watchedRoot) watch(); // the memory folder moved
  const dirs = folderDirs(rootOf());
  const modes = [...dirs.values()].map(modeOf);
  modes.push(companyMode());
  const anyUp = modes.some((x) => x !== 'local');
  const anyLinked = modes.includes('linked');
  if (!anyUp && !force) return;
  const now = Date.now();
  try {
    if (force || dirty || (anyLinked && now - st.lastSync > LINK_EVERY) || now - st.lastSync > SCAN_EVERY) {
      dirty = false;
      await syncNow(!force);
    }
    if (anyUp && now - st.lastBackup > BACKUP_EVERY) await snapshot();
  } catch {
    // shown in the panel as st.error
  }
}

// One restorable copy a day, kept by the cloud.
async function snapshot() {
  await call('POST', '/api/backups', { label: `From ${os.hostname()}` });
  st.lastBackup = Date.now();
  save();
}

// A note written anywhere in the memory folder goes up once things settle.
function watch() {
  if (watcher) watcher.close();
  watcher = null;
  const root = rootOf();
  watchedRoot = root;
  if (!st.token || !root || !fs.existsSync(root)) return;
  try {
    watcher = fs.watch(root, { recursive: true }, (_ev, name) => {
      const rel = String(name || '').split(path.sep).join('/');
      if (!rel || !wanted(rel)) return;
      dirty = true;
      clearTimeout(settle);
      settle = setTimeout(() => tick(false).catch(() => {}), SETTLE);
      if (settle.unref) settle.unref();
    });
    watcher.on('error', () => {});
    if (watcher.unref) watcher.unref(); // never what keeps Loop (or a test) running
  } catch {
    // no watching here: the regular check still finds changes
  }
}

function schedule() {
  clearInterval(timer);
  timer = null;
  if (st.token) {
    timer = setInterval(() => tick(false), 5e3);
    if (timer.unref) timer.unref();
  }
  watch();
}

function init(userData, opts = {}) {
  file = path.join(userData, 'cloud.json');
  syncFile = path.join(userData, 'cloud-sync.json');
  if (opts.encrypt && opts.decrypt) crypt = { encrypt: opts.encrypt, decrypt: opts.decrypt };
  if (opts.root) rootOf = opts.root;
  if (opts.onChange) onChange = opts.onChange;
  if (opts.afterPull) afterPull = opts.afterPull;
  load();
  schedule();
  // A little after start, catch up on what changed while Loop was closed.
  if (st.token) setTimeout(() => tick(true).catch(() => {}), 20e3).unref?.();
}

function stop() {
  clearInterval(timer);
  timer = null;
  clearTimeout(settle);
  if (watcher) watcher.close();
  watcher = null;
}

// ---- what the cloud holds, project by project, and bringing it in ----
//
// A new machine signs in and the cloud already has memory from another one.
// Folder structure differs between machines, so a project is recognised by its
// git remote first, then by its folder key, then by its name — and when none
// of those fit, the user links it by hand. Bringing in copies notes down; it
// never replaces anything local.

// A git remote as a name both machines agree on: host/owner/repo.
function normalizeRemote(url) {
  let s = String(url || '').trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/\.git\/?$/, '');
  s = s.replace(/^[a-z+]+:\/\//, '');
  s = s.replace(/^[^/@]*@/, '');
  s = s.replace(/:(?!\d)/, '/');
  return s.replace(/\/+$/, '');
}

const slugName = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');

// Everything in the cloud right now, as one list of files.
async function listAllCloud() {
  const all = new Map();
  let since = 0;
  for (;;) {
    const r = await call('GET', `/api/files?since=${since}`);
    for (const f of r.files) {
      if (f.deleted) all.delete(f.path);
      else all.set(f.path, f);
    }
    since = r.cursor;
    if (!r.more) break;
  }
  return [...all.values()];
}

let projCache = null;

// The projects whose memory is in the cloud: folder, note count, and what its
// marker remembers of where it lived (folder key, git remote).
async function cloudProjects(fresh) {
  if (!st.token) throw new Error('Sign in to Loop Cloud first.');
  if (!fresh && projCache && Date.now() - projCache.at < 120e3) return projCache;
  const files = await listAllCloud();
  const folders = new Map();
  let companyNotes = 0;
  for (const f of files) {
    const parts = f.path.split('/');
    if (parts[0] === 'company' && parts.length === 2 && /\.md$/i.test(parts[1]) && parts[1] !== 'loop.md') companyNotes++;
    if (parts[0] !== 'projects' || parts.length < 3) continue;
    const p = folders.get(parts[1]) || { folder: parts[1], notes: 0, dir: '', remote: '', updated: 0 };
    if (/\.md$/i.test(f.path) && parts[parts.length - 1] !== 'loop.md') p.notes++;
    p.updated = Math.max(p.updated, Number(f.updated) || 0);
    folders.set(parts[1], p);
  }
  for (const p of folders.values()) {
    try {
      const marker = JSON.parse(await call('GET', `/api/files/content?path=${encodeURIComponent(`projects/${p.folder}/.loop-project`)}`));
      p.dir = String(marker.dir || '');
      p.remote = normalizeRemote(marker.remote);
    } catch {
      // no marker: matched by name only
    }
  }
  projCache = { at: Date.now(), list: [...folders.values()], companyNotes };
  return projCache;
}

// Which local project each cloud project is: the same git remote first, then
// the same folder key, then the same name. Each local project matches once.
function matchProjects(cloud, locals) {
  const taken = new Set();
  const out = cloud.map((c) => ({ ...c, match: null }));
  const pass = (how, fits) => {
    for (const c of out) {
      if (c.match) continue;
      const hit = locals.find((l) => !taken.has(l.dir) && fits(c, l));
      if (hit) {
        taken.add(hit.dir);
        c.match = { dir: hit.dir, name: hit.name, how };
      }
    }
  };
  // Brought in before: the local memory folder already bears the cloud project's name.
  pass('linked', (c, l) => l.folder && c.folder === l.folder);
  pass('remote', (c, l) => c.remote && c.remote === normalizeRemote(l.remote));
  pass('dir', (c, l) => c.dir && c.dir === l.dir);
  pass('name', (c, l) => slugName(c.folder) && slugName(c.folder) === slugName(l.name));
  return out;
}

// The local folder a cloud project's memory lands in: the folder its project
// already has here, else the cloud's own name, made unique if taken.
function localFolderFor(root, folder, dir) {
  const base = path.join(root, 'projects');
  let names = [];
  try {
    names = fs.readdirSync(base);
  } catch {
    return folder; // no projects here yet
  }
  const markerOf = (n) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(base, n, '.loop-project'), 'utf8'));
    } catch {
      return null;
    }
  };
  for (const n of names) {
    const marker = markerOf(n);
    if (marker && marker.dir === dir) return n;
  }
  let name = folder;
  for (let i = 2; names.includes(name); i++) {
    const marker = markerOf(name);
    if (!marker || !marker.dir || marker.dir === dir) return name;
    name = `${folder}-${i}`;
  }
  return name;
}

// Writes cloud files into the local memory, never over a local one: a note
// that exists here and differs keeps the cloud's copy beside it.
function landerFor(root, m) {
  const counts = { added: 0, besides: 0 };
  const record = async (rel, text) => {
    const s = await fsp.stat(inRoot(root, rel));
    m.files[rel] = { hash: sha(Buffer.from(text)), size: s.size, mtime: Math.round(s.mtimeMs) };
  };
  const land = async (relCloud, relLocal, aligned) => {
    if (!wanted(relCloud)) return;
    const text = await call('GET', `/api/files/content?path=${encodeURIComponent(relCloud)}`);
    const full = inRoot(root, relLocal);
    const now = fs.existsSync(full) ? await fsp.readFile(full, 'utf8') : null;
    if (now === text) {
      if (aligned && !m.files[relLocal]) await record(relLocal, text);
      return;
    }
    if (now != null) {
      if (/\.md$/i.test(relLocal)) {
        await writeFile(root, conflictName(relLocal), text);
        counts.besides++;
      }
      return;
    }
    await writeFile(root, relLocal, text);
    if (aligned) await record(relLocal, text);
    counts.added++;
  };
  return { land, counts };
}

// One cloud project's notes, each with whether it is already here: for the
// picker that imports chosen memories into a local project.
async function cloudNotes(folder, dir) {
  if (!st.token) throw new Error('Sign in to Loop Cloud first.');
  const root = rootOf();
  const prefix = `projects/${folder}/`;
  const mine = (await listAllCloud()).filter((f) => f.path.startsWith(prefix));
  const target = localFolderFor(root, folder, dir);
  // Titles and first lines come from each folder's own index, loop.md.
  const titles = new Map();
  for (const f of mine) {
    if (!f.path.endsWith('/loop.md')) continue;
    const at = f.path.slice(prefix.length, -'/loop.md'.length);
    try {
      const text = await call('GET', `/api/files/content?path=${encodeURIComponent(f.path)}`);
      for (const line of text.split('\n')) {
        const mt = /^- \[(.+?)\]\(([^)]+)\)(?: — (.*))?$/.exec(line.trim());
        if (mt) titles.set(`${at}/${mt[2]}`, { title: mt[1], sub: mt[3] || '' });
      }
    } catch {
      // names fall back to the files' own
    }
  }
  const rows = [];
  for (const f of mine) {
    const rel = f.path.slice(prefix.length);
    const parts = rel.split('/');
    const name = parts[parts.length - 1];
    if (!/\.md$/i.test(name) || name === 'loop.md') continue;
    let state = 'new';
    try {
      const now = fs.readFileSync(inRoot(root, `projects/${target}/${rel}`), 'utf8');
      state = sha(Buffer.from(now)) === f.hash ? 'same' : 'differs';
    } catch {
      // not here yet
    }
    const t = titles.get(rel) || {};
    rows.push({
      rel,
      group: parts[0] === 'sessions' && parts.length > 2 ? parts[1] : 'shared',
      title: t.title || name.replace(/\.md$/i, '').replace(/[-_]+/g, ' '),
      sub: t.sub || '',
      updated: Number(f.updated) || 0,
      state,
    });
  }
  rows.sort((a, b) => (a.group === 'shared' ? -1 : 1) - (b.group === 'shared' ? -1 : 1) || a.group.localeCompare(b.group) || b.updated - a.updated);
  return { folder, target, rows };
}

// Imports the chosen notes of one cloud project into a local project, by its
// own folder key: made for a project created here first, whatever it is named.
function bringNotes(folder, dir, rels) {
  if (!st.token) return Promise.reject(new Error('Sign in to Loop Cloud first.'));
  return once('bring', async () => {
    const root = rootOf();
    if (!root) throw new Error('There is no memory folder yet.');
    if (!/^[A-Za-z0-9._ -]{1,120}$/.test(folder) || folder.startsWith('.') || !/^[A-Za-z0-9_-]+$/.test(dir)) throw new Error('No such project');
    const m = readSync();
    const target = localFolderFor(root, folder, dir);
    const aligned = target === folder;
    const lander = landerFor(root, m);
    const sessions = new Set();
    for (const raw of rels || []) {
      const rel = String(raw);
      const parts = rel.split('/');
      if (parts.some((x) => !x || x === '.' || x === '..') || !/\.md$/i.test(rel) || parts[parts.length - 1] === 'loop.md') continue;
      await lander.land(`projects/${folder}/${rel}`, `projects/${target}/${rel}`, aligned);
      if (parts[0] === 'sessions' && parts.length > 2) sessions.add(parts[1]);
    }
    // A session's notes need its marker beside them, or the session stays unseen.
    // The marker is plumbing, though, not a note the user counts.
    const noted = lander.counts.added;
    for (const s of sessions) await lander.land(`projects/${folder}/sessions/${s}/.loop-session`, `projects/${target}/sessions/${s}/.loop-session`, aligned);
    lander.counts.added = noted;
    const c = projCache && projCache.list.find((x) => x.folder === folder);
    await writeFile(root, `projects/${target}/.loop-project`, JSON.stringify({ dir, remote: (c && c.remote) || '' }, null, 2));
    writeSync(m);
    projCache = null;
    afterPull();
    return { added: lander.counts.added, besides: lander.counts.besides, target };
  });
}

// Copies chosen projects' memory (and the notes for every project) down into
// this machine's memory. Nothing local is replaced: a note that differs here
// keeps the cloud's copy beside it.
function bringIn(items, withCompany) {
  if (!st.token) return Promise.reject(new Error('Sign in to Loop Cloud first.'));
  return once('bring', async () => {
    const root = rootOf();
    if (!root) throw new Error('There is no memory folder yet.');
    const m = readSync();
    const files = await listAllCloud();
    const cloud = (await cloudProjects()).list;
    const lander = landerFor(root, m);
    for (const it of items || []) {
      const folder = String(it.folder || '');
      const dir = String(it.dir || '');
      if (!/^[A-Za-z0-9._ -]{1,120}$/.test(folder) || folder.startsWith('.') || !/^[A-Za-z0-9_-]+$/.test(dir)) continue;
      const target = localFolderFor(root, folder, dir);
      const aligned = target === folder; // same path up and down, so sync needs no second copy
      for (const f of files) {
        if (!f.path.startsWith(`projects/${folder}/`)) continue;
        const rest = f.path.slice(`projects/${folder}/`.length);
        if (rest === '.loop-project') continue; // written below, for this machine
        await lander.land(f.path, `projects/${target}/${rest}`, aligned);
      }
      // The marker now names this machine's project; the remote travels along.
      const c = cloud.find((x) => x.folder === folder);
      const marker = JSON.stringify({ dir, remote: (c && c.remote) || '' }, null, 2);
      await writeFile(root, `projects/${target}/.loop-project`, marker);
    }
    if (withCompany) for (const f of files) if (f.path.startsWith('company/')) await lander.land(f.path, f.path, true);
    writeSync(m);
    projCache = null;
    afterPull();
    return { added: lander.counts.added, besides: lander.counts.besides };
  });
}


// ---- linking a project to a cloud project ----

// Moves one memory folder's files into another, never over a file there: a
// note that differs is kept beside it.
async function mergeInto(from, to) {
  const walk = async (rel) => {
    let entries = [];
    try {
      entries = await fsp.readdir(path.join(from, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const r = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) {
        await walk(r);
        continue;
      }
      const src = path.join(from, r);
      const dst = path.join(to, r);
      if (!fs.existsSync(dst)) {
        await fsp.mkdir(path.dirname(dst), { recursive: true });
        await fsp.rename(src, dst);
      } else if (/\.md$/i.test(e.name) && (await fsp.readFile(src, 'utf8')) !== (await fsp.readFile(dst, 'utf8'))) {
        await fsp.rename(src, path.join(path.dirname(dst), conflictName(e.name).replace('from-cloud', 'from-here')));
      }
    }
  };
  await walk('');
}

// A project here takes a cloud project's memory and keeps it in step from now
// on. folder: the cloud project; empty to put this project's own memory in the
// cloud under its own name. What is here already is kept: a note that differs
// keeps both copies.
function link(dir, folder) {
  dir = String(dir || '');
  folder = String(folder || '');
  if (!st.token) return Promise.reject(new Error('Sign in to Loop Cloud first.'));
  if (!/^[A-Za-z0-9_-]+$/.test(dir) || (folder && (!/^[A-Za-z0-9._ -]{1,120}$/.test(folder) || folder.startsWith('.')))) return Promise.reject(new Error('No such project'));
  return once('link', async () => {
    const root = rootOf();
    if (!root) throw new Error('There is no memory folder yet.');
    const base = path.join(root, 'projects');
    const dirs = folderDirs(root);
    const mine = ([...dirs].find(([, d]) => d === dir) || [])[0] || '';
    const target = folder || mine;
    if (!target) throw new Error('This project has no memory yet: pick a cloud project to use.');
    const owner = dirs.get(target);
    if (owner && owner !== dir && !owner.startsWith('folder:')) throw new Error(`Another project on this machine already uses the cloud memory "${target}".`);
    const m = readSync();
    let remote = '';
    if (mine) {
      try {
        remote = JSON.parse(fs.readFileSync(path.join(base, mine, '.loop-project'), 'utf8')).remote || '';
      } catch {
        // no remote noted
      }
    }
    if (mine && mine !== target) {
      const from = path.join(base, mine);
      const to = path.join(base, target);
      if (!fs.existsSync(to)) await fsp.rename(from, to);
      else {
        await mergeInto(from, to);
        await fsp.rm(from, { recursive: true, force: true });
      }
      // Its old copy in the cloud goes: its notes live under the cloud project's name now.
      const old = Object.keys(m.files).filter((r) => r.startsWith(`projects/${mine}/`));
      if (old.length) {
        await push(root, [], old);
        for (const r of old) delete m.files[r];
      }
    }
    await writeFile(root, `projects/${target}/.loop-project`, JSON.stringify({ dir, remote }, null, 2));
    st.projects[dir] = 'linked';
    // Everything the cloud has for it comes down.
    const files = (await listAllCloud()).filter((f) => f.path.startsWith(`projects/${target}/`) && !f.path.endsWith('/.loop-project'));
    const lander = landerFor(root, m);
    for (const f of files) await lander.land(f.path, f.path, true);
    writeSync(m);
    projCache = null;
    afterPull();
    dirty = true;
    setTimeout(() => tick(true).catch(() => {}), 300);
    return { folder: target, added: lander.counts.added, besides: lander.counts.besides };
  });
}

// ---- remote access ----
const setRemote = (o) => call('PUT', '/api/devices/self', o);
const testRemote = () => call('POST', '/api/devices/self/test', {}, { timeout: 20e3 });
const redeemTicket = (ticket) => call('POST', '/api/remote/redeem', { ticket });

module.exports = { setRemote, testRemote, redeemTicket, init, stop, state, sendCode, verify, signOut, refresh, setMode, setProjectMode, setDefaultMode, link, folderDirs, syncNow, backupNow, backups, restore, wanted, scan, normalizeRemote, matchProjects, cloudProjects, bringIn, cloudNotes, bringNotes, BASE };
