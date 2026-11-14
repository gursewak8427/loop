/* global whereItRuns */
/* global S, deck, save, toast, renderList, renderAll, activate, createTab, closeTab, closeOverlay,
   projectByDir, projectTitle, sessionTitle, visibleProjects, visibleSessions, lampFor, tabFor,
   accountFor, accountList, switchAccount, toggleIn, isPinned, isHiddenSession, openSession,
   deleteSession, toggleRemote, setRemote, remoteOn, setMemberRole, teamOf, roleOf, roleLib, teamCommand,
   giveGoal, goalTaker, tellWhenIdle, serverById, fitTab, slash, screenRows, wsOf, STATUS_WORDS */

// What the Loop app on your phone talks to.
//
// The phone never gets its own copy of the rules: every request here turns into
// the same call the desktop makes when you click, so a session opened, renamed
// or closed from the phone is the same session, with the same team, account and
// memory. The bridge in the main process only carries the messages.

const PH = {
  watch: new Map(), // phone id -> the tab it is showing
  last: '',
  timer: null,
  info: { on: false, phones: 0 },
};

const toPhone = (msg) => deck.phoneOut(msg);

// ---------- what the phone sees ----------

// A list row's preview: the words, not what Loop wraps around a hand-over or a goal.
const previewOf = (t) =>
  String(t || '')
    .replace(/\s*\|\s*(?:If this is work for you:|If this answers what you sent:|When it is done, reply to|Call role_brief|Call mailbox_list)[\s\S]*$/, '')
    .replace(/^New goal from the user for the team:\s*/, 'Goal: ')
    .trim();

function phoneSessions(p) {
  const list = p.sessions.filter((s) => !isHiddenSession(s) && (!s.empty || tabFor(s.id)));
  // Each sub-session right under the session that started it.
  return withSubs(list.sort((a, b) => isPinned(b) - isPinned(a) || b.mtime - a.mtime))
    .slice(0, 200)
    .map((s) => {
      const tab = tabFor(s.id);
      const role = teamOf(p.dir) ? roleOf(p.dir, s.id) : null;
      const sub = subOf(s.id);
      return {
        parent: sub ? sub.parent : '',
        sub: sub ? { status: sub.status, task: sub.task.slice(0, 300), branch: sub.branch || '', result: (sub.result || '').slice(0, 2000) } : null,
        id: s.id,
        title: sessionTitle(s),
        lamp: lampFor(s.id, tab),
        status: STATUS_WORDS[lampFor(s.id, tab)] || '',
        open: tab ? tab.id : null,
        pinned: isPinned(s),
        role: role ? role.title : S.config.sessionRole[s.id] || '',
        roleKey: role ? role.key : '',
        account: p.server ? '' : accountFor(p.dir, s.id),
        remote: remoteOn(s.id),
        last: previewOf(s.lastPrompt).slice(0, 120),
        mtime: s.mtime,
      };
    });
}

// The list a phone starts on: the projects, and what is running right now.
// The sessions of one project are fetched when you open it, so this stays small
// however many projects this PC has.
// Everything not hidden, whatever workspace the PC window is showing: the
// phone chooses its own view and never changes the desktop's.
const phoneProjects = () => S.projects.filter((p) => !isHiddenProject(p));

function phoneState() {
  const projects = phoneProjects().map((p) => {
    const list = p.sessions.filter((s) => !isHiddenSession(s) && (!s.empty || tabFor(s.id)));
    return {
      dir: p.dir,
      path: p.path,
      title: projectTitle(p),
      exists: Boolean(p.exists),
      server: p.server || '',
      workspace: wsOf(p) || '',
      team: Boolean(teamOf(p.dir)),
      count: list.length,
      live: list.filter((s) => S.live.has(s.id)).length,
      mtime: Math.max(0, ...list.map((s) => s.mtime || 0)),
    };
  });
  const running = [];
  for (const p of S.projects) {
    for (const s of p.sessions) {
      if (!S.live.has(s.id)) continue;
      const tab = tabFor(s.id);
      const lamp = lampFor(s.id, tab);
      // A question on its screen makes it "waiting for you", the Inbox's first section.
      const ask = askOf(s.id, tab);
      running.push({
        dir: p.dir,
        project: projectTitle(p),
        server: p.server || '',
        id: s.id,
        title: sessionTitle(s),
        lamp,
        open: tab ? tab.id : null,
        ask: ask ? { question: ask.question, options: ask.options } : null,
        status: lamp !== 'busy' || ask ? '' : tab ? screenStatus(tab).split('(')[0].trim() : (S.live.get(s.id) || {}).doing || '',
        last: previewOf(s.lastPrompt).slice(0, 100),
        mtime: s.mtime,
      });
    }
  }
  // The latest conversations across every project shown, for the Chats list.
  const recent = [];
  for (const p of phoneProjects()) {
    for (const s of p.sessions) {
      if (s.empty || isHiddenSession(s) || S.live.has(s.id)) continue;
      recent.push({ dir: p.dir, project: projectTitle(p), server: p.server || '', id: s.id, title: sessionTitle(s), last: previewOf(s.lastPrompt).slice(0, 100), mtime: s.mtime });
    }
  }
  recent.sort((a, b) => b.mtime - a.mtime);
  // A project folder that was moved leaves an old copy of its conversations
  // behind, so one session can be found in two projects: list it once, from
  // the copy still being written to.
  const once = (list) => {
    const best = new Map();
    for (const r of list) if (!best.has(r.id) || r.mtime > best.get(r.id).mtime) best.set(r.id, r);
    return list.filter((r) => best.get(r.id) === r);
  };
  running.splice(0, running.length, ...once(running));
  recent.splice(0, recent.length, ...once(recent));
  return {
    recent: recent.slice(0, 30),
    host: PH.info.host || '',
    window: true,
    workspaces: [
      { id: 'all', name: 'Everything', color: 'var(--accent)' },
      ...(S.config.workspaces || []).map((w) => ({ id: w.id, name: w.name, color: w.color })),
      ...(S.config.servers || []).map((s) => ({ id: 'srv:' + s.id, name: s.name, color: '', server: s.id })),
    ],
    activeWorkspace: String(S.config.activeWorkspace),
    projects,
    running,
    tabs: S.order.map((id) => {
      const t = S.tabs.get(id);
      return {
        id,
        title: tabTitleFor(t),
        dir: t.dir || '',
        sessionId: t.sessionId || '',
        server: t.server || '',
        kind: t.kind,
        lamp: lampFor(t.sessionId, t),
        account: t.account || 'default',
        exited: Boolean(t.exited),
        watched: [...PH.watch.values()].includes(id),
      };
    }),
    active: S.active,
    accounts: accountList().map((a) => ({ id: a.id, name: a.name, color: a.color, who: (S.acct.get(a.id) || {}).email || '' })),
    servers: (S.config.servers || []).map((s) => {
      const far = S.srv.get(s.id) || {};
      return { id: s.id, name: s.name, host: s.host || '', user: s.user || '', state: far.state || '', sessions: (far.sessions || []).length };
    }),
    roles: roleLib().map((r) => ({ key: r.key, title: r.title, duty: r.duty })),
    prompts: (S.config.savedPrompts || []).map((p) => ({ name: p.name, text: p.text })),
    trash: (S.trash || []).length,
    phones: PH.info.phones || 0,
  };
}

const tabTitleFor = (t) => (typeof tabTitle === 'function' ? tabTitle(t) : t.name || 'Session');

// The phone is told when anything it shows has changed, and not more often.
function phoneSync() {
  if (!PH.info.on) return;
  clearTimeout(PH.timer);
  PH.timer = setTimeout(() => {
    const s = phoneState();
    const key = JSON.stringify(s);
    if (key === PH.last) return;
    PH.last = key;
    toPhone({ t: 'state', s });
  }, 250);
}

// ---------- showing one terminal on the phone ----------

// A watched terminal is sized for the phone that is watching, so Claude Code
// draws for that screen; the desktop pane goes back to its own size after.
function phoneWatch(c, req) {
  const tab = S.tabs.get(req.tabId);
  if (!tab) return { ok: false, text: 'That terminal is no longer open.' };
  phoneFlush(); // anything owed for the last terminal goes before the new screen
  PH.watch.set(c, tab.id);
  phoneResize(c, req);
  const screen = tab.serialize ? tab.serialize.serialize({ scrollback: 400 }) : '';
  toPhone({ t: 'screen', c, tabId: tab.id, d: screen, title: tabTitleFor(tab), lamp: lampFor(tab.sessionId, tab) });
  renderList();
  return { ok: true, data: { tabId: tab.id } };
}

function phoneResize(c, req) {
  const tab = S.tabs.get(req.tabId || PH.watch.get(c));
  const cols = Math.max(20, Math.min(400, Number(req.cols) || 0));
  const rows = Math.max(8, Math.min(200, Number(req.rows) || 0));
  if (!tab || !cols || !rows) return { ok: false };
  tab.phoneSize = { cols, rows };
  deck.resize(tab.id, cols, rows);
  return { ok: true };
}

function phoneUnwatch(c) {
  const id = PH.watch.get(c);
  PH.watch.delete(c);
  const tab = S.tabs.get(id);
  // Give the pane back to the desktop only once no phone is on it.
  if (tab && ![...PH.watch.values()].includes(id)) {
    delete tab.phoneSize;
    fitTab(tab);
  }
  phoneSync();
  return { ok: true };
}

// Called for every byte a terminal prints, so it stays cheap. Claude Code paints
// in hundreds of small writes; they leave for the phone once per frame, as one
// message, which is what keeps the phone smooth on a slow network.
const PH_OUT = new Map(); // phone id + tab id -> text not sent yet
let phFlush = 0;

function phoneEcho(tab, data) {
  phoneLookSoon();
  if (!PH.watch.size) return;
  for (const [c, id] of PH.watch) {
    if (id !== tab.id) continue;
    const key = c + '|' + id;
    const next = (PH_OUT.get(key) || '') + data;
    PH_OUT.set(key, next);
    if (next.length > 256 * 1024) return phoneFlush();
  }
  if (!phFlush) phFlush = setTimeout(phoneFlush, 16);
}

function phoneFlush() {
  clearTimeout(phFlush);
  phFlush = 0;
  for (const [key, d] of PH_OUT) {
    const at = key.indexOf('|');
    toPhone({ t: 'data', c: Number(key.slice(0, at)), tabId: key.slice(at + 1), d });
  }
  PH_OUT.clear();
}

// ---------- the chat: questions on screen, and sending ----------

// Which session each phone has open as a chat.
const PH_FOLLOW = new Map(); // phone id -> session id
const HOME_SEEN = new Map(); // lead session id -> { mtime, report }: Home reads a report again only when it changed
const PH_SEEN = new Map(); // phone id -> what it was last told, so it is told only changes
let phLook = 0;

// Claude asks with a numbered list near the bottom of its screen: a permission
// ("Do you want to make this edit?"), or a question it put to you. Read it off
// the screen as the question and its options, so the phone can show buttons.
function screenAsk(tab) {
  const rows = screenRows(tab).map((r) => r.replace(/^[\s│┃|]+|[\s│┃|]+$/g, ''));
  // A short screen, such as a fresh session asking whether to trust its folder,
  // leaves blank rows under it: the bottom is where the writing ends.
  while (rows.length && !rows[rows.length - 1]) rows.pop();
  const look = Math.max(0, rows.length - 30);
  // Claude numbers the answers. A question it asks puts a description under each
  // one, so the lines are gathered by their number rather than by being next to
  // each other, and the lowest run starting at 1 is the list.
  const found = new Map();
  let firstAt = -1;
  for (let i = look; i < rows.length; i++) {
    const m = /^(❯|›|>)?\s*(\d)\.\s+(\S.*)$/.exec(rows[i]);
    if (!m) continue;
    const n = Number(m[2]);
    if (n < 1 || n > 9) continue;
    if (found.has(n) && n !== 1) continue; // an older screen above: keep the newest list
    if (n === 1) {
      found.clear();
      firstAt = i;
    }
    found.set(n, { key: m[2], label: m[3].replace(/\s{2,}.*$/, '').replace(/\s*\(esc\)\s*$/i, '').trim(), on: Boolean(m[1]) });
  }
  const options = [];
  for (let n = 1; found.has(n); n++) options.push(found.get(n));
  if (options.length < 2 || firstAt < 0) return menuAsk(rows, look);
  // Ordinary writing contains numbered lists too. What makes it a question is
  // that Claude is waiting on it: one answer carries the cursor mark, and the
  // box you type in is gone while it waits.
  if (!options.some((o) => o.on)) return null;
  const lastAt = rows.findIndex((r, i) => i > firstAt && !/^(❯|›|>)?\s*\d\.\s+\S/.test(r) && i > firstAt + options.length - 1);
  for (let i = Math.max(firstAt + options.length, lastAt); i < rows.length; i++) {
    if (/^(>|❯)\s*$/.test(rows[i]) || /^(>|❯)\s+\S/.test(rows[i])) return null; // you can type: nothing is waiting
  }
  // The question is the nearest line above the first answer that reads like one.
  let question = '';
  for (let i = firstAt - 1; i >= Math.max(0, firstAt - 12); i--) {
    const r = rows[i].trim();
    if (!r || /^[─━╌╭╮╰╯\-=_]+$/.test(r) || /^\[.?\]/.test(r)) continue;
    question = r;
    if (/\?$/.test(r)) break;
  }
  // Claude draws a rule across the screen above what it asks: the context is
  // what lies between that rule and the answers, not the chat above it.
  let top = Math.max(0, firstAt - 14);
  for (let i = firstAt - 1; i >= top; i--) {
    if (/^[─━]{8,}$/.test(rows[i].trim())) {
      top = i + 1;
      break;
    }
  }
  const context = rows
    .slice(top, firstAt)
    .map((r) => r.trimEnd())
    .filter((r) => r.trim() && r.trim() !== question && !/^[─━╌╭╮╰╯\-=_]+$/.test(r.trim()))
    .slice(-8);
  return { question: question || 'Claude is asking', options, context };
}

// Some choices come without numbers, such as "Do you trust this folder?": a
// pointer on one line, the others under it, and "Enter to confirm" beneath.
// Each answer is then the arrow presses that reach it, and Enter.
function menuAsk(rows, look) {
  let foot = -1;
  for (let i = rows.length - 1; i >= look; i--) {
    if (/^Enter to (confirm|select)\b/i.test(rows[i].trim())) {
      foot = i;
      break;
    }
  }
  if (foot < 0) return null;
  let end = foot - 1;
  while (end > look && !rows[end].trim()) end--;
  let start = end;
  while (start - 1 > look && rows[start - 1].trim()) start--;
  const block = rows.slice(start, end + 1).map((r) => r.trim());
  const at = block.findIndex((r) => /^(❯|›|>)\s+\S/.test(r));
  if (at < 0 || block.length < 2 || block.length > 9) return null;
  const options = block.map((r, i) => {
    const step = i > at ? '\x1b[B'.repeat(i - at) : '\x1b[A'.repeat(at - i);
    return { key: step + '\r', label: r.replace(/^(❯|›|>)\s+/, ''), on: i === at };
  });
  let question = '';
  const context = [];
  for (let i = start - 1; i >= Math.max(look, start - 14); i--) {
    const r = rows[i].trim();
    if (!r || /^[─━╌╭╮╰╯\-=_]+$/.test(r)) continue;
    // The question may run on past its question mark, as a wrapped line does.
    if (!question && /\?/.test(r)) question = r.slice(0, r.lastIndexOf('?') + 1);
    else context.unshift(r);
  }
  return { question: question || context.pop() || 'Claude is asking', options, context: context.slice(-8) };
}

// The line Claude shows while it works, such as "✻ Pondering… (12s · esc to interrupt)".
function screenStatus(tab) {
  const rows = screenRows(tab);
  for (let i = rows.length - 1; i >= Math.max(0, rows.length - 14); i--) {
    const r = rows[i].trim();
    if (/^[✻✶✳✢✽·*●∗⏺]\s+\S.*…/.test(r)) return r.replace(/^\S+\s+/, '').replace(/\s*·?\s*esc to interrupt\)?/i, ')').replace(/\(\)$/, '').trim();
  }
  return '';
}

// Questions from sessions running with no terminal: they arrive from the main
// process rather than being read off a screen.
const PH_DASK = new Map();
const askOf = (sessionId, tab) => (tab && !tab.exited ? screenAsk(tab) : PH_DASK.get(sessionId) || null);

function phoneLook() {
  phLook = 0;
  for (const [c, sessionId] of PH_FOLLOW) {
    const tab = tabFor(sessionId);
    const lamp = lampFor(sessionId, tab);
    const ask = askOf(sessionId, tab);
    const status = lamp !== 'busy' ? '' : tab ? screenStatus(tab) : (S.live.get(sessionId) || {}).doing || '';
    const msg = { t: 'live', c, sessionId, lamp, open: Boolean(tab), ask, status };
    const key = JSON.stringify(msg);
    if (PH_SEEN.get(c) === key) continue;
    PH_SEEN.set(c, key);
    toPhone(msg);
  }
}

// Looked at shortly after a terminal prints, and every second anyway.
function phoneLookSoon() {
  if (PH_FOLLOW.size && !phLook) phLook = setTimeout(phoneLook, 150);
}
setInterval(() => {
  if (PH_FOLLOW.size) phoneLook();
  // Screens change without the list changing: questions and status words come from them.
  if (PH.info.on && PH.info.phones) phoneSync();
}, 1500);

// Text you send arrives as a paste, so a message of several lines stays one message.
// Claude Code can drop an Enter that lands while it redraws (just after it
// resumes, say), so the screen is checked and Enter pressed again until the
// words have left the input box.
async function typeInto(tab, text) {
  if (!text) return;
  deck.write(tab.id, text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text);
  await sleep(450);
  deck.write(tab.id, '\r');
  const probe = text.replace(/\s+/g, ' ').trim().slice(0, 28);
  for (let i = 0; i < 4; i++) {
    await sleep(700);
    if (!S.tabs.has(tab.id) || !stillTyped(tab, probe)) return;
    deck.write(tab.id, '\r');
  }
}

// Is this text still sitting in Claude's input box (the last prompt line on screen)?
function stillTyped(tab, probe) {
  const rows = screenRows(tab);
  for (let i = rows.length - 1; i >= Math.max(0, rows.length - 10); i--) {
    const r = rows[i].replace(/^[\s│|]+/, '');
    if (/^(>|❯|›)\s/.test(r)) return r.replace(/\s+/g, ' ').includes(probe.slice(0, Math.min(probe.length, r.length)));
  }
  return false;
}

// Opening a chat gets the session ready in the background, so the message you
// type next goes straight in instead of waiting for it to start. Nothing is
// sent and nothing is charged: it is the same session, simply awake.
async function warm(sessionId) {
  if (tabFor(sessionId) || S.live.has(sessionId)) return;
  for (const p of S.projects) {
    const s = p.sessions.find((x) => x.id === sessionId);
    if (!s || p.server || !p.exists) continue;
    await deck.directSend({ dir: p.dir, cwd: p.path, sessionId, text: '', account: accountFor(p.dir, sessionId), warm: true });
    return;
  }
}

// Bring a session into Loop, wherever it is running. A copy in another terminal
// or in the Claude desktop app is stopped first: it is the same conversation on
// disk, so it carries on here from everything it has already written. Opening a
// session from the phone or the web never asks: it simply comes here.
async function bringHere(p, s) {
  if (!p || !s || p.server) return { ok: true };
  if (tabFor(s.id)) return { ok: true };
  const lv = S.live.get(s.id);
  if (!lv || lv.bg) return { ok: true }; // not running at all, or already ours
  if (await deck.findTab(s.id)) return { ok: false, text: 'That session is open in another Loop window on this PC.' };
  if (!(await deck.closeElsewhere(s.id))) return { ok: false, text: `Could not stop the copy in ${whereItRuns(lv)}. Close it there yourself, then open it again.` };
  for (let i = 0; i < 40 && S.live.has(s.id); i++) await sleep(100);
  return { ok: true };
}

async function phoneSend(c, req) {
  const { p, s } = findSession(req.dir, req.sessionId);
  if (!p || !s) return { ok: false, text: 'That session is not in Loop any more.' };
  let paths = req.paths || [];
  if (p.server && paths.length) {
    // The server cannot read a file on this PC: copy each picture over first.
    const far = [];
    for (const f of paths) {
      const r = await deck.phonePut(p.server, f);
      if (!r) return { ok: false, text: 'A picture could not be copied to the server.' };
      far.push(r);
    }
    paths = far;
  }
  const text = [String(req.text || '').trim(), ...paths].filter(Boolean).join(' ');
  if (!text) return { ok: false, text: 'Nothing to send.' };
  let tab = tabFor(s.id);
  if ((!tab || tab.exited) && PH_DASK.has(s.id)) {
    const ok = await deck.directAnswer(s.id, '', text);
    phoneLookSoon();
    return ok ? { ok: true } : { ok: false, text: 'That question is no longer waiting.' };
  }
  // No terminal open for it: no terminal needed. The message goes straight into
  // the session, which starts in the background the first time and stays for
  // the next one.
  // A copy running somewhere else is brought here first, so the message goes
  // into the session itself instead of waiting for a terminal on the PC.
  if (!tab) {
    const moved = await bringHere(p, s);
    if (!moved.ok) return { ok: false, text: moved.text };
  }
  // Our own background runner keeps the session marked as running, which must
  // not stop us using it: only a copy somewhere else does.
  const ours = (await deck.directList()).includes(s.id);
  if (!tab && !p.server && p.exists && (ours || !S.live.has(s.id))) {
    const why = await deck.directSend({ dir: p.dir, cwd: p.path, sessionId: s.id, text, account: accountFor(p.dir, s.id) });
    if (!why) return { ok: true, direct: true };
    toast(`${sessionTitle(s)}: ${why}`, true);
    // Something stopped it: fall back to opening it the usual way.
  }
  // On a server, the same, over SSH. A session Loop left running there in its
  // terminal (tmux keeps it after the tab closes) is stopped first; one running
  // anywhere else on the server is left alone and typed into as before.
  if (!tab && p.server && p.path) {
    let free = ours || !S.live.has(s.id);
    if (!free) {
      await deck.serverStop({ server: p.server, sessionId: s.id });
      await sleep(800);
      free = !(await deck.serverRunningThere({ server: p.server, sessionId: s.id }));
    }
    if (free) {
      const why = await deck.directSend({ dir: p.dir, cwd: p.path, sessionId: s.id, text, server: p.server });
      if (!why) return { ok: true, direct: true };
      toast(`${sessionTitle(s)}: ${why}`, true);
    }
  }
  if (!tab) {
    // Not open yet: open it here, and type once Claude is ready for it.
    if (!p.exists) return { ok: false, text: 'That project folder is gone.' };
    tab = createTab({ kind: 'resume', dir: p.dir, cwd: p.path, sessionId: s.id, server: p.server }, false);
    if (!tab) return { ok: false, text: 'Loop could not open that session.' };
    for (let i = 0; i < 90; i++) {
      await sleep(1000);
      const lv2 = S.live.get(s.id);
      if (tab.exited) return { ok: false, text: 'The session closed while starting.' };
      if (lv2 && lv2.status === 'idle' && i > 1) break;
    }
    await sleep(600); // let its first screen settle before anything is typed
  }
  // Claude is asking something: those keystrokes would answer its question or
  // throw it away, so the phone is told to answer first.
  if (screenAsk(tab)) return { ok: false, asking: true, text: 'Answer the question on screen first.' };
  await typeInto(tab, text);
  return { ok: true, opened: true };
}

// ---------- what the phone may ask for ----------

const findSession = (dir, sessionId) => {
  const p = projectByDir(dir);
  const s = p && p.sessions.find((x) => x.id === sessionId);
  return { p, s };
};

async function phoneAction(c, req) {
  const a = req.action;
  const need = (ok, text) => {
    if (!ok) throw new Error(text);
  };

  // A sub-session, started from the phone or the web for a session there.
  if (a === 'subStart') {
    const { p, s } = findSession(req.dir, req.sessionId);
    need(p && s, 'That session is not in Loop any more.');
    const r = await startSub(p, s.id, { task: req.task, returns: req.returns, repo: req.repo || '', worktree: req.worktree !== false, by: 'user' });
    if (r.ok) renderList();
    return { ok: r.ok, text: r.text, data: { id: r.id || '' } };
  }
  if (a === 'subClose') return closeSub(String(req.sessionId || ''));
  if (a === 'subRepos') {
    const p = projectByDir(req.dir);
    need(p && !p.server, 'That project is not on this PC.');
    return { ok: true, data: await deck.subRepos(p.path) };
  }
  if (a === 'sessions') {
    const p = projectByDir(req.dir);
    need(p, 'That project is not in Loop any more.');
    const t = teamOf(p.dir);
    // The roles the team has, including any nobody holds yet, so the phone can
    // show the team as the PC does and fill the empty seats.
    const teamRoles = t ? (t.roles || []).map((r) => ({ key: r.key, title: r.title, duty: r.duty || '', manages: Boolean(r.manages) })) : [];
    return { ok: true, data: { dir: p.dir, team: Boolean(t), teamRoles, policy: (t && t.policy) || '', canTeam: !p.server, sessions: phoneSessions(p) } };
  }
  // Clicking a session brings it here, wherever it was working: the copy in the
  // other terminal or in the Claude desktop app stops, and Loop carries the
  // same conversation on. Nothing is asked first; it is the user's own session.
  if (a === 'bring') {
    const { p, s } = findSession(req.dir, req.sessionId);
    need(p && s, 'That session is not in Loop any more.');
    if (p.server) return { ok: true };
    const was = S.live.get(s.id);
    const away = Boolean(was && !was.bg);
    const moved = await bringHere(p, s);
    need(moved.ok, moved.text);
    // It was working somewhere else: it keeps running, here.
    if (away && p.exists && !tabFor(s.id)) await warm(s.id);
    renderList();
    return { ok: true, text: away ? `Moved into Loop from ${whereItRuns(was)}.` : '' };
  }
  // Opening from a phone never waits on a question asked over on the PC: a
  // session that is already running somewhere else is reported back, and the
  // app asks you there whether to move it.
  if (a === 'open') {
    const { p, s } = findSession(req.dir, req.sessionId);
    need(p && s, 'That session is not in Loop any more.');
    const here = tabFor(s.id);
    if (here) return phoneWatch(c, { tabId: here.id, cols: req.cols, rows: req.rows });
    need(p.exists, `The folder for ${projectTitle(p)} was moved or deleted, so this session cannot be opened.`);
    if (p.server) {
      need(!(await claudeMissing(serverById(p.server))), 'Claude Code is not ready on that server. Open Loop on the PC to set it up.');
    } else {
      // A terminal of ours whose window was closed: take it back as it is,
      // rather than treating it as someone else's copy.
      const kept = S.held.get(s.id);
      if (kept) {
        S.held.delete(s.id);
        const back = createTab({ ...kept, adopt: true });
        need(back, 'Loop could not open that session.');
        return phoneWatch(c, { tabId: back.id, cols: req.cols, rows: req.rows });
      }
      // Wherever it is running, it is the same conversation: it moves here.
      const moved = await bringHere(p, s);
      need(moved.ok, moved.text);
    }
    // Opening a terminal for it means the background runner must let go first:
    // one session is never written to from two places.
    await deck.directStop(s.id);
    const tab = createTab({ kind: 'resume', dir: p.dir, cwd: p.path, sessionId: s.id, server: p.server });
    need(tab, 'Loop could not open that session.');
    return phoneWatch(c, { tabId: tab.id, cols: req.cols, rows: req.rows });
  }
  if (a === 'newSession') {
    const p = projectByDir(req.dir);
    need(p, 'That project is not in Loop any more.');
    need(p.exists, 'That project folder is gone.');
    const sessionId = crypto.randomUUID();
    const name = String(req.name || '').trim().slice(0, 60);
    if (req.account && req.account !== accountFor(p.dir, null)) {
      S.config.sessionAccount[sessionId] = req.account;
      save();
    }
    const tab = createTab({ kind: 'new', dir: p.dir, cwd: p.path, sessionId, name, server: p.server });
    need(tab, 'Loop could not start a session there.');
    if (req.roleKey && teamOf(p.dir)) {
      const t = S.config.projectTeam[p.dir];
      t.members[sessionId] = req.roleKey;
      t.names = { ...(t.names || {}), [sessionId]: name || sessionId.slice(0, 8) };
      save();
    }
    return phoneWatch(c, { tabId: tab.id, cols: req.cols, rows: req.rows });
  }
  if (a === 'shell') {
    const p = projectByDir(req.dir);
    need(p && p.exists, 'That project folder is gone.');
    const tab = createTab({ kind: 'shell', dir: p.dir, cwd: p.path, sessionId: null, server: p.server });
    return phoneWatch(c, { tabId: tab.id, cols: req.cols, rows: req.rows });
  }
  if (a === 'close') {
    need(S.tabs.has(req.tabId), 'That terminal is already closed.');
    // The terminal goes away; the session carries on in Loop, as it does when
    // you close a tab on the PC.
    await closeTab(req.tabId);
    return { ok: true, text: 'Closed. The session keeps working in Loop.' };
  }
  if (a === 'activate') {
    need(S.tabs.has(req.tabId), 'That terminal is no longer open.');
    activate(req.tabId);
    return { ok: true };
  }
  if (a === 'rename') {
    const name = String(req.name || '').replace(/["&|<>^%!\r\n]/g, '').trim().slice(0, 60);
    need(name, 'Give the session a name.');
    S.config.sessionAlias[req.sessionId] = name;
    const t = Object.values(S.config.projectTeam || {}).find((x) => x.names && x.names[req.sessionId]);
    if (t) t.names[req.sessionId] = name;
    save();
    renderList();
    // The name teammates message it by follows as soon as the session is free.
    tellWhenIdle(req.sessionId, `/rename ${name}`);
    return { ok: true, text: `Renamed to "${name}".` };
  }
  if (a === 'account') {
    const { p, s } = findSession(req.dir, req.sessionId);
    need(p && s, 'That session is not in Loop any more.');
    need(!p.server, 'Sessions on a server run under the server account.');
    if (req.account) S.config.sessionAccount[s.id] = req.account;
    else delete S.config.sessionAccount[s.id];
    save();
    const open = tabFor(s.id);
    if (open) await switchAccount(open, accountFor(p.dir, s.id));
    else renderList();
    const name = (accountList().find((x) => x.id === accountFor(p.dir, s.id)) || {}).name || 'the project account';
    return { ok: true, text: `${sessionTitle(s)} runs as ${name}${open ? ' and was restarted' : ''}.` };
  }
  // The Remote Control switch. Loop works it on the sessions it runs; for one
  // running in the Claude desktop app or another terminal it says so rather
  // than storing a wish that never connects.
  if (a === 'remote') {
    const { p, s } = findSession(req.dir, req.sessionId);
    need(p && s, 'That session is not in Loop any more.');
    const r = await setRemote(p, s, Boolean(req.on));
    return { ok: r.ok, text: r.text, data: { on: remoteOn(s.id) } };
  }
  // What is actually true about it right now, read from the session itself:
  // whether a copy on claude.ai is live, and whether Loop can work the switch.
  if (a === 'remoteState') {
    const { p, s } = findSession(req.dir, req.sessionId);
    need(p && s, 'That session is not in Loop any more.');
    const lv = S.live.get(s.id);
    const tab = tabFor(s.id);
    const away = Boolean(lv && !lv.bg && !tab);
    let live = false;
    try {
      live = Boolean(await deck.remotePointer({ dir: p.dir, sessionId: s.id, server: p.server || '' }));
    } catch {
      // a transcript Loop cannot read: the switch still says what it is set to
    }
    return { ok: true, data: { on: remoteOn(s.id), live, running: Boolean(lv), where: away ? whereItRuns(lv) : '' } };
  }
  if (a === 'pin') {
    toggleIn(S.config.pinnedSessions, req.sessionId);
    save();
    renderList();
    return { ok: true };
  }
  if (a === 'trash') {
    const { p, s } = findSession(req.dir, req.sessionId);
    need(p && s, 'That session is not in Loop any more.');
    const r = await deck.sessionTrash({ dir: p.dir, sessionId: s.id, title: sessionTitle(s) });
    // The trash answers true or false, as it does for the desktop.
    need(r === true, 'Loop could not move that session to the trash.');
    if (tabFor(s.id)) await closeTab(tabFor(s.id).id, true);
    S.trash = await deck.trashList();
    await rescan(false);
    return { ok: true, text: 'Deleted. It stays in the trash for 30 days.' };
  }
  if (a === 'restore') {
    const r = await deck.trashRestore({ dir: req.dir, sessionId: req.sessionId });
    need(r === true, 'Loop could not bring that session back.');
    S.trash = await deck.trashList();
    await rescan(false);
    return { ok: true, text: 'Restored.' };
  }
  if (a === 'trashList') return { ok: true, data: await deck.trashList() };
  if (a === 'role') {
    const { p, s } = findSession(req.dir, req.sessionId);
    need(p && s, 'That session is not in Loop any more.');
    need(teamOf(p.dir), 'That project has no team yet. Make one on the PC first.');
    await setMemberRole(p, s, req.roleKey || '');
    renderList();
    return { ok: true, text: req.roleKey ? 'Role set.' : 'Role cleared.' };
  }
  // The rules: the company's, which hold for every team, this project's on top
  // of them, and any written for one member alone. Read here, written below.
  if (a === 'rules') {
    const p = projectByDir(req.dir);
    need(p, 'That project is not in Loop any more.');
    const t = teamOf(p.dir);
    const co = S.config.company || {};
    return {
      ok: true,
      data: {
        dir: p.dir,
        house: await deck.houseRules(),
        rules: String(co.rules || ''),
        mins: Number.isFinite(Number(co.checkMins)) ? Number(co.checkMins) : 0,
        policy: (t && t.policy) || '',
        projectMins: t && Number.isFinite(Number(t.checkMins)) ? Number(t.checkMins) : null,
        inForce: checkEvery(p.dir),
        memberRules: (t && t.memberRules) || {},
      },
    };
  }
  // Writing them. The user is the CEO's boss, so nothing refuses this.
  if (a === 'policy') {
    const scope = req.scope === 'company' || req.scope === 'member' ? req.scope : 'project';
    if (req.mins !== undefined && req.mins !== null) {
      const n = Math.max(0, Math.min(720, Math.round(Number(req.mins) || 0)));
      if (scope === 'company') {
        S.config.company = { ...(S.config.company || {}), checkMins: n };
      } else {
        const p = projectByDir(req.dir);
        need(p, 'That project is not in Loop any more.');
        S.config.projectTeam = S.config.projectTeam || {};
        S.config.projectTeam[p.dir] = { roles: [], members: {}, ...(S.config.projectTeam[p.dir] || {}), checkMins: n };
      }
      save();
      renderList();
      if (req.text === undefined) return { ok: true, text: n ? `The CEO asks for an update after ${n} minutes of quiet.` : 'Check-ins are off.' };
    }
    const text = await teamCommand({ dir: req.dir, user: true, me: req.sessionId || '', action: 'rules', scope, session: req.session || '', text: String(req.text || '') });
    return { ok: true, text };
  }
  if (a === 'team') {
    const text = await teamCommand({ dir: req.dir, user: true, me: req.sessionId || '', action: req.teamAction, session: req.session, role: req.role, name: req.name, duty: req.duty, text: req.words || '' });
    return { ok: true, text };
  }
  if (a === 'goal') {
    const p = projectByDir(req.dir);
    need(p, 'That project is not in Loop any more.');
    // Home's doors name the lead (CEO or CTO); the goal box leaves it to the team.
    const team = teamOf(p.dir);
    const named = req.sessionId && team && team.members[req.sessionId] ? p.sessions.find((s) => s.id === req.sessionId) : null;
    const taker = named || goalTaker(p);
    need(taker, 'That project has nobody to take a goal. Make a session its boss on the PC.');
    const goal = String(req.text || '').trim().slice(0, 2000);
    need(goal, 'Write the goal first.');
    // The same words the PC gives a goal in, delivered the way a phone's own
    // message is: the session is started if it is not running, rather than
    // the goal being left for a terminal that may never be opened.
    const r = await phoneSend(c, {
      dir: p.dir,
      sessionId: taker.id,
      text: goalWords(p, taker, goal),
    });
    if (!r.ok) return r;
    return { ok: true, text: `Given to ${sessionTitle(taker)}.`, data: { sessionId: taker.id, dir: p.dir, title: sessionTitle(taker) } };
  }
  // Home on the phone: for every project with a team, its CEO and CTO - the
  // two front doors - with how each is doing and its latest plan or report.
  // A report is read again only when its conversation has changed.
  if (a === 'home') {
    const projects = [];
    for (const p of S.projects) {
      if (p.server || !p.exists) continue;
      const t = teamOf(p.dir);
      if (!t) continue;
      const leads = [];
      for (const key of ['ceo', 'cto']) {
        const held = p.sessions.filter((s) => t.members[s.id] === key);
        if (!held.length) continue;
        const s = held.find((x) => tabFor(x.id)) || held.slice().sort((x, y) => y.mtime - x.mtime)[0];
        const tab = tabFor(s.id);
        const cached = HOME_SEEN.get(s.id);
        let report = cached && cached.mtime === s.mtime ? cached.report : undefined;
        if (report === undefined) {
          report = await deck.leadReport({ dir: p.dir, sessionId: s.id });
          HOME_SEEN.set(s.id, { mtime: s.mtime, report });
        }
        const lv = S.live.get(s.id);
        leads.push({ key, id: s.id, title: sessionTitle(s), lamp: lampFor(s.id, tab), status: tab ? screenStatus(tab) : (lv && lv.doing) || '', asking: Boolean(askOf(s.id, tab)), report });
      }
      if (leads.length) projects.push({ dir: p.dir, title: projectTitle(p), mtime: p.mtime, leads });
    }
    return { ok: true, data: { projects } };
  }
  // What a goal cost: every session of the project since the goal was given.
  if (a === 'tokens') return { ok: true, data: await deck.goalTokens({ dir: req.dir, since: Number(req.since) || 0 }) };
  // The Usage and Context buttons: answered by Claude Code itself, never typed
  // into a terminal, so they work whether or not the session is open on the PC.
  if (a === 'info') {
    const { p, s } = findSession(req.dir, req.sessionId);
    need(p, 'That project is not in Loop any more.');
    need(p.exists, 'That project folder is gone.');
    const what = String(req.what || '');
    need(what === 'usage' || what === 'context', 'Loop cannot show that.');
    // A session with no terminal on the PC answers /context itself, at once
    // and with its tools counted: the answer goes into the chat.
    if (what === 'context' && s && !p.server && !tabFor(s.id)) {
      const r = await phoneSend(c, { dir: p.dir, sessionId: s.id, text: '/context' });
      return { ok: Boolean(r.ok), text: r.ok ? 'Context is in the chat.' : r.text, data: { inChat: true } };
    }
    const r = await deck.directInfo({ what, cwd: p.path, server: p.server, sessionId: s ? s.id : '', account: accountFor(p.dir, s ? s.id : null) });
    return { ok: Boolean(r && r.ok), text: (r && r.text) || 'No answer.', data: r && r.limits ? { limits: r.limits } : undefined };
  }
  if (a === 'tasks') return { ok: true, data: await deck.taskList(req.dir) };
  if (a === 'taskAdd') return { ok: true, data: await deck.taskAdd(req.dir, req.task || {}) };
  if (a === 'taskUpdate') return { ok: true, data: await deck.taskUpdate(req.dir, req.id, req.change || {}) };
  if (a === 'taskRemove') return { ok: true, data: await deck.taskRemove(req.dir, req.id) };
  if (a === 'notes') {
    const q = { dir: req.dir, scope: req.scope || 'project' };
    return { ok: true, data: req.query ? await deck.memSearch({ ...q, query: req.query }) : await deck.memList(q) };
  }
  if (a === 'noteSave') return { ok: true, data: await deck.memSave(req.note || {}) };
  if (a === 'noteDelete') return { ok: true, data: await deck.memDelete(req.ref || {}) };
  if (a === 'peek') return { ok: true, data: await deck.peek({ dir: req.dir, sessionId: req.sessionId }) };
  if (a === 'workspace') {
    S.config.activeWorkspace = String(req.id || 'all');
    save();
    renderAll();
    return { ok: true };
  }
  if (a === 'serverRefresh') {
    deck.serverRefresh(req.id);
    return { ok: true };
  }
  if (a === 'serverStop') {
    const ok = await deck.serverStop({ server: req.id, sessionId: req.sessionId });
    return { ok: Boolean(ok), text: ok ? 'Stopped on the server.' : 'The server did not confirm. It may have stopped already.' };
  }
  if (a === 'scan') {
    await rescan(false);
    return { ok: true };
  }
  if (a === 'screen') {
    const tab = S.tabs.get(req.tabId);
    need(tab, 'That terminal is no longer open.');
    return { ok: true, data: { rows: screenRows(tab) } };
  }
  throw new Error(`Loop does not know the action "${a}".`);
}

// ---------- the door the main process knocks on ----------

async function phoneRequest(req) {
  const c = req.c;
  if (req.t === 'gone') {
    PH_FOLLOW.delete(c);
    PH_SEEN.delete(c);
    return phoneUnwatch(c);
  }
  if (req.t === 'follow') {
    if (req.sessionId) PH_FOLLOW.set(c, req.sessionId);
    else PH_FOLLOW.delete(c);
    PH_SEEN.delete(c);
    if (req.sessionId) warm(req.sessionId);
    return phoneLook();
  }
  if (req.t === 'send') {
    let out;
    try {
      out = await phoneSend(c, req);
    } catch (e) {
      out = { ok: false, text: e.message };
    }
    toPhone({ t: 'done', c, id: req.id, ...out });
    phoneLookSoon();
    return;
  }
  // A key for the session a chat shows: an answer to its question, or Esc to stop it.
  // A full answer to a question from a session with no terminal: the options
  // picked, 'skip', or words of your own.
  if (req.t === 'answer') {
    const ok = PH_DASK.has(req.sessionId) && (await deck.directAnswer(req.sessionId, String(req.key || ''), String(req.text || '')));
    if (req.id) toPhone({ t: 'done', c, id: req.id, ok: Boolean(ok), text: ok ? '' : 'That question is no longer waiting.' });
    phoneLookSoon();
    return;
  }
  if (req.t === 'key') {
    const tab = tabFor(req.sessionId);
    const d = String(req.d || '');
    if ((!tab || tab.exited) && PH_DASK.has(req.sessionId)) {
      const ok = await deck.directAnswer(req.sessionId, d, '');
      if (req.id) toPhone({ t: 'done', c, id: req.id, ok: Boolean(ok) });
      phoneLookSoon();
      return;
    }
    // Esc on a session with no terminal: it is running headless for the phone,
    // so the stop goes to the runner instead of a screen that is not there.
    if ((!tab || tab.exited) && d === '\x1b') {
      const ok = await deck.directInterrupt(req.sessionId);
      if (req.id) toPhone({ t: 'done', c, id: req.id, ok: Boolean(ok), text: ok ? '' : 'That session is not running.' });
      phoneLookSoon();
      return;
    }
    if (tab && !tab.exited) deck.write(tab.id, d);
    if (req.id) toPhone({ t: 'done', c, id: req.id, ok: Boolean(tab) });
    phoneLookSoon();
    return;
  }
  if (req.t === 'sub') {
    PH.last = '';
    toPhone({ t: 'state', c, s: phoneState() });
    return;
  }
  if (req.t === 'watch') {
    const r = phoneWatch(c, req);
    if (req.id) toPhone({ t: 'done', c, id: req.id, ...r });
    return;
  }
  if (req.t === 'unwatch') return phoneUnwatch(c);
  if (req.t === 'size') return phoneResize(c, req);
  if (req.t === 'in') {
    const tab = S.tabs.get(req.tabId || PH.watch.get(c));
    if (tab && !tab.exited) deck.write(tab.id, String(req.d || ''));
    return;
  }
  if (req.t === 'prompt') {
    const tab = S.tabs.get(req.tabId || PH.watch.get(c));
    if (!tab) return toPhone({ t: 'done', c, id: req.id, ok: false, text: 'That terminal is no longer open.' });
    // One line, then Enter: the same thing as typing it on the PC.
    deck.write(tab.id, String(req.text || '').replace(/\r?\n/g, ' '));
    setTimeout(() => deck.write(tab.id, '\r'), 120);
    if (req.id) toPhone({ t: 'done', c, id: req.id, ok: true });
    return;
  }
  if (req.t === 'image') {
    const tab = S.tabs.get(req.tabId || PH.watch.get(c));
    if (!tab) return toPhone({ t: 'done', c, id: req.id, ok: false, text: 'That terminal is no longer open.' });
    // Claude Code reads a picture when its path is in the prompt.
    deck.write(tab.id, ` ${req.path} `);
    if (req.id) toPhone({ t: 'done', c, id: req.id, ok: true, text: 'Picture added to the prompt.' });
    return;
  }
  if (req.t === 'do') {
    let out;
    try {
      out = await phoneAction(c, req);
    } catch (e) {
      out = { ok: false, text: e.message };
    }
    toPhone({ t: 'done', c, id: req.id, ...out });
    phoneSync();
    return;
  }
}

// ---------- the panel on the PC ----------

let phonePaint = null;

function renderPhonePanel() {
  if (phonePaint) phonePaint();
}

function openPhone() {
  const body = h('div.phone-panel');
  const box = h(
    'div.dialog.wide',
    { tabIndex: -1 },
    h('h3', {}, 'Your phone'),
    h('p', {}, 'The Loop app on your phone works the same sessions as this window: open them, type, send a picture, switch account, give the team a goal. It reaches this PC over Tailscale, so it works from anywhere, and a session on a server runs there as usual.'),
    body,
    h('div.dialog-actions', {}, h('button.btn.primary', { onclick: () => close() }, 'Done')),
  );
  const paint = () => {
    const info = PH.info || {};
    const cfg = S.config.phone || {};
    const best = (info.addresses || [])[0];
    const switchRow = h(
      'div.acct-row',
      {},
      h('div.acct-who', {}, h('b', {}, info.on ? 'On' : 'Off'), h('span', { class: info.error ? 'warn' : '' }, info.error || (info.on ? `Listening on port ${info.port}` : 'The phone cannot reach this PC while this is off.'))),
      h(
        'button.btn.small.primary',
        {
          onclick: () => {
            S.config.phone = { ...cfg, on: !info.on, port: cfg.port || 8787 };
            save();
          },
        },
        info.on ? 'Turn off' : 'Turn on',
      ),
    );
    const field = (label, value, hint) => h('div.phone-field', {}, h('span', {}, label), h('code', {}, value), hint ? h('small', {}, hint) : null);
    put(
      body,
      switchRow,
      info.on
        ? h(
            'div.phone-pair',
            {},
            field('Address', best ? best.ip : 'no network address', best && best.tailscale ? 'Your Tailscale address: use this one from anywhere.' : 'This is a local address, so it works on your own network. Turn Tailscale on for anywhere.'),
            field('Port', String(info.port)),
            field('Pairing code', String(info.token || ''), 'Type it once in the app. Make a new one to shut every phone out.'),
            h(
              'div.dialog-actions',
              {},
              h(
                'button.btn.small',
                {
                  onclick: () => {
                    deck.clipWrite(`${best ? best.ip : ''}:${info.port} ${info.token}`);
                    toast('Address and code copied.');
                  },
                },
                'Copy',
              ),
              h(
                'button.btn.small',
                {
                  onclick: async () => {
                    S.config.phone = { ...(S.config.phone || {}), token: await deck.phoneToken() };
                    save();
                    toast('New pairing code. Phones must pair again.');
                  },
                },
                'New code',
              ),
            ),
            h('div.side-empty', {}, info.phones ? `${info.phones} phone${info.phones > 1 ? 's' : ''} connected right now.` : 'No phone connected yet.'),
          )
        : null,
    );
  };
  const close = openPanel(box);
  phonePaint = () => (box.isConnected ? paint() : (phonePaint = null));
  paint();
  box.focus();
}

function wirePhone() {
  deck.onPhoneDo((req) => phoneRequest(req));
  // A WhatsApp message for a session listening to its sender: delivered the way a phone's message is.
  deck.onWhatsApp(async (id, dir, sessionId, text) => {
    let r;
    try {
      r = await phoneSend(null, { dir, sessionId, text });
    } catch (e) {
      r = { ok: false, text: e.message };
    }
    deck.whatsAppDone(id, r);
  });
  // Anything a phone asked while this window was starting can come now.
  toPhone({ t: 'wired' });
  const heardAsk = (sessionId, ask) => {
    if (ask) PH_DASK.set(sessionId, ask);
    else PH_DASK.delete(sessionId);
    phoneLookSoon();
    phoneSync();
  };
  deck.onDirectAsk(heardAsk);
  // /clear from the phone or the web gives the session a new conversation id.
  // It is still the same seat: its name, role, team place, account and pin
  // move with it, and the old conversation stays in the list as history.
  deck.onDirectReset((from, to) => {
    const c = S.config;
    for (const key of ['sessionAlias', 'sessionRole', 'sessionAccount', 'sessionRemote']) {
      if (c[key] && c[key][from] !== undefined) {
        c[key][to] = c[key][from];
        delete c[key][from];
      }
    }
    for (const t of Object.values(c.projectTeam || {})) {
      if (t.members && t.members[from]) {
        t.members[to] = t.members[from];
        delete t.members[from];
        if (t.names && t.names[from]) t.names[to] = t.names[from];
      }
    }
    const pin = (c.pinnedSessions || []).indexOf(from);
    if (pin >= 0) c.pinnedSessions[pin] = to;
    if (PH_DASK.has(from)) PH_DASK.delete(from);
    // Phones reading it get its working/idle lamp under the new id from now on.
    for (const [c, sid] of PH_FOLLOW) if (sid === from) PH_FOLLOW.set(c, to);
    phoneLookSoon();
    save();
    rescan(false);
  });
  deck.directAsks().then((all) => Object.entries(all || {}).forEach(([id, ask]) => heardAsk(id, ask)));
  deck.onPhone((info) => {
    const was = PH.info.on;
    PH.info = info || PH.info;
    if (!PH.info.on) PH.watch.clear();
    PH.last = '';
    if (was !== PH.info.on) renderStatus();
    renderPhonePanel();
    phoneSync();
  });
  deck.phoneState().then((info) => {
    PH.info = info;
    renderPhonePanel();
  });
}
