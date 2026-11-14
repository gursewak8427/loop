// The log of a project's Loop mailbox: every call a session made to it (who
// looked up the sessions, what was sent to whom, and what became of it). It is
// a record for the user to read, not the delivery itself: a message is handed
// straight to the session it is for. Kept for one day, then dropped.
const fs = require('fs');
const path = require('path');

const KEEP = 24 * 3600e3;
const MOST = 500; // a runaway pair of sessions must not grow the file without end
const DIR_RE = /^[A-Za-z0-9_-]{1,200}$/;
const RESULTS = ['delivered', 'woken', 'failed', 'skipped']; // skipped: an acknowledgement, which the mailbox does not carry

let root = '';
let sweeper = null;

function init(userData) {
  root = path.join(userData, 'mailbox');
  sweep();
  clearInterval(sweeper);
  sweeper = setInterval(sweep, 3600e3);
  if (sweeper.unref) sweeper.unref();
}

const fileOf = (dir) => (root && DIR_RE.test(String(dir || '')) ? path.join(root, `${dir}.json`) : null);

function readAll(file) {
  try {
    const list = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(list) ? list.filter((e) => e && Number.isFinite(e.at)) : [];
  } catch {
    return [];
  }
}

function write(file, list) {
  if (!list.length) {
    try {
      fs.unlinkSync(file);
    } catch {
      // nothing was there
    }
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(list));
}

const fresh = (list, now) => list.filter((e) => e.at > now - KEEP && e.at <= now + 60e3);

const words = (v, most) =>
  String(v == null ? '' : v)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, most);

// One call, as it is kept: { at, kind, from, to, text, result, note, re }.
function clean(entry, now) {
  const e = entry || {};
  return {
    at: now,
    kind: e.kind === 'list' ? 'list' : 'send',
    from: words(e.from, 80),
    to: words(e.to, 80),
    text: words(e.text, 2000),
    result: RESULTS.includes(e.result) ? e.result : '',
    note: words(e.note, 300),
    re: Boolean(e.re), // it answered what the receiver had asked
  };
}

function add(dir, entry, now = Date.now()) {
  const file = fileOf(dir);
  if (!file) return null;
  const item = clean(entry, now);
  write(file, [...fresh(readAll(file), now), item].slice(-MOST));
  return item;
}

// The last day of a project's calls, newest first.
function list(dir, now = Date.now()) {
  const file = fileOf(dir);
  if (!file) return [];
  const all = readAll(file);
  const kept = fresh(all, now);
  if (kept.length !== all.length) {
    try {
      write(file, kept);
    } catch {
      // read-only disk: the old lines are still left out of what is shown
    }
  }
  return kept.reverse();
}

// Projects nobody opens would keep their last day for ever: every file is gone over.
function sweep(now = Date.now()) {
  let names = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(root, name);
    const all = readAll(file);
    const kept = fresh(all, now);
    if (kept.length === all.length && all.length) continue;
    try {
      write(file, kept);
    } catch {
      // tried again in an hour
    }
  }
}

// ---------- the mailbox as a shell command ----------
// A session on an agent that takes no tools from Loop still runs commands, so
// the mailbox is also a command: loop-mail. Loop keeps it in a folder of its
// own and puts that folder on the PATH of every agent session it starts. It is
// run by Loop's own program, so nothing else has to be installed.
let binDir = '';

function installCli(userData, exe = process.execPath) {
  const dir = path.join(userData, 'bin');
  fs.mkdirSync(dir, { recursive: true });
  const script = path.join(dir, 'loop-mail.js');
  fs.writeFileSync(script, fs.readFileSync(path.join(__dirname, 'mail-cli.js')));
  const fwd = (p) => p.split('\\').join('/');
  fs.writeFileSync(path.join(dir, 'loop-mail.cmd'), ['@echo off', 'setlocal', 'set ELECTRON_RUN_AS_NODE=1', `"${exe}" "${script}" %*`, ''].join('\r\n'));
  // The same for a POSIX shell: macOS, Linux, and Git Bash on Windows.
  fs.writeFileSync(path.join(dir, 'loop-mail'), ['#!/bin/sh', `ELECTRON_RUN_AS_NODE=1 exec "${fwd(exe)}" "${fwd(script)}" "$@"`, ''].join('\n'), {
    mode: 0o755,
  });
  binDir = dir;
  return dir;
}

// What an agent session is started with: which session it is, and the command on its PATH.
function cliEnv(url, env = process.env) {
  if (!url || !binDir) return {};
  // Windows names it Path; a second key spelled PATH would leave the session with two.
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  return { LOOP_MAIL: url, [key]: binDir + path.delimiter + (env[key] || '') };
}

module.exports = { init, add, list, sweep, installCli, cliEnv, KEEP };
