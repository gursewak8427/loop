const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const memory = require('../src/main/memory');

const { callTool, boardRights, setRootForTest } = memory._test;
const pm = '11111111-1111-4111-8111-111111111111';
const dev = '22222222-2222-4222-8222-222222222222';
const other = '33333333-3333-4333-8333-333333333333';
const team = { roles: [{ key: 'pm', title: 'Project manager', manages: true }, { key: 'dev', title: 'Developer' }], members: { [pm]: 'pm', [dev]: 'dev' } };
const dir = 'C--board-test';

test.before(() => setRootForTest(fs.mkdtempSync(path.join(os.tmpdir(), 'loop-board-'))));

test('who may change the board', () => {
  assert.deepStrictEqual(boardRights(null, dev), { managed: false, manager: false, managers: [] });
  assert.deepStrictEqual(boardRights({ ...team, members: { [dev]: 'dev' } }, dev).managed, false); // a team without a manager is open
  assert.strictEqual(boardRights(team, pm).manager, true);
  assert.deepStrictEqual(boardRights(team, dev), { managed: true, manager: false, managers: [pm] });
});

test('without a project manager every session can add and change tickets', async () => {
  memory.setTeamLookup(() => null);
  assert.match(await callTool('task_add', { title: 'Open board ticket' }, { dir, sessionId: dev }), /^Added T1/);
  assert.match(await callTool('task_update', { id: 'T1', status: 'doing' }, { dir, sessionId: other }), /^Updated\.\nT1 \[doing\]/);
});

test('a ticket keeps its spec, whichever name the body comes under', async () => {
  memory.setTeamLookup(() => null);
  const spec = 'Goal: add contact.html. ' + 'Files: index.html links to it. '.repeat(12) + 'Check: the form shows a thank-you note.';
  const added = await callTool('task_add', { title: 'Contact page', description: spec }, { dir: 'C--spec-test', sessionId: dev });
  const id = added.match(/^Added (T\d+)/)[1];
  const taken = await callTool('task_take', {}, { dir: 'C--spec-test', sessionId: other });
  assert.ok(taken.includes(`${id} [doing] Contact page`), taken);
  assert.match(taken, /Check: the form shows a thank-you note\./); // the whole spec, not the first 240 characters
});

test('with a project manager, only the manager adds, assigns and edits', async () => {
  memory.setTeamLookup(() => team);
  assert.match(await callTool('task_add', { title: 'Sneaky' }, { dir, sessionId: dev }), /^Only the project manager/);
  assert.match(await callTool('task_add', { title: 'Build login', assignee: 'me' }, { dir, sessionId: pm }), /^Added T2/);
  let t2 = (await memory.taskList(dir)).find((t) => t.id === 'T2');
  assert.strictEqual(t2.assigneeId, pm);
  // the manager hands it to the developer (as the board in the app does, by session)
  await memory.taskUpdate(dir, 'T2', { assignee: 'Dev one', assigneeId: dev }, 'you');

  // the developer moves their own ticket and comments
  assert.match(await callTool('task_update', { id: 'T2', status: 'review', note: 'done, see PR' }, { dir, sessionId: dev }), /^Updated\.\nT2 \[review\]/);
  // someone else may comment but not move it or reassign it
  const r = await callTool('task_update', { id: 'T2', status: 'done', assignee: 'me', note: 'looks fine' }, { dir, sessionId: other });
  assert.match(r, /^Your comment was added\. Not changed: assigning tickets and the status of a ticket that is not assigned to you/);
  assert.match(await callTool('task_update', { id: 'T2', status: 'done' }, { dir, sessionId: other }), /^Not changed: the status/);
  t2 = (await memory.taskList(dir)).find((t) => t.id === 'T2');
  assert.strictEqual(t2.status, 'review');
  assert.strictEqual(t2.assigneeId, dev);
  assert.strictEqual(t2.notes.filter((n) => !n.kind).length, 2); // two comments
  // and what happened to it is written down beside them
  assert.deepStrictEqual(
    t2.notes.filter((n) => n.kind).map((n) => `${n.kind}: ${n.text}`),
    ['assign: gave it to Dev one', 'status: moved it from todo to review'],
  );
  // the manager closes it
  assert.match(await callTool('task_update', { id: 'T2', status: 'done' }, { dir, sessionId: pm }), /^Updated\.\nT2 \[done\]/);
  // everyone can read the board
  assert.match(await callTool('task_list', { status: 'all' }, { dir, sessionId: other }), /T2 \[done\] Build login/);
});

test('a role is briefed on how it works and who is next', async () => {
  const cto = '44444444-4444-4444-8444-444444444444';
  const roles = [
    { key: 'cto', title: 'CTO', duty: 'Owns the architecture.', guide: 'Decide the approach, then hand the plan on.', next: ['pm'] },
    { key: 'pm', title: 'Project manager', duty: 'Maintains the board.', guide: 'Break it into tickets.', next: ['dev', 'qa'], manages: true },
    { key: 'dev', title: 'Developer', duty: 'Builds.', guide: 'Build the ticket.', next: ['qa', 'pm'] },
    { key: 'seo', title: 'SEO specialist', duty: 'Search.', guide: '', next: [] },
  ];
  memory.setTeamLookup(() => ({ roles, members: { [cto]: 'cto', [pm]: 'pm', [dev]: 'dev' } }));
  memory.setProfileLookup((id) => ({ role: '', name: id === pm ? 'Planner' : '' }));

  const brief = await callTool('role_brief', {}, { dir, sessionId: cto });
  assert.match(brief, /^You are the CTO/);
  assert.match(brief, /How you work: Decide the approach/);
  assert.match(brief, /Who does the work:[^]*- Project manager: "Planner" \(not running\)/);
  assert.match(brief, /Report to the user in the company's report format/); // a front door reports to the user
  assert.match(brief, /Board: the project manager maintains it/);
  assert.match(brief, /The team:[^]*- SEO specialist: nobody yet/);

  // QA is not on the team; nothing is relayed to someone else instead: the
  // developer hands work to the manager it names, and replies to whoever gave it the ticket
  const devBrief = await callTool('role_brief', {}, { dir, sessionId: dev });
  assert.match(devBrief, /Who does the work:[^]*- Project manager: "Planner"/);
  assert.match(devBrief, /reply to whoever gave it to you: 3 lines or fewer/);
  assert.doesNotMatch(devBrief.split('The team:')[0], /QA/);
  assert.match(await callTool('role_brief', {}, { dir, sessionId: pm }), /Board: you maintain it[^]*- Developer: /);
  assert.match(await callTool('role_brief', {}, { dir, sessionId: other }), /^You have no team role/);
  assert.match(await callTool('team_list', {}, { dir, sessionId: cto }), /This project's team, by role:\n- CTO: /);
});

test('team_info reads the team from Loop as it is now', async () => {
  const cto = '44444444-4444-4444-8444-444444444444';
  const roles = [
    { key: 'cto', title: 'CTO', duty: 'Owns the architecture.', guide: 'Decide the approach.', next: ['pm'] },
    { key: 'pm', title: 'Project manager', duty: 'Maintains the board.', guide: '', next: [], manages: true },
  ];
  let team = { roles, members: { [cto]: 'cto', [pm]: 'pm' } };
  memory.setTeamLookup(() => team);
  memory.setProfileLookup((id) => ({ role: '', name: id === pm ? 'Planner' : 'Tech lead' }));

  const info = await callTool('team_info', {}, { dir, sessionId: cto });
  assert.match(info, /You are the CTO\./);
  assert.match(info, /- CTO: "Tech lead" \(not running\)\n- Project manager: "Planner"/);
  assert.doesNotMatch(info, /Decide the approach/); // the short form carries no playbooks
  assert.ok(info.length < 600, `team_info is read on every decision: keep it short (${info.length})`);
  assert.match(
    await callTool('team_info', { role: 'cto' }, { dir, sessionId: pm }),
    /^CTO, held by: "Tech lead" \(not running\)\nResponsible for: Owns the architecture\.\nHow it works: Decide the approach\.\nHands work to: Project manager$/,
  );
  assert.match(await callTool('team_info', { role: 'chef' }, { dir, sessionId: pm }), /^No role called "chef"/);
  assert.match(await callTool('team_info', {}, { dir, sessionId: other }), /you are an external member/);

  // the user takes the CTO role away: the very next call shows it, nothing is cached
  team = { roles, members: { [pm]: 'pm' } };
  assert.match(await callTool('team_info', {}, { dir, sessionId: pm }), /- CTO: nobody yet/);

  // what a member is told at start holds no copy of the team, only which tool has it
  const brief = memory.startBrief(dir, pm);
  assert.match(brief, /team_info/);
  // It names nobody: the roles appear only as the chain the rules describe.
  assert.doesNotMatch(brief, /Planner|Tech lead/);
  assert.strictEqual(memory.startBrief(dir, other), '');

  team = null;
  assert.match(await callTool('team_info', {}, { dir, sessionId: pm }), /no team set up/);
});

// ---------- who may change a team ----------
// teamCommand lives in the renderer, which has no module system: take the
// function out and give it the handful of globals it reaches for.
function teamRunner(config) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'board.js'), 'utf8');
  const from = src.indexOf('async function teamCommand(q) {');
  const body = src.slice(from, src.indexOf('\n}\n', from) + 2);
  const sessions = [
    { id: pm, title: 'Planner' },
    { id: dev, title: 'Dev one' },
  ];
  const S = { config, live: new Map(), order: [] };
  const sent = [];
  const told = [];
  teamRunner.sent = sent;
  teamRunner.told = told;
  teamRunner.room = { yes: false }; // whether a terminal can be opened here
  const scope = {
    S,
    projectByDir: () => ({ dir, sessions, exists: true, path: 'C:/board-test', server: '' }),
    roleOf: (d, id) => {
      const t = (config.projectTeam || {})[d];
      const key = t && t.members[id];
      return key ? (config.roles || []).find((r) => r.key === key) : null;
    },
    roleLib: () => config.roles || [],
    sessionTitle: (s) => s.title,
    setMemberRole: async (p, s, key) => {
      const t = config.projectTeam[p.dir];
      if (key) t.members[s.id] = key;
      else delete t.members[s.id];
    },
    cleanRole: (r) => r,
    refreshRoleTexts: () => {},
    save: () => {},
    renderList: () => {},
    tabFor: () => null,
    mailLog: (p, e) => (teamRunner.mail = e),
    mailCommand: async () => 'mailbox',
    tellWhenIdle: (id, text) => told.push({ id, text }),
    // Work handed over goes in as a message to the session itself.
    sayTo: async (p, s, text) => (sent.push({ dir: p.dir, sessionId: s.id, text }), { ok: true }),
    nudge: async (p, s, text) => (told.push({ id: s.id, text }), true),
    tellMembers: async (p, text) => {
      const t = (config.projectTeam || {})[p.dir] || { members: {} };
      let n = 0;
      for (const s of p.sessions) if (t.members[s.id]) (told.push({ id: s.id, text }), n++);
      return n;
    },
    RULES_CHANGED: 'rules changed',
    openMember: () => true,
    openHere: () => teamRunner.room.yes,
    startMember: () => true,
    phoneSend: async (_c, req) => (sent.push(req), { ok: true }),
    createTab: () => {},
    closeTab: () => {},
    renderTabs: () => {},
  };
  const keys = Object.keys(scope);
  return new Function(...keys, body + '; return teamCommand;')(...keys.map((k) => scope[k]));
}

test('the user runs the team from the phone, a session only if it manages', async () => {
  const config = {
    roles: [
      { key: 'pm', title: 'Project manager', duty: 'Runs the work.', manages: true },
      { key: 'dev', title: 'Developer', duty: 'Builds it.' },
    ],
    projectTeam: {},
    sessionAlias: {},
  };
  const run = teamRunner(config);

  // The first role starts the team: anyone may do that.
  assert.match(await run({ dir, me: dev, action: 'add_role', role: 'Developer' }), /Developer is on the team/);

  // Now the team exists, a plain session is refused…
  assert.match(await run({ dir, me: dev, action: 'assign', session: 'Dev one', role: 'Developer' }), /^Only the CEO and the CTO/);
  // …and so was the phone before this fix, because it holds no role at all.
  assert.match(await run({ dir, user: true, me: '', action: 'assign', session: 'Dev one', role: 'Developer' }), /"Dev one" is now Developer/);
  assert.strictEqual(config.projectTeam[dir].members[dev], 'dev');

  // The manager runs it too, and the phone can add and drop roles after that.
  await run({ dir, user: true, me: '', action: 'assign', session: 'Planner', role: 'Project manager' });
  assert.match(await run({ dir, me: pm, action: 'add_role', role: 'Designer' }), /Designer is on the team/);
  assert.match(await run({ dir, user: true, me: '', action: 'drop_role', role: 'Designer' }), /Designer/);
  assert.match(await run({ dir, user: true, me: '', action: 'unassign', session: 'Dev one' }), /no role now/);
});

test('a teammate is woken by the work itself, not found with ListAgents', async () => {
  const config = {
    roles: [
      { key: 'ceo', title: 'CEO', duty: 'Sets the goal.' },
      { key: 'dev', title: 'Developer', duty: 'Builds it.' },
    ],
    projectTeam: { [dir]: { roles: [{ key: 'ceo', title: 'CEO' }, { key: 'dev', title: 'Developer' }], members: { [pm]: 'ceo', [dev]: 'dev' } } },
    sessionAlias: {},
  };
  const run = teamRunner(config);
  const sent = teamRunner.sent;

  // The CEO hands work over by name, whether or not the developer is running.
  assert.match(await run({ dir, me: pm, action: 'tell', session: 'Dev one', text: 'Build the login page, ticket T4.' }), /Sent to "Dev one"/);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].sessionId, dev);
  assert.match(sent[0].text, /^Session message from "Planner": Build the login page/);
  // and is told how to answer, so the reply reaches the sender instead of staying in its own chat
  assert.match(sent[0].text, /reply to Planner with team_manage \(action tell, session "Planner"/);
  assert.match(sent[0].text, /If it is a reply, an acknowledgement or thanks: do not answer it\./);

  // The things that go wrong are said plainly, not silently dropped.
  assert.match(await run({ dir, me: pm, action: 'tell', session: 'Dev one' }), /Say what the teammate should do/);
  assert.match(await run({ dir, me: pm, action: 'tell', session: 'Nobody', text: 'hi' }), /No other session called "Nobody"/);
  assert.match(await run({ dir, me: 'ff', action: 'tell', session: 'Dev one', text: 'hi' }), /Only team members/);
});

test('work handed to a teammate goes in as a message, never as keystrokes', async () => {
  const config = {
    roles: [
      { key: 'ceo', title: 'CEO', duty: 'Sets the goal.' },
      { key: 'dev', title: 'Developer', duty: 'Builds it.' },
    ],
    projectTeam: { [dir]: { roles: [{ key: 'ceo', title: 'CEO' }, { key: 'dev', title: 'Developer' }], members: { [pm]: 'ceo', [dev]: 'dev' } } },
    sessionAlias: {},
  };
  const run = teamRunner(config);
  teamRunner.room.yes = true; // there is room for a terminal, which no longer matters

  const text = await run({ dir, me: pm, action: 'tell', session: 'Dev one', text: 'Build the login page.' });
  assert.match(text, /Sent to "Dev one" as a message/);
  assert.strictEqual(teamRunner.told.length, 0); // nothing was typed anywhere
  assert.strictEqual(teamRunner.sent.length, 1);
  assert.strictEqual(teamRunner.sent[0].sessionId, dev);

  // And the same with every terminal taken: one path, whatever the window holds.
  teamRunner.room.yes = false;
  assert.match(await run({ dir, me: pm, action: 'tell', session: 'Dev one', text: 'And the signup page.' }), /Sent to "Dev one"/);
  assert.strictEqual(teamRunner.sent.length, 2);
});

// ---------- the board as a queue ----------

test('a column is a queue: new tickets go to the bottom, and the top is what is taken', async () => {
  memory.setTeamLookup(() => null);
  const q = 'C--queue-test';
  const a = await memory.taskAdd(q, { title: 'First in' });
  const b = await memory.taskAdd(q, { title: 'Second in' });
  assert.ok(a.rank < b.rank, 'the second one sits under the first');
  assert.deepStrictEqual((await memory.taskList(q)).map((t) => t.title), ['First in', 'Second in']);

  // The manager can pull one to the top.
  await memory.taskUpdate(q, b.id, { rank: 'top' }, 'you');
  assert.deepStrictEqual((await memory.taskList(q)).map((t) => t.title), ['Second in', 'First in']);

  // Taking one gives the top of the column, and says so on the ticket.
  const said = await callTool('task_take', {}, { dir: q, sessionId: dev });
  assert.match(said, /^Taken\.\nT2 \[doing\] Second in/);
  const after = await memory.taskList(q);
  assert.strictEqual(after.find((t) => t.id === 'T2').status, 'doing');
  // ...and the next free one is now the other.
  assert.match(await callTool('task_take', {}, { dir: q, sessionId: other }), /T1 \[doing\] First in/);
});

test('a ticket that would clash is raised, not quietly skipped', async () => {
  memory.setTeamLookup(() => null);
  const q = 'C--clash-test';
  await memory.taskAdd(q, { title: 'Rewrite the API' });
  await memory.taskAdd(q, { title: 'Something else' });
  const said = await callTool('task_take', { instead: 'Dev one is already rewriting that file' }, { dir: q, sessionId: dev });

  // The ticket is untouched, the reason is on it, and the next one is not taken.
  assert.match(said, /Left T1 where it is/);
  assert.match(said, /team_manage \(action tell\)/);
  const [one, two] = await memory.taskList(q);
  assert.strictEqual(one.status, 'todo');
  assert.strictEqual(two.status, 'todo');
  assert.match(one.notes[one.notes.length - 1].text, /^Did not take this: Dev one is already rewriting/);
});

test('progress is the holder\'s own, and finishing means finished', async () => {
  memory.setTeamLookup(() => null);
  const q = 'C--progress-test';
  const t = await memory.taskAdd(q, { title: 'Build it' });
  assert.strictEqual(t.progress, 0);
  await memory.taskUpdate(q, t.id, { status: 'doing' }, 'Dev one');
  // Starting is not progress: nothing is claimed until someone says so.
  assert.strictEqual((await memory.taskList(q))[0].progress, 0);

  assert.match(await callTool('task_update', { id: t.id, progress: 40 }, { dir: q, sessionId: dev }), /40% done/);
  const mid = (await memory.taskList(q))[0];
  assert.strictEqual(mid.progress, 40);
  assert.match(mid.notes.find((n) => n.kind === 'progress').text, /moved it to 40% done/);

  // Out-of-range numbers are brought back in, and done is done.
  await memory.taskUpdate(q, t.id, { progress: 999 }, 'Dev one');
  assert.strictEqual((await memory.taskList(q))[0].progress, 100);
  await memory.taskUpdate(q, t.id, { status: 'done' }, 'Dev one');
  assert.strictEqual((await memory.taskList(q))[0].progress, 100);
});

test('the rules and the team policy reach every member', async () => {
  const team = { roles: [{ key: 'dev', title: 'Developer', duty: 'Builds it.' }], members: { [dev]: 'dev' }, policy: 'Never deploy on a Friday.' };
  memory.setTeamLookup(() => team);
  const brief = await callTool('role_brief', {}, { dir, sessionId: dev });
  assert.match(brief, /Take work with task_take/);
  assert.match(brief, /do not skip it quietly/);
  assert.match(brief, /Never deploy on a Friday\./);
  // And in what a session is told before it has called anything.
  const start = memory.startBrief(dir, dev);
  assert.match(start, /task_take/);
  assert.match(start, /Never deploy on a Friday\./);
});

// ---------- the rules, which are the CEO's ----------

test('only the CEO writes the rules, and the user over the CEO', async () => {
  const config = {
    roles: [
      { key: 'ceo', title: 'CEO', duty: 'Sets the goal.' },
      { key: 'pm', title: 'Project manager', duty: 'Runs the board.', manages: true },
      { key: 'dev', title: 'Developer', duty: 'Builds it.' },
    ],
    projectTeam: { [dir]: { roles: [{ key: 'ceo', title: 'CEO' }, { key: 'dev', title: 'Developer' }], members: { [pm]: 'ceo', [dev]: 'dev' } } },
    sessionAlias: {},
    company: {},
  };
  const run = teamRunner(config);

  // A member is sent to the CEO rather than being allowed to rewrite them.
  assert.match(await run({ dir, me: dev, action: 'rules', scope: 'company', text: 'No code reviews.' }), /^The rules are the CEO/);
  assert.strictEqual((config.company || {}).rules, undefined);

  // The CEO writes the company's, which hold for every team on the machine.
  assert.match(await run({ dir, me: pm, action: 'rules', scope: 'company', text: 'Ship on Tuesdays.' }), /company rules/);
  assert.strictEqual(config.company.rules, 'Ship on Tuesdays.');
  // Everyone running was told to read them again.
  assert.ok(teamRunner.told.some((t) => t.id === dev));

  // This project only, and one member only.
  assert.match(await run({ dir, me: pm, action: 'rules', text: 'Never touch production.' }), /this project's rules/);
  assert.strictEqual(config.projectTeam[dir].policy, 'Never touch production.');
  assert.match(await run({ dir, me: pm, action: 'rules', scope: 'member', session: 'Dev one', text: 'Ask before new dependencies.' }), /for "Dev one" alone/);
  assert.strictEqual(config.projectTeam[dir].memberRules[dev], 'Ask before new dependencies.');

  // The user, asking from the app, is never refused; empty text clears.
  assert.match(await run({ dir, user: true, me: '', action: 'rules', scope: 'company', text: '' }), /back to the rules Loop ships with/);
  assert.strictEqual(config.company.rules, '');
  assert.match(await run({ dir, user: true, me: '', action: 'rules', scope: 'member', session: 'Dev one', text: '' }), /Cleared/);
  assert.strictEqual(config.projectTeam[dir].memberRules[dev], undefined);
});

// ---------- the check-in clock ----------
// The rules say nobody goes quiet and the CEO chases an update when none has
// come. checkIns is that clock, taken out of the renderer like teamCommand.
function checkRunner({ tasks, config, projects }) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'board.js'), 'utf8');
  const cut = (name) => {
    let from = src.indexOf(`function ${name}(`);
    if (src.slice(from - 6, from) === 'async ') from -= 6;
    return src.slice(from, src.indexOf('\n}\n', from) + 2);
  };
  const sent = [];
  const scope = {
    S: { config, projects, live: new Map() },
    deck: { taskList: async () => tasks },
    teamOf: (d) => (config.projectTeam || {})[d] || null,
    roleDef: (key) => (config.roles || []).find((r) => r.key === key) || null,
    sessionTitle: (s) => s.title,
    sayTo: async (p, s, text) => sent.push({ id: s.id, text }),
    lastPing: new Map(),
    GIVE_UP: 3,
  };
  const keys = Object.keys(scope);
  const fn = new Function(...keys, [cut('checkEvery'), cut('checkIns'), 'return checkIns;'].join('\n'))(...keys.map((k) => scope[k]));
  return { checkIns: fn, sent, lastPing: scope.lastPing };
}

test('the CEO is asked to chase an update, once the team has been quiet', async () => {
  const config = {
    roles: [
      { key: 'ceo', title: 'CEO' },
      { key: 'pm', title: 'Project manager', manages: true },
    ],
    projectTeam: { [dir]: { roles: [{ key: 'ceo', title: 'CEO' }, { key: 'pm', title: 'Project manager', manages: true }], members: { [pm]: 'pm', [other]: 'ceo' } } },
    company: { checkMins: 30 }, // the clock is off unless set
  };
  const projects = [
    {
      dir,
      exists: true,
      server: '',
      sessions: [
        { id: other, title: 'Chief' },
        { id: pm, title: 'Planner' },
      ],
    },
  ];
  const long = Date.now() - 40 * 60 * 1000;

  // Quiet for forty minutes with a ticket in hand: the CEO hears about it.
  let r = checkRunner({ config, projects, tasks: [{ id: 'T1', status: 'doing', updated: long }] });
  await r.checkIns();
  assert.strictEqual(r.sent.length, 1);
  assert.strictEqual(r.sent[0].id, other); // the CEO, not the manager
  assert.match(r.sent[0].text, /Nothing has moved on the board for 30 minutes/);
  assert.match(r.sent[0].text, /"Planner"/); // who to ask
  // It does not ask twice for the same silence, and gives up after three.
  await r.checkIns();
  assert.strictEqual(r.sent.length, 1);
  for (let i = 0; i < 6; i++) {
    // time passes with nothing moving: the last ping is older than the limit again
    r.lastPing.set(dir, { at: long + 1000, tries: r.lastPing.get(dir).tries });
    await r.checkIns();
  }
  assert.strictEqual(r.sent.length, 3, 'a board nobody moves is chased three times, not forever');

  // Nothing in hand: nobody owes anyone a word.
  r = checkRunner({ config, projects, tasks: [{ id: 'T1', status: 'todo', updated: long }] });
  await r.checkIns();
  assert.strictEqual(r.sent.length, 0);

  // Moved a minute ago: the clock has not run out.
  r = checkRunner({ config, projects, tasks: [{ id: 'T1', status: 'doing', updated: Date.now() - 60 * 1000 }] });
  await r.checkIns();
  assert.strictEqual(r.sent.length, 0);

  // Turned off for this project.
  config.projectTeam[dir].checkMins = 0;
  r = checkRunner({ config, projects, tasks: [{ id: 'T1', status: 'doing', updated: long }] });
  await r.checkIns();
  assert.strictEqual(r.sent.length, 0);

  // A project of its own length: ten minutes of quiet is already too long.
  config.projectTeam[dir].checkMins = 10;
  r = checkRunner({ config, projects, tasks: [{ id: 'T1', status: 'review', updated: Date.now() - 12 * 60 * 1000 }] });
  await r.checkIns();
  assert.match(r.sent[0].text, /quiet|for 10 minutes/);
});
