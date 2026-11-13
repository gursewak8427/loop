// The chat view of a session: its conversation file, read a little at a time.
const fsp = require('fs/promises');
const transcript = require('./transcript');

// Reads what was added since `from` (-1: the recent end), only up to the last
// complete line, so a message being written is read whole the next time.
async function read(dir, sessionId, from) {
  const r = await transcript.readLocal(String(dir), String(sessionId), Number(from));
  if (!r.text) return { size: r.size, items: [], cut: false };
  const end = r.text.lastIndexOf('\n');
  if (end < 0) return { size: from < 0 ? r.size - Buffer.byteLength(r.text) : from, items: [], cut: Boolean(r.cut) };
  const whole = r.text.slice(0, end + 1);
  const start = r.size - Buffer.byteLength(r.text);
  let lines = whole.split('\n');
  // Read from the middle of the file: the first line is cut, so it goes.
  if (r.cut) lines = lines.slice(1);
  return { size: start + Buffer.byteLength(whole), items: transcript.parse(lines), cut: Boolean(r.cut) };
}

// Names a session the way Claude Code does, in its own file, so Loop, the
// Claude app, /resume and Remote Control all show the same name.
async function rename(dir, sessionId, name) {
  const clean = String(name || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
  if (!clean || !/^[0-9a-f-]{36}$/i.test(String(sessionId))) return false;
  const file = transcript.localFile(String(dir), String(sessionId));
  const lines = [
    { type: 'custom-title', customTitle: clean, sessionId: String(sessionId) },
    { type: 'agent-name', agentName: clean, sessionId: String(sessionId) },
  ];
  await fsp.access(file);
  await fsp.appendFile(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return true;
}

// ---- attachments ----
// A picture or file sent from the chat is kept in Loop's upload folder, and the
// message carries its path: that is how Claude Code takes a file. Pictures are
// named phone-<id>.<ext> (as the phone app's were); other files
// phone-<id>--<their name>, so the chat can show the name again.
const path = require('path');
const crypto = require('crypto');
const MAX_FILE = 20 * 1024 * 1024;
const IMAGE_EXT = /^(png|jpe?g|gif|webp|bmp)$/i;
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };

function safeName(name) {
  const base = path.basename(String(name || 'file')).replace(/[^\w.\-()]+/g, '_').replace(/^\.+/, '').slice(-80);
  return base || 'file';
}

async function upload(dir, o) {
  if (!dir) throw new Error('No upload folder');
  const b64 = String((o && o.b64) || '');
  if (!b64 || b64.length > MAX_FILE * 1.4) throw new Error('Too big');
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length || buf.length > MAX_FILE) throw new Error('Too big');
  const { file, image } = finalName(dir, o.name);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(file, buf);
  return { path: file, image };
}

// Where a sent file is kept, by what it is.
function finalName(dir, name) {
  const safe = safeName(name);
  const ext = (/\.([a-z0-9]{1,8})$/i.exec(safe) || [, ''])[1].toLowerCase();
  const id = Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
  const image = IMAGE_EXT.test(ext);
  return { file: path.join(dir, image ? 'phone-' + id + '.' + ext : 'phone-' + id + '--' + safe), image };
}

// The same, a part at a time, so the chat can show how far along it is. Part
// i of n is added to a hidden file; the last part gives it its name. A file
// left half-sent for ten minutes is dropped.
const parts = new Map(); // id -> { tmp, size, at }
async function uploadPart(dir, o) {
  const id = String((o && o.id) || '');
  const i = Number(o && o.i);
  const of = Number(o && o.of);
  if (!dir || !/^[a-z0-9]{6,40}$/i.test(id) || !Number.isInteger(i) || !Number.isInteger(of) || i < 0 || of < 1 || of > 64 || i >= of) throw new Error('Bad part');
  const b64 = String(o.b64 || '');
  if (!b64 || b64.length > 2 * 1024 * 1024) throw new Error('Bad part');
  for (const [k, p] of parts) if (Date.now() - p.at > 10 * 60 * 1000) (parts.delete(k), fsp.rm(p.tmp, { force: true }).catch(() => {}));
  let p = parts.get(id);
  if (i === 0) {
    await fsp.mkdir(dir, { recursive: true });
    p = { tmp: path.join(dir, '.part-' + id), size: 0, next: 0, at: Date.now() };
    parts.set(id, p);
    await fsp.writeFile(p.tmp, '');
  }
  if (!p || p.next !== i) throw new Error('Part out of order');
  const buf = Buffer.from(b64, 'base64');
  p.size += buf.length;
  if (p.size > MAX_FILE) {
    parts.delete(id);
    await fsp.rm(p.tmp, { force: true });
    throw new Error('Too big');
  }
  await fsp.appendFile(p.tmp, buf);
  p.next = i + 1;
  p.at = Date.now();
  if (i < of - 1) return { got: i + 1 };
  parts.delete(id);
  const { file, image } = finalName(dir, o.name);
  await fsp.rename(p.tmp, file);
  return { path: file, image };
}

// A file taken out of the tray after it went up: it goes from the PC too.
async function discard(dir, file) {
  const base = path.basename(String(file || ''));
  if (!dir || !/^phone-[\w-]+(\.[a-z0-9]{1,8}|--[\w.\-()]+)$/i.test(base)) return false;
  await fsp.rm(path.join(dir, base), { force: true });
  return true;
}

// A picture the chat shows: only ever from the upload folder, by its name there.
async function picture(dir, file) {
  const base = path.basename(String(file || ''));
  const m = /^phone-[\w-]+\.(png|jpe?g|gif|webp|bmp)$/i.exec(base);
  if (!dir || !m) return null;
  try {
    const buf = await fsp.readFile(path.join(dir, base));
    return 'data:' + MIME[m[1].toLowerCase()] + ';base64,' + buf.toString('base64');
  } catch {
    return null; // no longer kept
  }
}

module.exports = { read, rename, upload, uploadPart, discard, picture, safeName };
