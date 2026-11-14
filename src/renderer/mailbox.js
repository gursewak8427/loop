// The Loop mailbox of a project, and its boss.
//
// Any session of a project can see the others and send one a message, whether
// it is on the team or not: the message goes into the session itself and wakes
// it if it is closed. The user marks one session as the boss, the one that
// decides who does what. Every call is logged for a day and shown in a panel.
//
// It is the same for every agent. A session whose agent takes Loop's tools
// (Claude Code, ChatGPT) uses mailbox_list and mailbox_send; any other runs the
// loop-mail command, which Loop puts on its PATH. A message reaches a session
// on another agent through its terminal, which Loop opens if it is closed.

// ---------- the boss ----------

// The boss of a project: the session the user marked, else the team's CEO.
// { id, marked } or null.
function bossOf(p) {
  const marked = (S.config.projectBoss || {})[p.dir];
  if (marked && (p.sessions.some((s) => s.id === marked) || agentRecords(p.dir).some((r) => r.memberId === marked))) return { id: marked, marked: true };
  const t = teamOf(p.dir);
  const ceo = t && p.sessions.find((s) => t.members[s.id] === 'ceo');
  return ceo ? { id: ceo.id, marked: false } : null;
}
const isBoss = (p, id) => {
  const b = bossOf(p);
  return Boolean(b && b.id === id);
};

// Whether a session reaches the mailbox with Loop's tools, or with the loop-mail command.
const mailByTool = (p, id) => {
  const rec = agentRecords(p.dir).find((r) => r.memberId === id);
  return !rec || Boolean(agentInfo(rec.agent).tools);
};

const bossWords = (byTool) =>
  'The user just made you the boss of this project: you decide who does what here. Do small jobs yourself. For the rest ' +
  (byTool
    ? 'call mailbox_list, which shows every session of this project, choose who does it, and hand it over with mailbox_send, which wakes a session that is closed.'
    : 'run the shell command loop-mail list, which shows every session of this project, choose who does it, and hand it over with loop-mail send "its name" "the work" (no double quotes inside the text), which wakes a session that is closed.') +
  ' Take its answer as the report: do not check or redo its work yourself. Report to the user once, when the work is done or stuck. Nothing to do right now: no reply is needed.';

// A terminal takes one thing at a time: two messages typed at once would run
// into each other, so each waits for the one before it.
function typeQueued(tab, text) {
  const next = (tab.typing || Promise.resolve())
    .then(() => (S.tabs.has(tab.id) && !tab.exited ? typeInto(tab, text.replace(/\s+/g, ' ')) : null))
    .catch(() => {});
  tab.typing = next;
  return next;
}

// What an agent's screen shows when it is waiting to be typed into, and the
// questions it may ask on the way there that are safe to put aside. Words typed
// before that are lost, or worse, answer the question: typed into ChatGPT's
// "update available" list, a message chose "Update now".
const AGENT_SCREEN = {
  codex: { ready: /\? for shortcuts/, aside: [{ when: /Update available[\s\S]*Skip until next version/, keys: '\x1b' }] },
  kimi: { ready: /^\s*│ >/m },
};

// Wait for an agent's program to be ready for words. 'ready', 'gone' (its
// terminal closed) or 'stuck' (it is showing something only the user can
// answer: a sign-in, a question Loop does not know). An agent Loop has no
// screen for is ready when its screen has come to rest.
async function agentReady(tab, agent, most = 60) {
  const look = AGENT_SCREEN[agent];
  const aside = new Set();
  let last = '';
  let still = 0;
  for (let t = 1; t <= most; t++) {
    await sleep(1000);
    if (!S.tabs.has(tab.id) || tab.exited) return 'gone';
    const now = screenRows(tab).join('\n');
    still = now.trim() && now === last ? still + 1 : 0;
    last = now;
    if (!look) {
      if (still >= 3 && t >= 5) return 'ready';
      continue;
    }
    const ask = (look.aside || []).find((x) => !aside.has(x) && x.when.test(now));
    if (ask) {
      aside.add(ask);
      deck.write(tab.id, ask.keys);
      continue;
    }
    // Seen twice in a row: the prompt is there to stay, not passing by while it starts.
    if (look.ready.test(now) && still >= 1) return 'ready';
  }
  return look ? 'stuck' : last.trim() ? 'ready' : 'stuck';
}

// Something a closed session on another agent must hear: typed in when its terminal is next opened.
function tellOnOpen(rec, tab) {
  if (!rec.tell || !tab) return;
  const text = rec.tell;
  agentReady(tab, rec.agent).then((how) => {
    if (how !== 'ready' || rec.tell !== text) return; // kept for the next time it opens
    delete rec.tell;
    save();
    typeQueued(tab, text);
  });
}

// Tell a session something about being the boss. 'now': it was told. 'soon':
// it is busy in its terminal and is told the moment it is free. 'later': it is
// closed, and reads it in its brief when it next starts.
async function bossTell(p, id, text) {
  const s = p.sessions.find((x) => x.id === id);
  const rec = agentRecords(p.dir).find((r) => r.memberId === id);
  if (rec) {
    const tab = agentTabFor(rec.id);
    if (!tab || tab.exited) {
      rec.tell = text; // its program reads no brief from Loop: it hears this when its terminal next opens
      save();
      return 'later';
    }
    delete rec.tell;
    await typeQueued(tab, text);
    return 'now';
  }
  if (!s) return 'later';
  if (await nudge(p, s, text)) return 'now';
  const tab = tabFor(id);
  if (!tab || tab.exited) return 'later';
  tellWhenIdle(id, text);
  return 'soon';
}

// Mark a session as the boss of its project, or take the mark away. One boss a project.
async function setBoss(p, id, name) {
  S.config.projectBoss = S.config.projectBoss || {};
  const was = bossOf(p);
  const unmark = S.config.projectBoss[p.dir] === id;
  if (unmark) delete S.config.projectBoss[p.dir];
  else S.config.projectBoss[p.dir] = id;
  save();
  renderList();
  if (S.drawer.open && S.drawer.mode === 'mail') renderDrawer();
  const now = bossOf(p);
  const title = projectTitle(p);
  // Whoever held the mark until now must not go on deciding.
  if (was && was.marked && (!now || now.id !== was.id)) {
    bossTell(
      p,
      was.id,
      `The user ${now ? `made "${mailNameOf(p, now.id)}" the boss of this project` : 'took the boss mark off this project'}: you no longer decide who does what here. Carry on with your own work. No reply is needed.`,
    ).catch(() => {});
  }
  if (unmark)
    return toast(
      now
        ? `${name} is no longer the boss. ${mailNameOf(p, now.id)}, the team's CEO, decides again.`
        : `${name} is no longer the boss. ${title} has no boss now.`,
    );
  const how = await bossTell(p, id, bossWords(mailByTool(p, id)));
  toast(
    `${name} is the boss of ${title}${how === 'now' ? ' and has been told.' : how === 'soon' ? '. It is told as soon as it is free.' : '. It is told when it next starts.'}`,
  );
}

const bossItem = (p, id, name) => ({
  label: (S.config.projectBoss || {})[p.dir] === id ? 'Remove as boss' : 'Make boss',
  icon: 'star',
  run: () => setBoss(p, id, name),
});
// The tag in the list: it says who decides, and opens the project's mailbox.
const bossTag = (p, id) =>
  isBoss(p, id)
    ? h(
        'span.tag.boss',
        {
          title: 'The boss of this project: it decides who does what. Click for the mailbox.',
          onclick: (e) => {
            e.stopPropagation();
            openMailbox(p.dir);
          },
        },
        'Boss',
      )
    : null;

// Choosing the boss from the mailbox panel: the same sessions the mailbox reaches.
function bossMenu(el, p) {
  const r = el.getBoundingClientRect();
  const marked = (S.config.projectBoss || {})[p.dir];
  const all = mailPeople(p);
  const shown = [...all.filter((m) => m.keep), ...all.filter((m) => !m.keep)].slice(0, MAIL_MOST);
  menu(r.left, r.bottom + 4, [
    { heading: `Boss of ${projectTitle(p)}` },
    ...shown.map((m) => ({
      label: m.name,
      hint: [m.agent, m.role].filter(Boolean).join(' · '),
      checked: marked === m.id,
      run: () => (marked === m.id ? null : setBoss(p, m.id, m.name)),
    })),
    marked ? '-' : null,
    marked ? { label: 'No boss', icon: 'x', run: () => setBoss(p, marked, mailNameOf(p, marked)) } : null,
  ]);
}

// ---------- who is in the project ----------

const MAIL_MOST = 20; // old conversations are not worth the words: the rest are reached by name
const MAIL_WAIT = 40000; // how long a sender is kept waiting for another agent's program to start

// Everyone a message can go to: Claude Code sessions and sessions on other agents.
function mailPeople(p) {
  const recs = agentRecords(p.dir);
  const onAgent = new Set(recs.map((r) => r.memberId));
  const t = teamOf(p.dir);
  const out = [];
  const sessions = p.sessions
    .filter((s) => !onAgent.has(s.id) && !subOf(s.id) && ((!isHiddenSession(s) && !s.empty) || tabFor(s.id)))
    .sort((a, b) => b.mtime - a.mtime);
  for (const s of sessions) {
    const lv = S.live.get(s.id);
    const tab = tabFor(s.id);
    const role = t && roleOf(p.dir, s.id);
    out.push({
      id: s.id,
      name: sessionTitle(s),
      agent: 'Claude Code',
      s,
      state: lv ? (lv.status === 'idle' ? 'idle' : 'busy') : tab && !tab.exited ? 'idle' : 'closed',
      role: role ? role.title : '',
      // Always worth listing: on the team, running, pinned, or named by the user.
      keep: Boolean(role || lv || tab || isPinned(s) || S.config.sessionAlias[s.id] || isBoss(p, s.id)),
    });
  }
  for (const rec of recs) {
    const tab = agentTabFor(rec.id);
    out.push({
      id: rec.memberId,
      name: rec.name,
      agent: agentInfo(rec.agent).name,
      rec,
      state: tab && !tab.exited ? 'running' : 'closed',
      role: '',
      keep: true,
    });
  }
  return out;
}

function mailFind(p, text, not) {
  const t = String(text || '')
    .trim()
    .toLowerCase();
  if (!t) return null;
  const all = mailPeople(p).filter((m) => m.id !== not);
  return all.find((m) => m.name.toLowerCase() === t) || all.find((m) => m.id.startsWith(t)) || all.find((m) => m.name.toLowerCase().includes(t)) || null;
}

const mailNameOf = (p, id) => {
  const m = mailPeople(p).find((x) => x.id === id);
  return m ? m.name : (tabFor(id) || {}).name || (S.live.get(id) || {}).name || 'a session';
};

function mailLog(p, entry) {
  try {
    deck.mailLog(p.dir, entry);
  } catch {
    // the log is a record, never a reason to fail a delivery
  }
}

// ---------- what a session asks for (mailbox_list, mailbox_send) ----------

async function mailCommand(q) {
  const p = projectByDir(q.dir);
  if (!p || p.server) return 'The Loop mailbox works for projects on this PC.';
  const me = mailNameOf(p, q.me);
  const shell = q.via === 'shell'; // asked with the loop-mail command, so answered in its words

  if (q.action === 'mail_list') {
    const all = mailPeople(p);
    const others = all.filter((m) => m.id !== q.me);
    const boss = bossOf(p);
    // The boss first, then whoever is on the team, running or named, then the most recent of the rest.
    const first = (m) => (boss && boss.id === m.id ? 0 : m.keep ? 1 : 2);
    const shown = [...others].sort((x, y) => first(x) - first(y)).slice(0, MAIL_MOST);
    const twice = (m) => shown.filter((x) => x.name.toLowerCase() === m.name.toLowerCase()).length > 1;
    const line = (m) =>
      `- "${m.name}"${twice(m) ? ` [id ${m.id.slice(0, 8)}]` : ''}: ${m.agent}, ${m.state}${m.role ? `, ${m.role}` : ''}${boss && boss.id === m.id ? ', the boss' : ''}`;
    mailLog(p, { kind: 'list', from: me, note: `${others.length} other session${others.length === 1 ? '' : 's'}` });
    // Looking again and again while a session works is how an agent waits, and every look is a paid call.
    // A second look that would say the same thing says so instead, and how waiting really works.
    const picture = shown.map(line).join('\n');
    const before = mailLooks.get(q.me);
    mailLooks.set(q.me, { at: Date.now(), picture });
    if (before && before.picture === picture && Date.now() - before.at < 120000)
      return `Nothing has changed since you looked ${Math.max(1, Math.round((Date.now() - before.at) / 1000))} seconds ago. Do not keep checking: when a session answers, its message arrives here by itself and starts you again. End your turn now if you have nothing else to do.`;
    return [
      `Loop mailbox of this project. You are "${me}"${boss && boss.id === q.me ? ', the boss: you decide who does what' : ''}.`,
      shown.length ? shown.map(line).join('\n') : 'No other session in this project yet.',
      !boss ? 'This project has no boss.' : '',
      others.length > shown.length ? `${others.length - shown.length} older sessions are not listed; one of them can still be reached by its name.` : '',
      !shown.length
        ? ''
        : shell
          ? 'Send with: loop-mail send "the name" "your message" (no double quotes inside the message). A closed session is woken by it.'
          : 'Send with mailbox_send (to: the name). A closed session is woken by the message.',
    ]
      .filter(Boolean)
      .join('\n');
  }

  if (q.action === 'mail_send') {
    const text = String(q.text || '').trim();
    if (!text) return shell ? 'Say what you need: loop-mail send "the name" "your message".' : 'Say what you need in "text".';
    const m = mailFind(p, q.session, q.me);
    if (!m) return `No other session called "${q.session}" in this project. ${shell ? 'Run loop-mail list' : 'Call mailbox_list'} for the names.`;
    // Thanks and "received" are not carried: each one would cost the other session a whole turn to read.
    if (mailIsAck(text)) {
      mailLog(p, { kind: 'send', from: me, to: m.name, text, result: 'skipped', note: 'an acknowledgement: not carried' });
      return `Not sent: that reads as an acknowledgement or thanks, and the mailbox does not carry those (each one costs "${m.name}" a turn). Nothing more is needed. If you do need something from it, say what.`;
    }
    // An answer is told apart from new work, so the one who asked does not answer it back.
    const log = await deck.mailList(p.dir).catch(() => []);
    const last = log.find(
      (e) =>
        e.kind === 'send' && (e.result === 'delivered' || e.result === 'woken') && ((e.from === me && e.to === m.name) || (e.from === m.name && e.to === me)),
    );
    const answer = Boolean(last && last.from === m.name && last.re === false && Date.now() - last.at < 6 * 3600e3);
    const r = await mailDeliver(p, me, m, text, answer);
    mailLog(p, { kind: 'send', from: me, to: m.name, text, result: r.result, note: r.note, re: answer });
    if (r.result === 'failed') return `"${m.name}" did not get it: ${r.note}`;
    if (answer) return `Delivered to "${m.name}". If that was your answer to what it asked, nothing more is needed: end your turn.`;
    return `${r.result === 'woken' ? `"${m.name}" was closed: your message woke it and it is working on it now.` : `Delivered to "${m.name}".`} Its answer arrives here as a message and starts you again: do not wait for it, check on it or look at the mailbox meanwhile. Carry on with your own part, or end your turn.`;
  }
  return 'The mailbox does not know that request.';
}

// What each session last saw in the mailbox, to answer a look that would say the same again.
const mailLooks = new Map();

// Whether a message is only thanks or "received": short, opening with such a word, and asking for nothing.
function mailIsAck(text) {
  const t = String(text || '')
    .replace(/^[\s"'“”]+/, '')
    .trim();
  if (!t || t.length > 90 || /\?/.test(t)) return false;
  if (
    !/^(thanks|thank you|thx|ty|ok|okay|got it|received|noted|acknowledged|roger|understood|great|perfect|nice|good job|well done|report received)\b/i.test(t)
  )
    return false;
  return !/\b(please|now|next|then|also|but|can you|could you|go ahead|proceed|continue|start|do|run|create|make|fix|change|add|remove|check|send|use|need|wait|stop)\b/i.test(
    t,
  );
}

// One message into one session. { result: 'delivered' | 'woken' | 'failed', note }.
// `answer`: it answers what the receiver asked, so the receiver must not answer it back.
async function mailDeliver(p, from, m, text, answer) {
  // The receiver answers through the mailbox too; a reply left in its own chat never reaches the sender.
  // How it answers depends on its agent: with Loop's tool where it has it, else with the command.
  const how =
    !m.rec || agentInfo(m.rec.agent).tools
      ? `with mailbox_send (to "${from}", text: 3 lines or fewer plus the commit, PR or file link)`
      : `by running this shell command: loop-mail send "${from}" "your answer" (3 lines or fewer plus the commit, PR or file link; no double quotes inside it)`;
  const said = answer
    ? `Session message from "${from}": ${text} | If this answers what you sent: do not reply to it, not even with thanks. If it is new work for you: when it is done, reply to ${from} ${how}.`
    : `Session message from "${from}": ${text} | If this is work for you: when it is done, reply to ${from} ${how}. If it is a reply, an acknowledgement or thanks: do not answer it.`;
  if (m.rec) {
    // Another agent's program has one way in, its terminal. A closed one is
    // opened first, in the background, the way a message wakes a Claude session.
    let tab = agentTabFor(m.rec.id);
    let woke = false;
    if (!tab || tab.exited) {
      const a = agentInfo(m.rec.agent);
      if (a.installed === false)
        return { result: 'failed', note: `${a.tool} is not installed on this PC, so its session cannot be started. Give the work to another session.` };
      if (!p.exists) return { result: 'failed', note: 'the project folder was moved or deleted.' };
      if (tab) await closeTab(tab.id);
      if (S.order.length >= 16)
        return {
          result: 'failed',
          note: 'Loop has 16 terminals open and cannot start another. Ask the user to close one, or give the work to a session that is running.',
        };
      openAgentSession(m.rec, false);
      tab = agentTabFor(m.rec.id);
      if (!tab) return { result: 'failed', note: `Loop could not open its ${m.agent} terminal.` };
      const gone = `its ${m.agent} terminal closed while starting. Ask the user to open it and check it is signed in.`;
      const stuck = `its ${m.agent} terminal is open but showing something only the user can answer (a sign-in or a question). Ask the user to look at it, or give the work to another session.`;
      // The sender is waiting on this call, and its own program gives up after about
      // a minute: a slow start is finished behind its back, and only a failure is added to the log.
      const ready = agentReady(tab, m.rec.agent, 120);
      const how = await Promise.race([ready, sleep(MAIL_WAIT).then(() => 'slow')]);
      if (how === 'gone') return { result: 'failed', note: gone };
      if (how === 'stuck') return { result: 'failed', note: stuck };
      if (how === 'slow') {
        const late = tab;
        ready.then((end) => {
          if (end === 'ready') return typeQueued(late, said);
          mailLog(p, { kind: 'send', from, to: m.name, text, result: 'failed', note: end === 'gone' ? gone : stuck });
        });
        return { result: 'woken', note: `its ${m.agent} terminal is still starting: the message goes in the moment it is ready` };
      }
      woke = true;
    }
    await typeQueued(tab, said);
    return { result: woke ? 'woken' : 'delivered', note: woke ? `opened its ${m.agent} terminal` : `typed into its ${m.agent} terminal` };
  }
  const was = S.live.has(m.s.id) || Boolean(tabFor(m.s.id));
  const r = await sayTo(p, m.s, said);
  if (!r.ok) return { result: 'failed', note: r.text || 'Loop could not reach it.' };
  return { result: was ? 'delivered' : 'woken', note: '' };
}

// ---------- the panel: a project's mailbox calls of the last day ----------

function openMailbox(dir) {
  S.drawer = { ...S.drawer, open: true, mode: 'mail', dir, member: null, mail: null };
  renderTools();
  renderDrawer();
  loadMail();
}

async function loadMail() {
  const d = S.drawer;
  if (!d.open || d.mode !== 'mail' || !d.dir) return;
  const dir = d.dir;
  const list = await deck.mailList(dir).catch(() => []);
  if (S.drawer.mode !== 'mail' || S.drawer.dir !== dir) return;
  S.drawer.mail = list;
  renderDrawer();
}

const MAIL_WORDS = { delivered: 'Delivered', woken: 'Woke it', failed: 'Not delivered', skipped: 'Not carried' };

function mailRow(e) {
  const open = h('p.mail-text', {}, e.text);
  const long = e.kind !== 'list' && (e.text.length > 220 || e.text.split('\n').length > 4);
  return h(
    'div.mail-row',
    {
      class: [e.kind === 'list' ? 'look' : e.result || '', long ? 'long' : ''].join(' '),
      title: long ? 'Click to read all of it' : '',
      onclick: long ? (ev) => ev.currentTarget.classList.toggle('open') : null,
    },
    h(
      'div.mail-top',
      {},
      e.kind === 'list' ? h('b', {}, e.from, h('span.mail-arrow', {}, 'looked at who is here')) : h('b', {}, e.from, h('span.mail-arrow', {}, 'to'), e.to),
      h('em', { title: new Date(e.at).toLocaleString() }, ago(e.at)),
    ),
    e.kind === 'list' ? null : open,
    h('div.mail-foot', {}, e.kind === 'list' ? null : h('span.mail-state', {}, MAIL_WORDS[e.result] || ''), e.note ? h('span.mail-note', {}, e.note) : null),
  );
}

function renderMailbox(box, d) {
  const p = projectByDir(d.dir);
  const list = d.mail || [];
  const boss = p && bossOf(p);
  const sent = list.filter((e) => e.kind !== 'list');
  put(
    box,
    h(
      'div.mem-head',
      {},
      h(
        'div.mem-title',
        {},
        h('span.mem-mark', {}, icon('mail')),
        h('div.grow', {}, h('h2', {}, 'Mailbox'), h('small', {}, p ? projectTitle(p) : 'Project')),
        h('button.mini', { title: 'Close', 'aria-label': 'Close mailbox', onclick: toggleDrawer }, icon('x')),
      ),
      h(
        'div.mem-tools',
        {},
        h(
          'span.grow.mem-hint',
          {},
          boss
            ? h('span', {}, 'Boss: ', h('b', {}, mailNameOf(p, boss.id)), boss.marked ? '' : " (the team's CEO)")
            : 'No boss yet: nobody decides who does what.',
        ),
        p
          ? h(
              'button.btn.small',
              { title: 'The boss decides who does what in this project', onclick: (e) => bossMenu(e.currentTarget, p) },
              icon('star'),
              boss && boss.marked ? 'Change' : 'Choose boss',
            )
          : null,
        h('button.btn.small', { title: 'Read the mailbox again', 'aria-label': 'Refresh', onclick: loadMail }, icon('refresh')),
      ),
      h(
        'p.mem-about',
        {},
        `What the sessions of this project sent each other in the last 24 hours${sent.length ? `: ${sent.length} message${sent.length === 1 ? '' : 's'}` : ''}. Older ones are removed.`,
      ),
    ),
    h(
      'div.drawer-body',
      {},
      d.mail === null
        ? h('div.side-empty', {}, 'Reading the mailbox…')
        : list.length
          ? list.map(mailRow)
          : h(
              'div.mem-empty',
              {},
              h('span.mem-mark.big', {}, icon('mail')),
              h('b', {}, 'Nothing in the last 24 hours'),
              h('p', {}, 'When a session of this project looks up the others or sends one a message, it shows here.'),
            ),
    ),
  );
}

// A call was logged: the open panel of that project shows it at once.
if (typeof deck !== 'undefined' && deck.onMail) {
  deck.onMail((dir) => {
    if (S.drawer && S.drawer.open && S.drawer.mode === 'mail' && S.drawer.dir === dir) loadMail();
  });
}
