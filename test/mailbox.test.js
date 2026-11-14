// The Loop mailbox: the day-long log, the two tools a session gets, the boss,
// and how a message is delivered to a Claude Code session or one on another agent.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mailbox = require('../src/main/mailbox');
const memory = require('../src/main/memory');

const H = 3600e3;
const dir = 'C--mail-test';

// ---------- the log ----------

test('the log keeps one day, newest first, and nothing older', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-mail-'));
  mailbox.init(root);
  const now = Date.parse('2026-11-14T12:00:00Z');
  mailbox.add(dir, { kind: 'send', from: 'Boss', to: 'Dev 1', text: 'old one', result: 'woken' }, now - 25 * H);
  mailbox.add(dir, { kind: 'send', from: 'Boss', to: 'Dev 1', text: 'build   the\ncart', result: 'woken' }, now - 2 * H);
  mailbox.add(dir, { kind: 'list', from: 'Boss', note: '2 other sessions' }, now - H);
  mailbox.add(dir, { kind: 'send', from: 'Dev 1', to: 'Boss', text: 'done', result: 'nonsense', note: 'x' }, now);

  const list = mailbox.list(dir, now);
  assert.deepStrictEqual(
    list.map((e) => [e.kind, e.from, e.to, e.text, e.result]),
    [
      ['send', 'Dev 1', 'Boss', 'done', ''], // a result Loop does not know is not kept as one
      ['list', 'Boss', '', '', ''],
      ['send', 'Boss', 'Dev 1', 'build the cart', 'woken'],
    ],
  );
  // the old line is gone from the file itself, not only from what is shown
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(root, 'mailbox', `${dir}.json`), 'utf8')).length, 3);

  // a day later nothing is left, and the sweep removes the file of a project nobody opens
  mailbox.sweep(now + 25 * H);
  assert.strictEqual(fs.existsSync(path.join(root, 'mailbox', `${dir}.json`)), false);
  assert.deepStrictEqual(mailbox.list(dir, now + 25 * H), []);
});

test('the log takes no path from a caller and does not grow without end', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-mail-'));
  mailbox.init(root);
  assert.strictEqual(mailbox.add('..\\..\\evil', { from: 'a', to: 'b', text: 'x' }), null);
  assert.deepStrictEqual(mailbox.list('../evil'), []);
  const now = Date.now();
  for (let i = 0; i < 520; i++) mailbox.add(dir, { from: 'a', to: 'b', text: String(i), result: 'delivered' }, now - 520 + i);
  const list = mailbox.list(dir, now);
  assert.strictEqual(list.length, 500);
  assert.strictEqual(list[0].text, '519');
  assert.strictEqual(mailbox.add(dir, { from: 'a', to: 'b', text: 'y'.repeat(5000) }, now).text.length, 2000);
});

// ---------- the tools ----------

test('every session gets the two mailbox tools, and they go to the window', async () => {
  const me = '11111111-1111-4111-8111-111111111111';
  const listed = (await memory.handleRpc({ id: 1, method: 'tools/list' }, { dir, sessionId: me })).result.tools;
  const names = listed.map((t) => t.name);
  assert.ok(names.includes('mailbox_list') && names.includes('mailbox_send'));
  // Their descriptions are read on every turn of every session: keep them short.
  const cost = listed.filter((t) => t.name.startsWith('mailbox_')).reduce((n, t) => n + JSON.stringify(t).length, 0);
  assert.ok(cost < 1100, `the mailbox tools cost ${cost} characters in every session`);

  const asked = [];
  memory.setTeamDo(async (q) => (asked.push(q), 'ok'));
  const { callTool } = memory._test;
  assert.strictEqual(await callTool('mailbox_list', {}, { dir, sessionId: me }), 'ok');
  assert.strictEqual(await callTool('mailbox_send', { to: ' Dev 1 ', text: 'Build the cart page.' }, { dir, sessionId: me }), 'ok');
  assert.deepStrictEqual(asked, [
    { dir, me, action: 'mail_list' },
    { dir, me, action: 'mail_send', session: 'Dev 1', text: 'Build the cart page.' },
  ]);
});

test('only the session the user marked is told it is the boss, team or no team', () => {
  const boss = '22222222-2222-4222-8222-222222222222';
  const dev = '33333333-3333-4333-8333-333333333333';
  memory.setTeamLookup(() => null);
  memory.setBossLookup((d) => (d === dir ? boss : ''));
  const brief = memory.startBrief(dir, boss);
  assert.match(brief, /^The user made you the boss of this project/);
  assert.match(brief, /mailbox_list/);
  assert.match(brief, /mailbox_send/);
  assert.ok(brief.length < 700, `the boss brief is paid for on every turn (${brief.length})`);
  assert.strictEqual(memory.startBrief(dir, dev), '');
  assert.strictEqual(memory.startBrief('C--other', boss), '');

  // on a team, the boss part comes first, so it is never the part that is cut off
  memory.setTeamLookup(() => ({ roles: [{ key: 'dev', title: 'Developer' }], members: { [boss]: 'dev', [dev]: 'dev' } }));
  assert.match(memory.startBrief(dir, boss), /^The user made you the boss of this project.*You are a member of the team/s);
  assert.match(memory.startBrief(dir, dev), /^You are a member of the team/);
  memory.setTeamLookup(() => null);
  memory.setBossLookup(() => '');
});

// ---------- the window's side ----------
// mailbox.js runs in the window, which has no module system: load the file with
// the handful of globals it reaches for.
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; // the boss
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; // a developer on the team, closed
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'; // a direct session, running
const X = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'; // a ChatGPT session
const K = '99999999-9999-4999-8999-999999999999'; // a Kimi session: its agent takes no tools from Loop

function windowSide() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'mailbox.js'), 'utf8');
  const w = { sent: [], typed: [], log: [], told: [], toasts: [], opened: [], tabs: {}, keys: [], refuse: '', kimiInstalled: true, slow: false };
  // Both programs waiting to be typed into: ChatGPT's prompt and footer, Kimi's input box.
  w.screen = ['› Ask Codex to do anything', '  ← for agents · ? for shortcuts', ' │ >            │'];
  const sessions = [
    { id: A, title: 'Planner', mtime: 5 },
    { id: B, title: 'Dev one', mtime: 4 },
    { id: C, title: 'Helper', mtime: 3 },
    { id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', title: 'old hidden chat', mtime: 1 },
  ];
  const S = {
    config: { projectBoss: {}, sessionAlias: {}, agentSessions: {}, projectTeam: {} },
    live: new Map([[C, { status: 'busy', name: 'Helper' }]]),
    drawer: { open: false },
    tabs: new Map(),
    order: [],
  };
  const p = { dir, sessions, exists: true, path: 'C:/mail-test', server: '' };
  const recs = [
    { id: 'rec1', memberId: X, agent: 'codex', name: 'GPT dev', dir },
    { id: 'rec2', memberId: K, agent: 'kimi', name: 'Kimi dev', dir },
  ];
  w.recs = recs;
  // A terminal Loop opens for a session on another agent.
  w.open = (rec) => {
    const tab = { id: 'tab-' + rec.id, exited: false };
    w.tabs[rec.id] = tab;
    S.tabs.set(tab.id, tab);
    return tab;
  };
  w.S = S;
  w.p = p;
  const scope = {
    S,
    deck: { mailLog: (d, e) => w.log.push(e), mailList: async () => w.deckLog || [], onMail: () => {}, write: (id, keys) => w.keys.push(keys) },
    projectByDir: (d) => (d === dir ? p : null),
    projectTitle: () => 'Ecom',
    agentRecords: () => recs,
    agentTabFor: (id) => w.tabs[id] || null,
    agentInfo: (id) =>
      id === 'codex'
        ? { name: 'ChatGPT', tool: 'Codex', tools: true, installed: true }
        : { name: 'Kimi', tool: 'Kimi Code', tools: false, installed: w.kimiInstalled },
    openAgentSession: (rec) => (w.opened.push(rec.name), w.open(rec)),
    closeTab: async (id) => S.tabs.delete(id),
    screenRows: () => (typeof w.screen === 'function' ? w.screen() : w.screen),
    // Seconds pass at once. The long wait a sender is given never ends, unless a test says the start is slow.
    sleep: (ms) => (ms >= 30000 && !w.slow ? new Promise(() => {}) : Promise.resolve()),
    tellWhenIdle: (id, text) => w.told.push({ id, text, soon: true }),
    menu: () => {},
    teamOf: (d) => S.config.projectTeam[d] || null,
    roleOf: (d, id) => {
      const t = S.config.projectTeam[d];
      return t ? t.roles.find((r) => r.key === t.members[id]) || null : null;
    },
    subOf: () => null,
    isHiddenSession: (s) => s.title === 'old hidden chat',
    isPinned: () => false,
    tabFor: () => null,
    sessionTitle: (s) => s.title,
    sayTo: async (pp, s, text) => (w.sent.push({ id: s.id, text }), w.refuse ? { ok: false, text: w.refuse } : { ok: true }),
    typeInto: async (tab, text) => w.typed.push({ tab, text }),
    nudge: async (pp, s, text) => (w.told.push({ id: s.id, text }), S.live.has(s.id)),
    save: () => {},
    renderList: () => {},
    renderTools: () => {},
    renderDrawer: () => {},
    toggleDrawer: () => {},
    toast: (t) => w.toasts.push(t),
    h: () => null,
    icon: () => null,
    put: () => {},
    ago: () => '',
  };
  const keys = Object.keys(scope);
  Object.assign(w, new Function(...keys, src + '; return { bossOf, isBoss, setBoss, mailCommand, mailPeople };')(...keys.map((k) => scope[k])));
  return w;
}

test('a project has one boss: the session the user marked, else the CEO of its team', async () => {
  const w = windowSide();
  assert.strictEqual(w.bossOf(w.p), null);
  w.S.config.projectTeam[dir] = {
    roles: [
      { key: 'ceo', title: 'CEO' },
      { key: 'dev', title: 'Developer' },
    ],
    members: { [C]: 'ceo', [B]: 'dev' },
  };
  assert.deepStrictEqual(w.bossOf(w.p), { id: C, marked: false });

  // the user's mark wins over the CEO, and a running session is told at once
  await w.setBoss(w.p, C, 'Helper');
  assert.deepStrictEqual(w.bossOf(w.p), { id: C, marked: true });
  assert.match(w.toasts.pop(), /has been told/);
  await w.setBoss(w.p, A, 'Planner'); // marking another moves the mark: one boss a project
  assert.deepStrictEqual(w.S.config.projectBoss, { [dir]: A });
  // …and the one who held it is told it no longer decides
  assert.ok(w.told.some((x) => x.id === C && /made "Planner" the boss of this project: you no longer decide/.test(x.text)));
  assert.match(w.toasts.pop(), /told when it next starts/);
  assert.ok(w.isBoss(w.p, A) && !w.isBoss(w.p, C));
  // a session on another agent can be the boss too
  await w.setBoss(w.p, X, 'GPT dev');
  assert.deepStrictEqual(w.bossOf(w.p), { id: X, marked: true });
  // taking the mark away gives the decisions back to the CEO
  await w.setBoss(w.p, X, 'GPT dev');
  assert.deepStrictEqual(w.bossOf(w.p), { id: C, marked: false });
  // a mark on a session that is gone counts for nothing
  w.S.config.projectBoss[dir] = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  assert.deepStrictEqual(w.bossOf(w.p), { id: C, marked: false });
});

test('mailbox_list shows every session of the project, in the team or not', async () => {
  const w = windowSide();
  w.S.config.projectBoss[dir] = A;
  w.S.config.projectTeam[dir] = { roles: [{ key: 'dev', title: 'Developer' }], members: { [B]: 'dev' } };
  const text = await w.mailCommand({ dir, me: A, action: 'mail_list' });
  assert.match(text, /^Loop mailbox of this project\. You are "Planner", the boss: you decide who does what\./);
  assert.match(text, /- "Dev one": Claude Code, closed, Developer/); // on the team
  assert.match(text, /- "Helper": Claude Code, busy/); // a direct session, no team role
  assert.match(text, /- "GPT dev": ChatGPT, closed\n- "Kimi dev": Kimi, closed/); // other agents, listed like any session
  assert.doesNotMatch(text, /old hidden chat|Planner":/); // not the hidden one, not the asker
  assert.ok(text.length < 560, `the list is read before every decision: keep it short (${text.length})`);
  assert.deepStrictEqual(w.log.pop(), { kind: 'list', from: 'Planner', note: '4 other sessions' });

  // someone else sees who the boss is
  assert.match(await w.mailCommand({ dir, me: B, action: 'mail_list' }), /You are "Dev one"\.\n- "Planner": Claude Code, closed, the boss/);
});

test('mailbox_send wakes a closed session, reaches a running one, and says so', async () => {
  const w = windowSide();
  // closed: the message itself wakes it
  let said = await w.mailCommand({ dir, me: A, action: 'mail_send', session: 'dev one', text: 'Build the cart page. Check: npm test.' });
  assert.match(said, /^"Dev one" was closed: your message woke it/);
  assert.strictEqual(w.sent[0].id, B);
  assert.match(
    w.sent[0].text,
    /^Session message from "Planner": Build the cart page\. Check: npm test\. \| If this is work for you: when it is done, reply to Planner with mailbox_send \(to "Planner"/,
  );
  assert.deepStrictEqual(w.log.pop(), {
    kind: 'send',
    from: 'Planner',
    to: 'Dev one',
    text: 'Build the cart page. Check: npm test.',
    result: 'woken',
    note: '',
    re: false,
  });

  // running, and not on any team: delivered all the same; anyone may send, not only the boss
  said = await w.mailCommand({ dir, me: B, action: 'mail_send', session: 'Helper', text: 'Which port does the API use?' });
  assert.match(said, /^Delivered to "Helper"\./);
  assert.strictEqual(w.log.pop().result, 'delivered');

  // what Loop could not deliver is said, and logged as such
  w.refuse = 'Answer the question on screen first.';
  said = await w.mailCommand({ dir, me: A, action: 'mail_send', session: 'Helper', text: 'hello' });
  assert.match(said, /^"Helper" did not get it: Answer the question on screen first\./);
  assert.deepStrictEqual([w.log.at(-1).result, w.log.at(-1).note], ['failed', 'Answer the question on screen first.']);
  w.refuse = '';

  // nobody by that name, nothing to say, and never to oneself
  assert.match(await w.mailCommand({ dir, me: A, action: 'mail_send', session: 'Nobody', text: 'x' }), /^No other session called "Nobody"/);
  assert.match(await w.mailCommand({ dir, me: A, action: 'mail_send', session: 'Planner', text: 'x' }), /^No other session called "Planner"/);
  assert.match(await w.mailCommand({ dir, me: A, action: 'mail_send', session: 'Helper', text: '  ' }), /^Say what you need/);
});

test('a session on any agent is woken by a message: Loop opens its terminal and types it in', async () => {
  const w = windowSide();
  // closed, on ChatGPT: its terminal is opened in the background, and once it is ready the message goes in
  let said = await w.mailCommand({ dir, me: A, action: 'mail_send', session: 'GPT dev', text: 'Review the\ncart page.' });
  assert.match(said, /^"GPT dev" was closed: your message woke it/);
  assert.deepStrictEqual(w.opened, ['GPT dev']);
  assert.strictEqual(w.typed[0].tab.id, 'tab-rec1');
  // one line, and it answers with the tool, because ChatGPT is given Loop's tools
  assert.match(
    w.typed[0].text,
    /^Session message from "Planner": Review the cart page\. \| If this is work for you: when it is done, reply to Planner with mailbox_send \(to "Planner"/,
  );
  assert.deepStrictEqual([w.log.at(-1).result, w.log.at(-1).note], ['woken', 'opened its ChatGPT terminal']);

  // already open: typed in, no second terminal
  said = await w.mailCommand({ dir, me: A, action: 'mail_send', session: 'GPT dev', text: 'Also check the footer.' });
  assert.match(said, /^Delivered to "GPT dev"\./);
  assert.deepStrictEqual(w.opened, ['GPT dev']);
  assert.deepStrictEqual([w.log.at(-1).result, w.log.at(-1).note], ['delivered', 'typed into its ChatGPT terminal']);

  // closed, on an agent that takes no tools: woken the same way, and told the command to answer with
  said = await w.mailCommand({ dir, me: A, action: 'mail_send', session: 'Kimi dev', text: 'Write the tests.' });
  assert.match(said, /^"Kimi dev" was closed: your message woke it/);
  assert.match(w.typed.at(-1).text, /reply to Planner by running this shell command: loop-mail send "Planner" "your answer" \(3 lines or fewer/);
  assert.strictEqual(w.log.at(-1).note, 'opened its Kimi terminal');

  // a terminal that had exited is closed and opened again
  w.tabs.rec2.exited = true;
  await w.mailCommand({ dir, me: A, action: 'mail_send', session: 'Kimi dev', text: 'One more thing.' });
  assert.deepStrictEqual(w.opened, ['GPT dev', 'Kimi dev', 'Kimi dev']);
  assert.strictEqual(w.tabs.rec2.exited, false);
});

test('what cannot be started is said plainly, so the sender can give the work to someone else', async () => {
  const w = windowSide();
  w.kimiInstalled = false;
  assert.match(
    await w.mailCommand({ dir, me: A, action: 'mail_send', session: 'Kimi dev', text: 'x' }),
    /^"Kimi dev" did not get it: Kimi Code is not installed on this PC/,
  );
  w.kimiInstalled = true;
  w.S.order = new Array(16).fill('t');
  assert.match(await w.mailCommand({ dir, me: A, action: 'mail_send', session: 'Kimi dev', text: 'x' }), /Loop has 16 terminals open/);
  assert.strictEqual(w.log.at(-1).result, 'failed');
  assert.deepStrictEqual(w.opened, []);
});

test('a session on any agent sends: with the tool, or with the loop-mail command in its own words', async () => {
  const w = windowSide();
  // through the tool, as ChatGPT does
  await w.mailCommand({ dir, me: X, action: 'mail_send', session: 'Planner', text: 'The API is ready.' });
  assert.match(w.sent[0].text, /^Session message from "GPT dev": The API is ready\./);

  // through the command, as Kimi, Grok or Gemini do: the same mailbox, answered in the command's words
  const list = await w.mailCommand({ dir, me: K, action: 'mail_list', via: 'shell' });
  assert.match(list, /^Loop mailbox of this project\. You are "Kimi dev"\./);
  assert.match(list, /Send with: loop-mail send "the name" "your message"/);
  assert.doesNotMatch(list, /mailbox_send/);
  const said = await w.mailCommand({ dir, me: K, action: 'mail_send', session: 'Dev one', text: 'Tests are written.', via: 'shell' });
  assert.match(said, /^"Dev one" was closed: your message woke it/);
  assert.match(w.sent.at(-1).text, /^Session message from "Kimi dev": Tests are written\./);
  assert.match(await w.mailCommand({ dir, me: K, action: 'mail_send', session: 'Nobody', text: 'x', via: 'shell' }), /Run loop-mail list for the names\.$/);
});

test('a boss on any agent is told how it reaches the others, now or when its terminal next opens', async () => {
  const w = windowSide();
  // closed, on an agent with no tools: kept for when its terminal opens, in the command's words
  await w.setBoss(w.p, K, 'Kimi dev');
  assert.match(w.toasts.pop(), /told when it next starts/);
  assert.match(w.recs[1].tell, /you are|made you the boss/);
  assert.match(w.recs[1].tell, /loop-mail list/);
  assert.doesNotMatch(w.recs[1].tell, /mailbox_list/);
  // open, on ChatGPT: typed in at once, in the tool's words
  w.open(w.recs[0]);
  await w.setBoss(w.p, X, 'GPT dev');
  assert.match(w.toasts.pop(), /has been told/);
  assert.match(w.typed.at(-1).text, /made you the boss.*mailbox_list/);
});

// ---------- the loop-mail command ----------

test('loop-mail asks Loop over its own address and prints the answer', async () => {
  const http = require('http');
  const cli = require('../src/main/mail-cli');
  const asked = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      asked.push({ url: req.url, body: raw ? JSON.parse(raw) : {} });
      res.writeHead(req.url.endsWith('/send') && !JSON.parse(raw).to ? 400 : 200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(req.url.endsWith('/list') ? 'Loop mailbox of this project.' : 'Delivered to "Boss".');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const env = { LOOP_MAIL: `http://127.0.0.1:${server.address().port}/mail/abc/C--mail-test/${K}` };
  try {
    assert.deepStrictEqual(await cli.main(['list'], env), { code: 0, text: 'Loop mailbox of this project.' });
    // every word after the name is the message, quoted or not, in any language
    assert.deepStrictEqual(await cli.main(['send', 'Boss', 'Done:', 'ਟੈਸਟ', 'pass & ok'], env), { code: 0, text: 'Delivered to "Boss".' });
    assert.deepStrictEqual(asked[1], { url: `/mail/abc/C--mail-test/${K}/send`, body: { to: 'Boss', text: 'Done: ਟੈਸਟ pass & ok' } });
    // what is missing is said, with how to use it
    assert.match((await cli.main([], env)).text, /^Loop mailbox: reach the other sessions/);
    assert.match((await cli.main(['send'], env)).text, /^Say who it is for\./);
    assert.strictEqual((await cli.main(['nonsense'], env)).code, 1);
    // outside a session Loop started, and with Loop closed
    assert.match((await cli.main(['list'], {})).text, /works inside a session that Loop started/);
  } finally {
    server.close();
  }
  assert.match((await cli.main(['list'], env)).text, /Loop is not running/);
});

test("Loop installs the command once and puts it on an agent session's PATH", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-mailcli-'));
  assert.deepStrictEqual(mailbox.cliEnv('http://127.0.0.1:1/mail/a/b/c', { Path: 'C:\\Windows' }).LOOP_MAIL, undefined); // not installed yet: nothing is promised
  const bin = mailbox.installCli(root, process.execPath);
  for (const f of ['loop-mail.js', 'loop-mail.cmd', 'loop-mail']) assert.ok(fs.existsSync(path.join(bin, f)), f);
  assert.match(fs.readFileSync(path.join(bin, 'loop-mail.cmd'), 'utf8'), /set ELECTRON_RUN_AS_NODE=1\r\n".+" ".+loop-mail\.js" %\*/);
  // Windows spells it Path: the session must not end up with two of them
  const env = mailbox.cliEnv('http://127.0.0.1:1/mail/a/b/c', { Path: 'C:\\Windows' });
  assert.deepStrictEqual(Object.keys(env), ['LOOP_MAIL', 'Path']);
  assert.strictEqual(env.Path, bin + path.delimiter + 'C:\\Windows');
  assert.deepStrictEqual(mailbox.cliEnv(null, { PATH: '/bin' }), {});
  // the installed command really runs, as an agent would run it
  const { spawnSync } = require('child_process');
  const cmd = process.platform === 'win32' ? path.join(bin, 'loop-mail.cmd') : path.join(bin, 'loop-mail');
  const out = spawnSync(cmd, ['help'], { encoding: 'utf8', shell: process.platform === 'win32', env: { ...process.env, LOOP_MAIL: '' } });
  assert.match(out.stdout, /loop-mail send "Session name" "text"/);
});

test('the loop-mail address answers like the tools do, and only for the right secret', async () => {
  const asked = [];
  memory.setTeamDo(async (q) => (asked.push(q), q.action === 'mail_list' ? 'the list' : 'sent'));
  await memory._test.startServerForTest();
  const base = memory.mailUrlFor(dir, K);
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+\/mail\/[a-f0-9]+\/C--mail-test\/9{8}-/);
  const post = async (url, body) => {
    const r = await fetch(url, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
    return [r.status, await r.text()];
  };
  assert.deepStrictEqual(await post(`${base}/list`), [200, 'the list']);
  assert.deepStrictEqual(await post(`${base}/send`, { to: ' Boss ', text: 'Done.' }), [200, 'sent']);
  assert.deepStrictEqual(asked, [
    { dir, me: K, via: 'shell', action: 'mail_list' },
    { dir, me: K, via: 'shell', action: 'mail_send', session: 'Boss', text: 'Done.' },
  ]);
  assert.strictEqual((await post(base.replace(/\/mail\/[a-f0-9]+\//, '/mail/0000/') + '/list'))[0], 404);
  assert.strictEqual((await fetch(`${base}/list`)).status, 405);
  memory.stop();
});

// What the first live run got wrong: words typed before the program was ready
// were lost, and typed into ChatGPT's "update available" list they chose "Update now".
test('nothing is typed until the agent is at its own prompt', async () => {
  const w = windowSide();
  // an update question first: it is put aside with Esc, never answered with the message
  const update = ['  Update available · 0.167.2 → 0.169.0', '› 1. Update now', '  2. Skip', '  3. Skip until next version', '  enter continue · esc skip'];
  const ready = w.screen;
  w.screen = () => (w.keys.includes('\x1b') ? ready : update);
  const said = await w.mailCommand({ dir, me: A, action: 'mail_send', session: 'GPT dev', text: 'Review the cart page.' });
  assert.match(said, /^"GPT dev" was closed: your message woke it/);
  assert.deepStrictEqual(w.keys, ['\x1b']);
  assert.strictEqual(w.typed.length, 1);

  // a screen Loop does not know (a sign-in, a trust question): nothing is typed, and the sender is told
  const w2 = windowSide();
  w2.screen = ['Do you trust the contents of this directory?', '› 1. Yes, continue', '  2. No, quit'];
  const no = await w2.mailCommand({ dir, me: A, action: 'mail_send', session: 'GPT dev', text: 'Review the cart page.' });
  assert.match(no, /^"GPT dev" did not get it: its ChatGPT terminal is open but showing something only the user can answer/);
  assert.strictEqual(w2.typed.length, 0);
  assert.strictEqual(w2.log.at(-1).result, 'failed');

  // its terminal closed while starting
  const w3 = windowSide();
  w3.screen = () => ((w3.tabs.rec1.exited = true), ['']);
  assert.match(await w3.mailCommand({ dir, me: A, action: 'mail_send', session: 'GPT dev', text: 'x' }), /its ChatGPT terminal closed while starting/);
});

test('a slow start does not keep the sender waiting: the message goes in when the program is ready', async () => {
  const w = windowSide();
  w.slow = true; // the sender's wait runs out before the program is up
  let up = false;
  const ready = w.screen;
  w.screen = () => (up ? ready : ['  Waiting for startup  · esc cancel']);
  const said = await w.mailCommand({ dir, me: A, action: 'mail_send', session: 'GPT dev', text: 'Review the cart page.' });
  assert.match(said, /^"GPT dev" was closed: your message woke it/);
  assert.match(w.log.at(-1).note, /still starting: the message goes in the moment it is ready/);
  assert.strictEqual(w.typed.length, 0);
  up = true;
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(w.typed.length, 1);
  assert.match(w.typed[0].text, /^Session message from "Planner": Review the cart page\./);
});

test('the mailbox tools are loaded from the start, so answering a message costs no lookup', async () => {
  const listed = (await memory.handleRpc({ id: 1, method: 'tools/list' }, { dir, sessionId: A })).result.tools;
  const up = listed.filter((t) => t._meta && t._meta['anthropic/alwaysLoad']).map((t) => t.name);
  assert.deepStrictEqual(up, ['mailbox_list', 'mailbox_send']); // only these two: every tool loaded up front is paid for in every call
});

// What the mixed live run showed: a boss on ChatGPT looked at the mailbox four
// times while it waited, and answered a report with "Thanks", which cost the
// other session a whole turn. Loop stops both itself rather than ask nicely.
test('an answer is told apart from new work, and thanks are not carried', async () => {
  const w = windowSide();
  const log = [];
  // the log as the window reads it back: newest first, as kept
  w.deckLog = log;
  const send = async (me, to, text) => {
    const said = await w.mailCommand({ dir, me, action: 'mail_send', session: to, text });
    const e = w.log.at(-1);
    log.unshift({ ...e, at: Date.now() });
    return said;
  };
  // new work: the receiver is told how to answer
  await send(A, 'Dev one', 'Build the cart page.');
  assert.match(w.sent.at(-1).text, /\| If this is work for you: when it is done, reply to Planner with mailbox_send/);
  assert.strictEqual(w.log.at(-1).re, false);
  // its answer: the one who asked is told not to answer it back
  const said = await send(B, 'Planner', 'Done: cart page built, commit abc123.');
  assert.match(w.sent.at(-1).text, /^Session message from "Dev one": Done: cart page built, commit abc123\. \| If this answers what you sent: do not reply to it, not even with thanks\. If it is new work for you: when it is done, reply to Dev one with mailbox_send/);
  assert.match(said, /^Delivered to "Planner"\. If that was your answer to what it asked, nothing more is needed/);
  assert.strictEqual(w.log.at(-1).re, true);
  // a line kept by an older Loop does not say whether it was an answer: nothing is guessed from it
  const w0 = windowSide();
  w0.deckLog = [{ kind: 'send', from: 'Dev one', to: 'Planner', text: 'Done.', result: 'delivered', note: '', at: Date.now() }];
  await w0.mailCommand({ dir, me: A, action: 'mail_send', session: 'Dev one', text: 'Build the cart page.' });
  assert.strictEqual(w0.log.at(-1).re, false);
  // thanks for it never leave: no turn is spent on the other side
  const before = w.sent.length;
  const no = await send(A, 'Dev one', 'Thanks—report received. File: D:\\shop\\cart.html');
  assert.match(no, /^Not sent: that reads as an acknowledgement or thanks/);
  assert.strictEqual(w.sent.length, before);
  assert.deepStrictEqual([w.log.at(-1).result, w.log.at(-1).note], ['skipped', 'an acknowledgement: not carried']);
  // the next job to the same session is new work again, not an "answer"
  await send(A, 'Dev one', 'Now build the checkout page.');
  assert.match(w.sent.at(-1).text, /\| If this is work for you:/);
  assert.strictEqual(w.log.at(-1).re, false);
  // short messages that ask for something are carried
  for (const text of [
    'OK, go ahead with plan B.',
    'Thanks. Which port does the API use?',
    'Great, now run the tests.',
    'Received 3 files, but the last one is empty: send it again.',
  ]) {
    assert.doesNotMatch(await send(A, 'Dev one', text), /^Not sent/, text);
  }
  for (const text of ['Thanks!', 'ok', 'Got it.', 'Received, thank you.', 'Perfect, well done.'])
    assert.match(await send(A, 'Dev one', text), /^Not sent/, text);
});

test('looking at the mailbox again while nothing changed is answered in a line', async () => {
  const w = windowSide();
  const first = await w.mailCommand({ dir, me: A, action: 'mail_list' });
  assert.match(first, /^Loop mailbox of this project\./);
  const again = await w.mailCommand({ dir, me: A, action: 'mail_list' });
  assert.match(
    again,
    /^Nothing has changed since you looked \d+ seconds? ago\. Do not keep checking: when a session answers, its message arrives here by itself/,
  );
  assert.ok(again.length < 260);
  // someone else looking is not "again", and neither is a look after something changed
  assert.match(await w.mailCommand({ dir, me: B, action: 'mail_list' }), /^Loop mailbox of this project\./);
  w.S.live.set(B, { status: 'busy' });
  assert.match(await w.mailCommand({ dir, me: A, action: 'mail_list' }), /"Dev one": Claude Code, busy/);
});
