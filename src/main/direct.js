// Sending a message straight into a session, with no terminal in the way.
//
// A session you have open on the PC is a terminal, and the only way into a
// terminal is to type. A session that is not open needs no terminal at all:
// Claude Code can run it as a plain program that takes messages as JSON and
// writes the conversation to the same file. That is what this does, so a
// message from your phone arrives at once instead of waiting for a terminal to
// start, and the second message costs nothing at all because the program stays.
//
// One session is only ever run one way at a time: the window checks for an open
// tab before asking for this, and asks for the runner to stop before it opens one.
const { spawn } = require('child_process');
const { UUID_RE } = require('./scanner');

const IDLE_OUT = 15 * 60 * 1000; // a runner nobody has used for fifteen minutes stops
// Each of these is a whole Claude Code: keeping ten of them warm for ten
// sessions costs gigabytes for nothing. The ones you are actually going
// between stay; an older one is started again, from its own transcript, the
// moment you write to it.
const WARM = 3;
const DIED_FAST = 2500; // gone this quickly means it never really started
const LET_GO = 8000; // an interrupt it has not even acknowledged in this long means killing the runner

const runners = new Map(); // session id -> runner
let onChange = () => {};
let onText = () => {}; // words as they are written, before the turn is finished
let onAsk = () => {}; // Claude is waiting on you, or has stopped waiting
let onReset = () => {}; // /clear moved a session to a new conversation id

const alive = (r) => r && r.proc && !r.proc.killed && r.proc.exitCode === null;

function stop(sessionId) {
  const r = runners.get(sessionId);
  if (!r) return false;
  runners.delete(sessionId);
  clearTimeout(r.idle);
  if (r.wait) onAsk(sessionId, null);
  try {
    r.proc.stdin.end();
    // On Windows the program runs under a shell, so the whole tree goes.
    if (process.platform === 'win32' && r.proc.pid) {
      require('child_process').execFile('taskkill', ['/F', '/T', '/PID', String(r.proc.pid)], () => {});
    } else {
      r.proc.kill();
    }
  } catch {
    // already gone
  }
  onChange(sessionId, false);
  return true;
}

// Stop the turn a session is in the middle of, the way Esc does on a terminal.
// Claude Code takes an interrupt on its input stream and keeps the session, so
// the next message carries on the same conversation. A question on screen is
// refused instead, and a turn that will not let go is killed: the session is
// resumed from its transcript when you write to it again.
function interrupt(sessionId) {
  const r = runners.get(sessionId);
  if (!alive(r)) return false;
  if (r.wait) return answer(sessionId, '\x1b', '');
  const ask = 'int-' + Date.now().toString(36);
  r.letGo = ask; // cleared when Claude Code answers, after which the turn ends on its own
  try {
    r.proc.stdin.write(JSON.stringify({ type: 'control_request', request_id: ask, request: { subtype: 'interrupt' } }) + '\n');
  } catch {
    return stop(sessionId);
  }
  r.doing = 'Stopping';
  onChange(sessionId, true);
  // It takes a few seconds to put its tools down and write the turn's result,
  // so only an interrupt it never even answers means something is wrong.
  setTimeout(() => {
    if (runners.get(sessionId) === r && r.letGo === ask && turn(sessionId) === 'busy') stop(sessionId);
  }, LET_GO);
  return true;
}

const stopAll = () => [...runners.keys()].forEach(stop);
const running = (sessionId) => alive(runners.get(sessionId));
const list = () => [...runners.keys()].filter(running);

function touch(r, sessionId) {
  clearTimeout(r.idle);
  r.used = Date.now();
  r.idle = setTimeout(() => stop(sessionId), IDLE_OUT);
}

// Keep the warm ones to a handful: the session just used, and the few used
// before it. Nothing in the middle of a turn or waiting on an answer is
// touched, however old it is.
function trim(keep) {
  const live = [...runners.keys()].filter((id) => alive(runners.get(id)));
  let over = live.length - WARM;
  if (over <= 0) return;
  const spare = live
    .filter((id) => id !== keep && !runners.get(id).wait && turn(id) === 'idle')
    .sort((a, b) => (runners.get(a).used || 0) - (runners.get(b).used || 0));
  for (const id of spare) {
    if (over-- <= 0) return;
    stop(id);
  }
}

// The same program, account and tools a tab would use, minus the terminal.
function start(o) {
  const { sessionId, cwd, settings, mcpConfig, env, brief } = o;
  // Questions and permission requests come back here rather than being refused
  // for want of a screen, and go to whoever is looking: the phone.
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-prompt-tool', 'stdio'];
  for (const flag of String(settings.flags || '').split(/\s+/).filter(Boolean)) args.push(flag);
  if (mcpConfig) args.push('--mcp-config', mcpConfig);
  if (mcpConfig && o.strictMcp) args.push('--strict-mcp-config');
  if (brief) args.push('--append-system-prompt', brief);
  // The Remote Control switch, for a session with no terminal: it connects to
  // claude.ai as it starts, the same way a terminal session does.
  if (o.remote) args.push('--remote-control', process.platform === 'win32' ? '"Loop"' : 'Loop');
  args.push(o.fresh ? '--session-id' : '--resume', sessionId);
  // A session on a server: the same program, reached over SSH.
  if (o.spawn) return startWith(o, o.spawn.cmd, o.spawn.args, false);
  return startWith(o, settings.claudeCmd || 'claude', args, process.platform === 'win32');
}

function startWith(o, cmd, args, shell) {
  const { sessionId, cwd, env } = o;
  const proc = spawn(cmd, args, {
    cwd: o.spawn ? undefined : cwd,
    // Given an --mcp-config, a background claude waits for every tool server
    // before it starts, and the ones that never answer cost their full 30s
    // timeout: 20 to 40 seconds before a phone's message is even read. Wait
    // only for Loop's own memory server, which answers at once; the rest join
    // while it works, as they do in a terminal.
    env: { ...process.env, CLAUDE_CODE_MCP_STARTUP_WAIT_MS: '0', CLAUDE_CODE_MCP_PREWAIT_SERVERS: 'team-memory', ...env },
    windowsHide: true,
    shell, // claude is a .cmd on Windows
  });
  const r = { id: sessionId, proc, buf: '', started: Date.now(), idle: null, gone: null, wait: null, asked: 0, ends: 0, results: 0, doing: 'Starting the session' };
  runners.set(sessionId, r);
  // What it prints is not needed here: the conversation file is the record, and
  // the window is already following it. Only the end of a turn matters, to know
  // the runner is idle again.
  proc.stdout.on('data', (d) => {
    r.heard = true;
    clearTimeout(r.settle);
    r.buf += d.toString();
    const lines = r.buf.split('\n');
    r.buf = lines.pop();
    for (const line of lines) {
      // /clear starts a new conversation with an id of its own; the lines after
      // it carry that id. The runner, and everything Loop keeps about the
      // session, moves to it, or the phone would be left watching the old one.
      if (line.startsWith('{"type":"conversation_reset"')) r.resetting = true;
      else if (r.resetting) {
        const now = (/"session_id":"([0-9a-f-]{36})"/.exec(line) || [])[1];
        if (now && now !== r.id) {
          const was = r.id;
          r.resetting = false;
          runners.delete(was);
          r.id = now;
          runners.set(now, r);
          onReset(was, now);
        }
      }
      // Words as they come, so the phone shows the answer being written
      // rather than nothing at all until the turn ends.
      if (line.includes('text_delta')) {
        try {
          const m = JSON.parse(line);
          const d = m.event && m.event.delta;
          if (d && d.type === 'text_delta' && d.text) onText(r.id, d.text, false);
        } catch {
          // a half-written line; the next one carries it
        }
      } else if (line.includes('"content_block_start"') || line.startsWith('{"type":"system","subtype":"init"')) {
        // A turn nobody asked for: Claude answering a background command that
        // finished. It counts as asked, or its result would be one too many and
        // every later turn would look over before it started, Stop button and all.
        if (line.includes('"content_block_start"') && !r.letGo && Math.max(r.ends, r.results) >= r.asked) {
          r.asked = Math.max(r.ends, r.results) + 1;
          onChange(r.id, true);
        }
        // What it is doing now, for the line under the chat while it works.
        try {
          const m = JSON.parse(line);
          const b = m.event && m.event.content_block;
          doing(r, r.id, !b ? 'Thinking' : b.type === 'thinking' ? 'Thinking' : b.type === 'tool_use' ? toolWords(b.name) : b.type === 'text' ? 'Writing' : r.doing);
        } catch {
          // a half-written line
        }
      } else if (line.includes('"stop_reason":"end_turn"') && line.includes('message_delta')) {
        // Claude has finished answering. What runs after that (hooks, saving)
        // takes seconds more and is not worth showing as still working.
        r.ends += 1;
        onChange(r.id, true);
      } else if (r.letGo && line.startsWith('{"type":"control_response"') && line.includes(r.letGo)) {
        // It has taken the stop: the turn ends itself from here.
        r.letGo = null;
      } else if (line.startsWith('{"type":"control_request"') || line.startsWith('{"type":"control_cancel_request"')) {
        try {
          heard(r, r.id, JSON.parse(line));
        } catch {
          // not a whole line after all
        }
      } else if (line.includes('"type":"result"')) {
        touch(r, r.id);
        onText(r.id, '', true);
        // The turn is over this instant; no need to wait for Claude's own
        // status file to say so.
        r.results += 1;
        onChange(r.id, true);
        // Messages sent close together can be answered in one turn: quiet for
        // a few seconds after a result means nothing more is coming.
        r.settle = setTimeout(() => {
          if (r.wait || Math.max(r.ends, r.results) >= r.asked) return;
          r.ends = r.results = r.asked;
          onChange(r.id, true);
        }, 3000);
      }
    }
  });
  proc.stderr.on('data', (d) => (r.gone = String(d).slice(0, 200)));
  proc.on('error', (e) => {
    r.gone = e.message;
    stop(r.id);
  });
  proc.on('exit', () => {
    if (r.wait) onAsk(r.id, null);
    r.wait = null;
    if (runners.get(r.id) === r) {
      runners.delete(r.id);
      onChange(r.id, false);
    }
  });
  onChange(r.id, true);
  touch(r, r.id);
  return r;
}

// ---- what it is doing ----

function toolWords(name) {
  const n = String(name || '');
  const plain = {
    Read: 'Reading a file',
    Edit: 'Editing a file',
    MultiEdit: 'Editing a file',
    Write: 'Writing a file',
    NotebookEdit: 'Editing a notebook',
    Bash: 'Running a command',
    PowerShell: 'Running a command',
    Grep: 'Searching the code',
    Glob: 'Finding files',
    WebFetch: 'Reading a web page',
    WebSearch: 'Searching the web',
    Task: 'Working with a helper',
    Agent: 'Working with a helper',
    TodoWrite: 'Planning',
    AskUserQuestion: 'Asking you',
  };
  if (plain[n]) return plain[n];
  // mcp__server__get_page_text -> Get page text
  const tool = n.startsWith('mcp__') ? n.split('__').slice(2).join(' ') : n;
  const words = tool.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim().toLowerCase();
  return words ? `Using ${words}` : 'Working';
}

function doing(r, sessionId, words) {
  if (!words || words === r.doing) return;
  r.doing = words;
  onChange(sessionId, true);
}

// ---- Claude waiting on you ----
//
// A question (AskUserQuestion) is shown one question at a time with its answers;
// anything else is a tool asking to run, shown as Yes or No. Either way it looks
// to the phone exactly like a question on a terminal's screen.

const reply = (r, id, response) =>
  r.proc.stdin.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: id, response } }) + '\n');

function what(input) {
  const i = input || {};
  const v = i.command || i.file_path || i.path || i.url || i.pattern || i.description || '';
  return String(v).split('\n').slice(0, 6);
}

function show(r) {
  const w = r.wait;
  if (w.kind === 'question') {
    const q = w.questions[w.at];
    return {
      kind: 'question', // answered with Next, Skip or words of your own
      question: q.question || 'Claude is asking',
      header: q.header || '',
      options: (q.options || []).map((o, i) => ({ key: String(i + 1), label: o.label, desc: o.description || '', on: i === 0 })),
      multi: Boolean(q.multiSelect),
      at: w.at + 1,
      of: w.questions.length,
      context: [],
      direct: true,
    };
  }
  // A hook of the user's own that asks, with its reason: said as what it is,
  // and the phone has it held to confirm rather than tapped.
  if (w.why) {
    return {
      question: w.why,
      options: [
        { key: '1', label: 'Yes', on: true },
        { key: '2', label: 'No', on: false },
      ],
      context: what(w.input),
      gate: true,
      direct: true,
    };
  }
  return {
    question: `Allow ${w.tool}?`,
    options: [
      { key: '1', label: 'Yes', on: true },
      { key: '2', label: 'No, and tell Claude what to do differently', on: false },
    ],
    context: what(w.input),
    direct: true,
  };
}

function heard(r, sessionId, m) {
  if (m.type === 'control_cancel_request') {
    if (r.wait && r.wait.id === m.request_id) {
      r.wait = null;
      onAsk(sessionId, null);
    }
    return;
  }
  const q = m.request || {};
  if (q.subtype !== 'can_use_tool') {
    // Nothing else is asked of a host here; say so rather than leave it hanging.
    r.proc.stdin.write(JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error: 'Not handled' } }) + '\n');
    return;
  }
  const input = q.input || {};
  r.wait =
    q.tool_name === 'AskUserQuestion' && Array.isArray(input.questions) && input.questions.length
      ? { id: m.request_id, kind: 'question', input, questions: input.questions, at: 0, answers: {} }
      : { id: m.request_id, kind: 'tool', input, tool: q.display_name || q.tool_name || 'this', why: q.decision_reason_type === 'hook' ? String(q.decision_reason || '') : '' };
  clearTimeout(r.idle); // waiting on you is not being idle
  onAsk(sessionId, show(r));
}

// The answer: an option's number (several, comma separated, where more than one
// may be picked), 'skip' to leave this question unanswered, Esc to refuse, or
// words of your own.
function answer(sessionId, key, text) {
  const r = runners.get(sessionId);
  const w = r && r.wait;
  if (!w || !alive(r)) return false;
  const words = String(text || '').trim();
  const done = (response) => {
    r.wait = null;
    reply(r, w.id, response);
    touch(r, sessionId);
    onAsk(sessionId, null);
  };
  if (key === '\x1b') {
    done({ behavior: 'deny', message: w.kind === 'question' ? 'The user dismissed the question without answering.' : 'The user said no.' });
    return true;
  }
  if (w.kind === 'tool') {
    if (key === '1' && !words) done({ behavior: 'allow', updatedInput: w.input });
    else done({ behavior: 'deny', message: words ? `The user said no: ${words}` : 'The user said no.' });
    return true;
  }
  const q = w.questions[w.at];
  if (key !== 'skip') {
    const labels = String(key || '')
      .split(',')
      .map((k) => ((q.options || [])[Number(k) - 1] || {}).label)
      .filter(Boolean);
    const picked = words || labels.join(', ');
    if (!picked) return false;
    w.answers[q.question] = picked;
  }
  w.at += 1;
  if (w.at < w.questions.length) {
    onAsk(sessionId, show(r));
    return true;
  }
  if (!Object.keys(w.answers).length) {
    done({ behavior: 'deny', message: 'The user skipped the questions without answering. Carry on with your own judgement, or ask in plain text.' });
    return true;
  }
  done({ behavior: 'allow', updatedInput: { ...w.input, answers: w.answers } });
  return true;
}

const asks = () => {
  const out = {};
  for (const [id, r] of runners) if (r.wait && alive(r)) out[id] = show(r);
  return out;
};

// Deliver one message. Returns null when it went, or why it did not.
async function send(o) {
  if (!UUID_RE.test(String(o.sessionId || ''))) return 'That is not a session id.';
  const text = String(o.text || '').trim();
  if (!text && !o.warm) return 'Nothing to send.';
  let r = runners.get(o.sessionId);
  const fresh = !alive(r);
  if (fresh) {
    r = start(o);
    trim(o.sessionId);
  }
  // Over SSH a start can fail in ways a local one does not (the folder, the
  // login, Claude Code missing there). Wait until it has said something, or a
  // few seconds, so a failure is reported and the message is not lost.
  if (fresh && o.spawn) {
    const started = () =>
      new Promise((res) => {
        const t0 = Date.now();
        const look = setInterval(() => {
          if (!alive(r) || r.heard || Date.now() - t0 > DIED_FAST) (clearInterval(look), res());
        }, 50);
      });
    await started();
    // The connection itself not getting through is worth one more go.
    if (!alive(r) && /connect to host|timed out|Connection (reset|refused|closed)/i.test(r.gone || '')) {
      r = start(o);
      await started();
    }
    if (!alive(r)) return (r.gone || 'Claude Code would not start on the server.').trim();
  }
  // Claude Code takes the message as soon as it is written, whether or not it
  // has finished starting, so nothing waits here. A runner that was already
  // going takes it instantly.
  if (!text) {
    await new Promise((res) => setTimeout(res, fresh ? DIED_FAST : 0));
    return alive(r) ? null : r.gone || 'That session would not start.';
  }
  try {
    r.proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n');
  } catch (e) {
    stop(o.sessionId);
    return e.message;
  }
  touch(r, o.sessionId);
  r.asked += 1;
  if (r.doing !== 'Starting the session') r.doing = 'Thinking';
  onChange(o.sessionId, true);
  return null;
}

// Working or waiting, as the runner itself knows it; null for a session it does not run.
function turn(sessionId) {
  const r = runners.get(sessionId);
  if (!alive(r)) return null;
  // Each message gets one answer; a late "finished" for the last one must not
  // close the turn of a message sent since.
  return Math.max(r.ends, r.results) < r.asked || r.wait ? 'busy' : 'idle';
}

// The words for what a running turn is doing, or '' when it is not working.
function doingNow(sessionId) {
  const r = runners.get(sessionId);
  return alive(r) && turn(sessionId) === 'busy' && !r.wait ? r.doing || '' : '';
}

// Usage and context, for the buttons on the phone and the web. A slash command
// like /usage is answered by Claude Code itself with no model call, so a
// throwaway copy of the session answers it: nothing is saved, nothing is sent to
// a terminal that has the session open (where these open a panel instead of
// writing an answer), and no tokens are spent.
const INFO = { usage: '/usage', context: '/context' };
function info(o) {
  const cmd = INFO[o.what];
  if (!cmd) return Promise.resolve({ ok: false, text: 'Loop cannot show that.' });
  const args = ['-p', cmd, '--output-format', 'json', '--no-session-persistence'];
  // /context is about this conversation, tools and all; /usage is about the
  // account, and skipping the tool servers takes it from minutes to seconds.
  if (o.what === 'context' && UUID_RE.test(String(o.sessionId || ''))) args.push('--resume', o.sessionId, '--fork-session');
  else args.push('--strict-mcp-config');
  return new Promise((resolve) => {
    let out = '';
    const proc = spawn((o.settings && o.settings.claudeCmd) || 'claude', args, {
      cwd: o.cwd,
      env: { ...process.env, CLAUDE_CODE_MCP_STARTUP_WAIT_MS: '0', MSYS_NO_PATHCONV: '1', ...o.env },
      windowsHide: true,
      shell: process.platform === 'win32',
    });
    const give = (r) => {
      clearTimeout(late);
      resolve(r);
    };
    const late = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        // already gone
      }
      give({ ok: false, text: 'Claude Code took too long to answer.' });
    }, 150000);
    proc.stdout.on('data', (d) => (out += d));
    proc.on('error', (e) => give({ ok: false, text: e.message }));
    proc.on('exit', () => {
      try {
        const j = JSON.parse(out.trim().split('\n').pop());
        const text = String(j.result || '').trim();
        give(text ? { ok: true, text: require('./transcript').commandText(text), limits: o.what === 'usage' ? require('./transcript').usageLimits(text) : undefined } : { ok: false, text: 'Claude Code gave no answer.' });
      } catch {
        give({ ok: false, text: 'Claude Code gave no answer.' });
      }
    });
  });
}

module.exports = {
  info,
  send,
  stop,
  WARM,
  interrupt,
  stopAll,
  running,
  list,
  setListener: (fn) => (onChange = fn),
  setTextListener: (fn) => (onText = fn),
  setAskListener: (fn) => (onAsk = fn),
  setResetListener: (fn) => (onReset = fn),
  answer,
  asks,
  turn,
  doing: doingNow,
  IDLE_OUT,
};
