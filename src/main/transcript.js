// A session's conversation as chat messages, for the phone.
//
// Claude Code writes every turn to a .jsonl file. This reads that file (on this
// PC, or on a server over the SSH connection Loop already keeps) and turns its
// records into a short list of things a chat screen shows: what you said, what
// Claude said, and each tool it used with a one-line summary and its result.
// It then keeps reading what is added, so the phone sees new turns as they land.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { CLAUDE_DIR, UUID_RE } = require('./scanner');
const { startedIn, noticeIn } = require('./tasks');

const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const FIRST_READ = 2.5 * 1024 * 1024; // enough for a long conversation's last turns
const MAX_ITEMS = 120;
const MAX_IMAGE = 450 * 1024; // larger pictures are sent as a smaller copy

// A phone's photo is several megabytes; the phone gets a copy about as wide as
// its screen. Electron can shrink pictures; in plain Node (the tests) the
// picture is only sent when it is small already.
let nativeImage = null;
try {
  nativeImage = require('electron').nativeImage || null;
} catch {
  nativeImage = null;
}
function preview(buf) {
  if (!buf || !buf.length) return '';
  if (buf.length < MAX_IMAGE) return buf.toString('base64');
  if (!nativeImage) return '';
  try {
    let img = nativeImage.createFromBuffer(buf);
    if (img.isEmpty()) return '';
    const { width } = img.getSize();
    if (width > 900) img = img.resize({ width: 900, quality: 'good' });
    const out = img.toJPEG(75);
    return out.length < MAX_IMAGE * 2 ? out.toString('base64') : '';
  } catch {
    return '';
  }
}

// Shrinking a phone photo takes about a second and holds up everything else
// Loop is doing, so it happens only when the picture is asked for, and the
// small copy is kept on disk: the next time costs nothing at all.
function smallCopy(file) {
  const keep = localUploads ? path.join(localUploads, 'small') : '';
  const name = keep ? path.join(keep, path.basename(file).replace(/\.[a-z]+$/i, '') + '.jpg') : '';
  if (name) {
    try {
      return fs.readFileSync(name).toString('base64');
    } catch {
      // not made yet
    }
  }
  const b64 = preview(readUpload(file));
  if (b64 && name) {
    try {
      fs.mkdirSync(keep, { recursive: true });
      fs.writeFileSync(name, Buffer.from(b64, 'base64'));
    } catch {
      // nowhere to keep it; it is made again next time
    }
  }
  return b64;
}

const clip = (s, n) => {
  const t = String(s == null ? '' : s);
  return t.length > n ? t.slice(0, n) + ' …' : t;
};
const base = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || String(p || '');

// ---- what one tool call is about, in a few words ----

function describe(name, input = {}) {
  const i = input || {};
  switch (name) {
    case 'Read':
      return { label: `Read ${base(i.file_path)}`, detail: i.file_path };
    case 'Edit':
      return {
        label: `Edit ${base(i.file_path)}`,
        detail: i.file_path,
        diff: { old: clip(i.old_string, 2500), new: clip(i.new_string, 2500) },
      };
    case 'MultiEdit':
      return { label: `Edit ${base(i.file_path)} (${(i.edits || []).length} changes)`, detail: i.file_path };
    case 'Write':
      return { label: `Write ${base(i.file_path)}`, detail: i.file_path, body: clip(i.content, 2500) };
    case 'NotebookEdit':
      return { label: `Edit ${base(i.notebook_path)}`, detail: i.notebook_path };
    case 'Bash':
    case 'PowerShell':
      return { label: i.description || clip(String(i.command || '').split('\n')[0], 90), detail: clip(i.command, 3000), code: true };
    case 'Grep':
      return { label: `Search for "${clip(i.pattern, 60)}"`, detail: i.path || '' };
    case 'Glob':
      return { label: `Find ${clip(i.pattern, 70)}`, detail: i.path || '' };
    case 'WebFetch':
      return { label: `Read ${clip(String(i.url || '').replace(/^https?:\/\//, ''), 70)}`, detail: i.url };
    case 'WebSearch':
      return { label: `Search the web for "${clip(i.query, 60)}"` };
    case 'Task':
    case 'Agent':
      return { label: i.description || 'Ran an agent', detail: clip(i.prompt, 2000) };
    case 'TodoWrite':
      return { label: 'Updated its plan', todos: (i.todos || []).slice(0, 30).map((t) => ({ text: clip(t.content, 200), status: t.status })) };
    case 'AskUserQuestion':
      return { label: 'Asked you a question', detail: clip((i.questions || []).map((q) => q.question).join('\n'), 1000) };
    case 'ExitPlanMode':
      return { label: 'Proposed a plan', body: clip(i.plan, 6000) };
    default: {
      // mcp__server__tool reads better as "server: tool"
      const m = /^mcp__(.+?)__(.+)$/.exec(name || '');
      if (m) return { label: `${m[1].replace(/[-_]/g, ' ')}: ${m[2].replace(/[-_]/g, ' ')}`, detail: clip(JSON.stringify(i), 1200) };
      if (name === 'Skill') return { label: `Ran /${i.skill || i.command || 'skill'}`, detail: clip(i.args, 600) };
      return { label: name || 'Tool', detail: clip(JSON.stringify(i), 1200) };
    }
  }
}

const words = (s) => String(s || '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

// How the chat names a step, the way the Claude app does: what was done, in the
// past tense, and what it was done to; plus the -ing form for while it runs.
function headline(name, input = {}) {
  const i = input || {};
  const file = base(i.file_path || i.notebook_path);
  switch (name) {
    case 'Read':
      return { title: 'Read file', sub: file, doing: `Reading ${file}`, kind: 'read' };
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { title: 'Edited file', sub: file, doing: `Editing ${file}`, kind: 'edit' };
    case 'Write':
      return { title: 'Wrote file', sub: file, doing: `Writing ${file}`, kind: 'edit' };
    case 'Bash':
    case 'PowerShell':
      return { title: 'Ran command', sub: clip(i.description || String(i.command || '').split('\n')[0], 120), doing: clip(i.description || 'Running a command', 80), kind: 'run' };
    case 'Grep':
      return { title: 'Searched code', sub: clip(i.pattern, 100), doing: 'Searching the code', kind: 'read' };
    case 'Glob':
      return { title: 'Found files', sub: clip(i.pattern, 100), doing: 'Looking for files', kind: 'read' };
    case 'WebSearch':
      return { title: 'Searched web', sub: clip(i.query, 120), doing: 'Searching the web', kind: 'web' };
    case 'WebFetch':
      return { title: 'Read page', sub: clip(String(i.url || '').replace(/^https?:\/\//, ''), 120), doing: 'Reading a page', kind: 'web' };
    case 'Task':
    case 'Agent':
      return { title: 'Ran agent', sub: clip(i.description, 120), doing: clip(i.description || 'Running an agent', 80), kind: 'agent' };
    case 'TodoWrite':
      return { title: 'Updated plan', sub: '', doing: 'Planning', kind: 'plan' };
    case 'Skill':
      return { title: 'Ran skill', sub: `/${i.skill || i.command || ''}`, doing: 'Running a skill', kind: 'tool' };
    case 'ToolSearch':
      return { title: 'Loaded tools', sub: '', doing: 'Loading tools', kind: 'tool' };
    case 'AskUserQuestion':
      return { title: 'Asked you', sub: clip(((i.questions || [])[0] || {}).question, 120), doing: 'Asking you', kind: 'ask' };
    case 'ExitPlanMode':
      return { title: 'Proposed a plan', sub: '', doing: 'Writing a plan', kind: 'plan' };
    default: {
      const m = /^mcp__(.+?)__(.+)$/.exec(name || '');
      if (m) return { title: `Used ${words(m[2])}`, sub: words(m[1]), doing: `Using ${words(m[2])}`, kind: m[1].includes('browser') || m[1].includes('chrome') ? 'web' : 'tool' };
      return { title: `Used ${words(name)}`, sub: '', doing: `Using ${words(name)}`, kind: 'tool' };
    }
  }
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((p) => (p.type === 'text' ? p.text : p.type === 'image' ? '[picture]' : ''))
    .filter(Boolean)
    .join('\n');
}

// ---- records to chat items ----

function parse(lines) {
  const out = [];
  for (const line of lines) {
    if (!line || line.length > 6e6) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue; // cut off: the next read has the rest
    }
    const at = Date.parse(r.timestamp) || 0;
    if (r.type === 'summary') continue;
    if (r.type === 'system' && r.subtype === 'compact_boundary') {
      out.push({ k: 'note', id: r.uuid, text: 'Earlier messages were summarised to free up room', at });
      continue;
    }
    // A background command ending is not a message, but the chat counts on it
    // to know what is still running.
    const carrier = typeof r.content === 'string'
      ? r.content
      : r.message && typeof r.message.content === 'string'
        ? r.message.content
        : '';
    const over = carrier ? noticeIn(carrier) : null;
    if (over && over.id) {
      out.push({ k: 'task', id: `task:${over.id}:${over.status}`, task: over.id, status: over.status, at });
      continue;
    }
    // A slash command run with no terminal (from the phone or the web) writes
    // its answer as a record of its own rather than inside a user message.
    if (r.type === 'system' && r.subtype === 'local_command' && typeof r.content === 'string') {
      const item = userText(r.content, r.uuid, at);
      if (item) out.push(item);
      continue;
    }
    if ((r.type !== 'user' && r.type !== 'assistant') || r.isSidechain || !r.message) continue;
    const c = r.message.content;
    if (r.type === 'user') {
      // The summary /compact writes is for Claude, not for reading: the note at
      // the compact boundary already says what happened.
      if (r.isMeta || r.isCompactSummary) continue;
      if (typeof c === 'string') {
        const item = uploadsIn(userText(c, r.uuid, at));
        if (item) out.push(item);
        continue;
      }
      if (!Array.isArray(c)) continue;
      const texts = [];
      const images = [];
      for (const p of c) {
        if (p.type === 'tool_result') {
          const said = resultText(p.content);
          const started = startedIn(said);
          out.push({ k: 'result', id: p.tool_use_id, ok: !p.is_error, text: clip(said, 1200), at, ...(started ? { task: started } : {}) });
        } else if (p.type === 'text') texts.push(p.text);
        else if (p.type === 'image' && p.source && p.source.type === 'base64') {
          images.push({ type: p.source.media_type, b64: p.source.data || '' });
        }
      }
      if (texts.length || images.length) {
        const item = userText(texts.join('\n'), r.uuid, at) || { k: 'user', id: r.uuid, text: '', at };
        if (images.length) item.images = images;
        out.push(uploadsIn(item));
      }
      continue;
    }
    // assistant: text, tool calls, thinking (left out)
    if (!Array.isArray(c)) continue;
    for (const p of c) {
      if (p.type === 'text' && p.text && p.text.trim()) out.push({ k: 'text', id: `${r.uuid}:${out.length}`, text: p.text, at, model: r.message.model });
      else if (p.type === 'tool_use') out.push({ k: 'tool', id: p.id, name: p.name, ...describe(p.name, p.input), ...headline(p.name, p.input), at });
    }
  }
  return out;
}

// A picture sent from the phone reaches Claude Code as a file path in the
// message. In the chat it shows as the picture again.
const UPLOAD_RE = /(?:[A-Za-z]:)?[^\s"']*[\\/](?:phone-uploads|\.loop-uploads)[\\/]phone-[\w-]+\.(?:png|jpe?g|gif|webp|bmp)/gi;

// Where the phone's pictures are kept on this PC. A picture sent to a server
// session is named by its path there; its copy here has the same name (or the
// same with another ending, when it was made smaller for the trip).
let localUploads = '';
const setUploadDir = (dir) => (localUploads = String(dir || ''));
function readUpload(p) {
  try {
    return fs.readFileSync(p);
  } catch {
    // not on this PC under that name
  }
  if (!localUploads) return null;
  const stem = path.basename(p).replace(/\.[a-z]+$/i, '');
  try {
    const here = fs.readdirSync(localUploads).find((f) => f.replace(/\.[a-z]+$/i, '') === stem);
    return here ? fs.readFileSync(path.join(localUploads, here)) : null;
  } catch {
    return null;
  }
}

const FILE_RE = /(?:[A-Za-z]:)?[^\s"']*[\\/](?:phone-uploads|\.loop-uploads)[\\/]phone-[\w-]+--([^\s"'\\/]+)/gi;
function uploadsIn(item) {
  if (!item || item.k !== 'user' || !item.text) return item;
  const files = [...item.text.matchAll(FILE_RE)].map((m) => ({ name: m[1], file: m[0] }));
  if (files.length) item = { ...item, files, text: item.text.replace(FILE_RE, '').replace(/\s{2,}/g, ' ').trim() };
  const found = item.text.match(UPLOAD_RE);
  if (!found) return item;
  const images = item.images ? [...item.images] : [];
  // The picture is named, not read: it is fetched when it is looked at.
  for (const p of found) images.push({ type: 'image', file: p });
  return { ...item, text: item.text.replace(UPLOAD_RE, '').replace(/\s{2,}/g, ' ').trim(), images };
}

// The lead's latest plan or report, for the cards on the phone's Home: from
// the last few turns (scanner.peek), the newest assistant message that starts
// with "Plan:" or "Done:", its bullets, its "Need from you" line, and the goal
// it answers - the user's last own message before it, not a teammate's.
// Markdown made plain for a card on a phone: no backticks, bold marks or link addresses.
const plainLine = (s) =>
  String(s || '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`+/g, '')
    .replace(/\*\*|__/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

function leadReport(turns) {
  const list = Array.isArray(turns) ? turns : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const t = list[i];
    if (t.role !== 'assistant') continue;
    const m = /^\s*(?:\*\*)?(Plan|Done)(?:\*\*)?\s*:(?:\*\*)?\s*([^\n]*)/i.exec(t.text || '');
    const needLine = /^\s*(?:\*\*)?Need from you(?:\*\*)?\s*:/im.test(t.text || '');
    if (!m && !needLine) continue;
    // Without the word at the start, what happened says which it is: work
    // handed to a teammate who has not answered yet makes it the plan; a
    // teammate's answer, or no hand-over at all, makes it the report.
    let kind = m ? m[1].toLowerCase() : '';
    if (!kind) {
      let handed = false;
      let answered = false;
      for (let j = i - 1; j >= 0; j--) {
        const u = list[j];
        if (u.role === 'user' && /^(?:From .+ on the team:|Session message from ")/.test(String(u.text || '').trim())) {
          answered = true;
          continue;
        }
        if (u.role === 'user') break; // the goal
        if (u.role === 'tool' && /team_manage$/.test(u.name) && (u.text === 'tell' || u.text === 'wake' || u.text === 'start')) handed = true;
      }
      // Only a message the lead marked "Plan:" asks for an OK (a misread
      // progress report would ask the user to approve work already done).
      // Unmarked, while work handed out is still out, it is not a card at all.
      if (handed && !answered) continue;
      kind = 'done';
    }
    const firstLine = String(t.text || '').split('\n')[0].replace(/\*\*/g, '').trim();
    const lines = String(t.text).split('\n');
    const bullets = [];
    let need = '';
    for (const l of lines.slice(1)) {
      const n = /^\s*(?:\*\*)?Need from you(?:\*\*)?\s*:(?:\*\*)?\s*(.*)$/i.exec(l);
      if (n) {
        need = plainLine(n[1]);
        continue;
      }
      const b = /^\s*(?:[-*•]|\d+[.)])\s+(.*\S)\s*$/.exec(l);
      if (b && bullets.length < 5) bullets.push(plainLine(b[1]));
    }
    if (/^nothing\.?$/i.test(need)) need = '';
    let goal = '';
    let goalAt = 0;
    for (let j = i - 1; j >= 0; j--) {
      const u = list[j];
      if (u.role !== 'user') continue;
      const words = String(u.text || '').trim();
      if (/^(?:From .+ on the team:|Session message from ")/.test(words) || /^(?:OK|Okay)[,.!]? go ahead\.?$/i.test(words)) continue;
      goal = words
        .replace(/^New goal from the user for the team:\s*/, '')
        .replace(/\s*\|\s*Call role_brief[\s\S]*$/, '')
        .replace(/^(?:New (?:technical |business )?goal|Goal)\s*:\s*/i, '')
        .trim();
      goalAt = u.at || 0;
      break;
    }
    return { kind, at: t.at || 0, lead: plainLine(m ? m[2] : firstLine).slice(0, 200), bullets, need, goal: plainLine(goal).slice(0, 300), goalAt };
  }
  return null;
}

// What a goal cost: every model call in the project's sessions since the goal
// was given, the whole team and not only the one that took it. A call is
// written once per block it answers with, so it is counted once, by its id.
// "fresh" is what was new to the model; "cached" is context read again, which
// counts for far less.
function tokensSince(lines, since) {
  const seen = new Set();
  const out = { fresh: 0, cached: 0, calls: 0 };
  for (const line of lines) {
    if (!line.includes('"usage"')) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (r.type !== 'assistant' || !r.message || !r.message.usage) continue;
    if ((Date.parse(r.timestamp) || 0) < since) continue;
    const key = r.message.id || r.requestId || r.uuid;
    if (seen.has(key)) continue;
    seen.add(key);
    const u = r.message.usage;
    out.fresh += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
    out.cached += u.cache_read_input_tokens || 0;
    out.calls += 1;
  }
  return out;
}

async function goalTokens(projectsDir, dir, since) {
  const folder = path.join(projectsDir, String(dir).replace(/[\\/]/g, ''));
  const total = { fresh: 0, cached: 0, calls: 0, sessions: 0 };
  let names = [];
  try {
    names = (await fsp.readdir(folder)).filter((n) => n.endsWith('.jsonl'));
  } catch {
    return total;
  }
  for (const n of names) {
    const file = path.join(folder, n);
    try {
      if ((await fsp.stat(file)).mtimeMs < since) continue; // untouched since the goal
      const t = tokensSince((await fsp.readFile(file, 'utf8')).split('\n'), since);
      if (!t.calls) continue;
      total.fresh += t.fresh;
      total.cached += t.cached;
      total.calls += t.calls;
      total.sessions += 1;
    } catch {
      // gone or locked: the next look counts it
    }
  }
  return total;
}

// The plan limits in /usage, as numbers: "Current session: 3% used · resets
// Oct 16, 10:20pm (Asia/Kolkata)". The reset is read as local time on this PC,
// which is the zone Claude Code printed it in.
function usageLimits(text, now = Date.now()) {
  const out = [];
  const re = /^\s*Current (session|week(?: \(([^)]+)\))?):\s*(\d+)% used(?:\s*·\s*resets ([A-Z][a-z]{2} \d{1,2}), (\d{1,2}(?::\d{2})?)\s*([ap]m))?/gim;
  let m;
  while ((m = re.exec(String(text)))) {
    const week = m[1].toLowerCase().startsWith('week');
    const which = m[2] && !/^all models$/i.test(m[2]) ? m[2] : '';
    let resetsAt = null;
    if (m[4]) {
      const year = new Date(now).getFullYear();
      const time = m[5].includes(':') ? m[5] : m[5] + ':00';
      let t = new Date(`${m[4]}, ${year} ${time} ${m[6]}`).getTime();
      if (t < now - 86400000) t = new Date(`${m[4]}, ${year + 1} ${time} ${m[6]}`).getTime();
      if (Number.isFinite(t)) resetsAt = t;
    }
    out.push({ label: week ? (which ? `Weekly (${which})` : 'Weekly') : 'Session limit', pct: Number(m[3]), resetsAt });
  }
  return out;
}

// A slash command's answer, made readable on a phone. /context lists every
// tool one by one after its summary; the summary is what anyone reads. Single
// line breaks are kept as breaks (markdown would run the lines together),
// except inside tables.
function commandText(said) {
  let t = String(said);
  const cut = t.search(/\n#+ *MCP Tools/);
  if (/^#+ *Context Usage/.test(t) && cut > 0) t = t.slice(0, cut).trim();
  t = t
    .split('\n')
    .map((l) => (l.trim() && !l.trim().startsWith('|') ? l + '  ' : l))
    .join('\n');
  return clip(t, 6000);
}

// What you typed, minus what Claude Code wraps around it.
function userText(text, id, at) {
  const t = String(text || '');
  const cmd = /<command-name>([^<]*)<\/command-name>/.exec(t);
  if (cmd) {
    const args = (/<command-args>([\s\S]*?)<\/command-args>/.exec(t) || [])[1] || '';
    return { k: 'user', id, text: `${cmd[1].trim()} ${args.trim()}`.trim(), command: true, at };
  }
  const out = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(t);
  if (out) {
    // A terminal's /compact answer keeps its colour codes (ESC[2m ... ESC[22m).
    const said = out[1].replace(/\u001b\[[0-9;]*m/g, '').trim();
    if (!said) return null;
    // A one-liner ("Compacted", "Set model to Sonnet") is a note; a table such
    // as /usage or /context is an answer, shown the way Claude's answers are.
    return said.length > 80 || said.includes('\n') ? { k: 'text', id, text: commandText(said), command: true, at } : { k: 'note', id, text: said, at };
  }
  if (/^\s*<(system-reminder|local-command-caveat|bash-|user-memory|task-notification)/.test(t)) return null;
  if (/^\s*\[Request interrupted/.test(t)) return { k: 'note', id, text: 'Stopped', at };
  const clean = t
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    // What Loop adds to a hand-over or a goal is for Claude, not for reading.
    .replace(/\s*\|\s*(?:If this is work for you:|When it is done, reply to|Call role_brief)[\s\S]*$/, '')
    .trim();
  if (!clean) return null;
  // A message one session sent another: shown as from that session, by name.
  const peer = /^(?:Session message from "([^"]+)"(?: \(your sub-session\))?(?: - done)?:|From (.+?) on the team:)\s*([\s\S]*)$/.exec(clean);
  if (peer) return { k: 'peer', id, from: peer[1] || peer[2], text: peer[3].trim(), at };
  return { k: 'user', id, text: clean, at };
}

// ---- reading the file, here or on a server ----

const localFile = (dir, sessionId) => path.join(PROJECTS_DIR, dir, sessionId + '.jsonl');

async function readLocal(dir, sessionId, from) {
  const file = localFile(dir, sessionId);
  let size;
  try {
    size = (await fsp.stat(file)).size;
  } catch {
    return { size: 0, text: '' };
  }
  if (from >= size) return { size, text: '' };
  const start = from < 0 ? Math.max(0, size - FIRST_READ) : from;
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    return { size, text: buf.toString('utf8'), cut: start > 0 && from < 0 };
  } finally {
    await fh.close();
  }
}

// One subscription per phone: the chat it has open right now.
const follows = new Map(); // phone id -> { stop, poke, kept }

// The heavy parts of a chat (what a step printed, a diff, a picture) stay here
// and go to the phone only when it opens that step or shows that picture. A
// chat then opens as a few kilobytes of summaries, wherever the phone is.
const HEAVY = ['detail', 'diff', 'body', 'todos'];

function slim(items, kept) {
  const out = [];
  for (const it of items) {
    if (it.k === 'tool') {
      const extra = {};
      for (const k of HEAVY) if (it[k] != null && it[k] !== '') extra[k] = it[k];
      kept.set(it.id, { ...(kept.get(it.id) || {}), ...extra });
      const s = { k: 'tool', id: it.id, name: it.name, title: it.title, sub: it.sub, doing: it.doing, kind: it.kind, label: it.label, at: it.at };
      // An edit's size is shown on its line, so it comes along.
      if (it.diff) s.lines = { add: lineCount(it.diff.new), del: lineCount(it.diff.old) };
      out.push(s);
    } else if (it.k === 'result') {
      kept.set(it.id, { ...(kept.get(it.id) || {}), result: it.text });
      out.push({ k: 'result', id: it.id, ok: it.ok, has: Boolean(it.text) });
    } else if (it.k === 'user' && it.images && it.images.length) {
      const images = it.images.map((img, n) => {
        const ref = `${it.id}:${n}`;
        // The picture itself stays here; the phone asks for it by this name.
        if (img.file) kept.set('img:' + ref, { img: true, file: img.file });
        else if (img.b64) kept.set('img:' + ref, { img: true, b64: img.b64 });
        else return { ref: '' };
        return { ref };
      });
      out.push({ ...it, images });
    } else out.push(it);
  }
  // Bounded: a very long chat keeps the newest outputs.
  while (kept.size > 3000) kept.delete(kept.keys().next().value);
  return out;
}

const lineCount = (s) => (s ? String(s).split('\n').length : 0);

// What the phone asked to see: one step's output, or one picture.
function fetchKept(c, ref) {
  const f = follows.get(c);
  if (!f) return null;
  const kept = f.kept.get(String(ref));
  if (!kept || !kept.img) return kept || null;
  // A picture, made small the first time it is looked at.
  if (kept.ready == null) {
    kept.ready = kept.file ? smallCopy(kept.file) : kept.b64.length < MAX_IMAGE ? kept.b64 : preview(Buffer.from(kept.b64, 'base64'));
  }
  return kept.ready || null;
}

function follow(c, { dir, sessionId, server }, sendRaw, remoteRead) {
  unfollow(c);
  const kept = new Map();
  const send = (msg) => sendRaw(msg.items ? { ...msg, items: slim(msg.items, kept) } : msg);
  if (!/^[A-Za-z0-9_-]+$/.test(String(dir)) || !UUID_RE.test(String(sessionId))) return send({ t: 'chat', sessionId, items: [], reset: true, missing: true });
  const read = server ? (from) => remoteRead(server, dir, sessionId, from) : (from) => readLocal(dir, sessionId, from);
  let offset = -1;
  let held = []; // read, but older than the phone asked for
  let reading = false; // a read is in flight
  let rest = ''; // a line still being written
  let stopped = false;
  let timer = null;
  let watcher = null;
  const tick = async () => {
    if (stopped) return;
    if (reading) return schedule(80); // one read at a time, or lines arrive twice
    reading = true;
    try {
      const r = (await read(offset)) || { size: offset, text: '' };
      if (stopped) return;
      const first = offset < 0;
      if (r.size < offset) {
        // rewritten from the start (rewind): read it all again
        offset = -1;
        rest = '';
        reading = false;
        return schedule(0);
      }
      if (r.text || first) {
        const lines = (rest + r.text).split('\n');
        rest = lines.pop();
        if (r.cut) lines.shift(); // the first line was cut in half
        let items = parse(lines);
        if (first && items.length > MAX_ITEMS) {
          // The rest stays here until the phone scrolls back for it.
          held = items.slice(0, items.length - MAX_ITEMS);
          items = items.slice(-MAX_ITEMS);
        }
        if (items.length || first) {
          send({ t: 'chat', sessionId, items, reset: first, earlier: Boolean(held.length || (first && r.cut)) });
        }
      }
      offset = r.size;
    } catch {
      // the file is between writes, or the server dropped: try again shortly
    } finally {
      reading = false;
    }
    // A local file is watched, so a new turn leaves at once; the timer is only a backstop.
    if (!server && !watcher) {
      try {
        watcher = fs.watch(localFile(dir, sessionId), () => schedule(25));
        watcher.on('error', () => {});
      } catch {
        // not written yet: the timer finds it
      }
    }
    schedule(server ? 1200 : watcher ? 2000 : 500);
  };
  const schedule = (ms) => {
    clearTimeout(timer);
    timer = setTimeout(tick, ms);
  };
  follows.set(c, {
    kept,
    // One screen further back, oldest last sent first.
    earlier: () => {
      if (!held.length) return send({ t: 'chat', sessionId, items: [], before: true, earlier: false });
      const chunk = held.slice(-MAX_ITEMS);
      held = held.slice(0, held.length - chunk.length);
      send({ t: 'chat', sessionId, items: chunk, before: true, earlier: held.length > 0 });
    },
    stop: () => {
      stopped = true;
      held = [];
      clearTimeout(timer);
      if (watcher) watcher.close();
    },
    poke: () => schedule(0),
  });
  tick();
}

// The phone scrolled to the top and wants what came before.
function earlier(c) {
  const f = follows.get(c);
  if (f && f.earlier) f.earlier();
}

function unfollow(c) {
  const f = follows.get(c);
  if (f) f.stop();
  follows.delete(c);
}

module.exports = {
  commandText,
  leadReport,
  tokensSince,
  goalTokens,
  usageLimits,
  setUploadDir, follow, unfollow, earlier, fetchKept, slim, parse, describe, headline, userText, readLocal, localFile, _test: { localFile } };
