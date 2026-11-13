const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const agents = require('../src/main/agents');

test('each agent starts, continues and signs in with fixed commands', () => {
  assert.strictEqual(agents.command({ kind: 'agent', agent: 'codex' }), 'codex');
  assert.strictEqual(agents.command({ kind: 'agent', agent: 'codex', cont: true }), 'codex resume --last');
  assert.strictEqual(agents.command({ kind: 'agent', agent: 'codex', native: '0199a1b2-1111-2222-3333-444455556666' }), 'codex resume 0199a1b2-1111-2222-3333-444455556666');
  assert.strictEqual(agents.command({ kind: 'agent', agent: 'grok', cont: true }), 'grok -c');
  assert.strictEqual(agents.command({ kind: 'agent', agent: 'antigravity', native: 'abc123' }), 'agy --conversation abc123');
  assert.strictEqual(agents.command({ kind: 'agent', agent: 'kimi', native: 'session_22b5b891-839e' }), 'kimi -S session_22b5b891-839e');
  assert.strictEqual(agents.command({ kind: 'agentLogin', agent: 'codex' }), 'codex login');
  assert.match(agents.command({ kind: 'agentInstall', agent: 'grok' }), /x\.ai\/cli\/install\.ps1/);
});

test('nothing from the window reaches the command line', () => {
  assert.throws(() => agents.command({ kind: 'agent', agent: 'codex', native: 'x & del /q *' }), /not valid/);
  assert.throws(() => agents.command({ kind: 'agent', agent: 'calc' }), /does not know/);
  assert.throws(() => agents.command({ kind: 'agent', agent: '__proto__' }), /does not know/);
  assert.throws(() => agents.command({ kind: 'agentInstall', agent: 'kimi' }), /own website/);
});

test('Codex sign-in is told apart: plan, API key, or none, and the key never comes back', () => {
  assert.deepStrictEqual(agents.codexLogin('Logged in using ChatGPT'), { signedIn: true, how: 'ChatGPT plan' });
  const key = agents.codexLogin('Logged in using an API key - sk-abc***xyz');
  assert.strictEqual(key.apiKey, true);
  assert.ok(!JSON.stringify(key).includes('sk-'));
  assert.deepStrictEqual(agents.codexLogin('Not logged in'), { signedIn: false });
});

test("a new conversation's id is found in the agent's own records, for the right folder only", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-agents-'));
  const since = Date.now() - 1000;
  const day = path.join(home, '.codex', 'sessions', '2026', '11', '11');
  fs.mkdirSync(day, { recursive: true });
  const meta = (id, cwd) => JSON.stringify({ type: 'session_meta', payload: { id, cwd, timestamp: new Date().toISOString() } }) + '\n';
  fs.writeFileSync(path.join(day, 'rollout-a.jsonl'), meta('11111111-aaaa-bbbb-cccc-000000000001', 'D:\\Other'));
  fs.writeFileSync(path.join(day, 'rollout-b.jsonl'), meta('11111111-aaaa-bbbb-cccc-000000000002', 'D:\\Work\\app'));
  assert.strictEqual(agents.findNative('codex', 'd:\\work\\app', since, home), '11111111-aaaa-bbbb-cccc-000000000002');
  assert.strictEqual(agents.findNative('codex', 'D:\\Nowhere', since, home), '');

  const sdir = path.join(home, '.kimi-code', 'sessions', 'wd', 'session_k1');
  fs.mkdirSync(sdir, { recursive: true });
  fs.writeFileSync(path.join(home, '.kimi-code', 'session_index.jsonl'), JSON.stringify({ sessionId: 'session_k1', sessionDir: sdir, workDir: 'D:/Work/app' }) + '\n');
  assert.strictEqual(agents.findNative('kimi', 'D:\\Work\\app', since, home), 'session_k1');
  assert.strictEqual(agents.findNative('grok', 'D:\\Work\\app', since, home), '');
  fs.rmSync(home, { recursive: true, force: true });
});

test('an added account links the shared folders, and removing it leaves them alone', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-agent-acct-'));
  const main = path.join(tmp, 'main-codex');
  fs.mkdirSync(path.join(main, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(main, 'sessions', 'keep.jsonl'), 'conversation');
  fs.writeFileSync(path.join(main, 'config.toml'), 'model = "x"');
  const realHome = agents.AGENTS.codex.mainHome;
  agents.AGENTS.codex.mainHome = () => main;
  try {
    agents.init(path.join(tmp, 'userdata'));
    const env = agents.envFor('codex', 'work1');
    const dir = env.CODEX_HOME;
    assert.ok(fs.lstatSync(path.join(dir, 'sessions')).isSymbolicLink());
    assert.strictEqual(fs.readFileSync(path.join(dir, 'config.toml'), 'utf8'), 'model = "x"');
    assert.deepStrictEqual(agents.envFor('codex', 'default'), {});
    assert.throws(() => agents.envFor('kimi', 'work1'), /one login/);
    assert.throws(() => agents.envFor('codex', '../x'), /does not know/);
    agents.removeAccount('codex', 'work1');
    assert.ok(!fs.existsSync(dir));
    assert.strictEqual(fs.readFileSync(path.join(main, 'sessions', 'keep.jsonl'), 'utf8'), 'conversation');
  } finally {
    agents.AGENTS.codex.mainHome = realHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("the next agent is handed Codex's last turns, without Codex's own context blocks", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-agent-turns-'));
  const day = path.join(home, '.codex', 'sessions', '2026', '11', '12');
  fs.mkdirSync(day, { recursive: true });
  const id = '01a1ce4f-38b0-74c3-8238-cc8fc860dae6';
  const msg = (role, type, text) => JSON.stringify({ type: 'response_item', payload: { type: 'message', role, content: [{ type, text }] } });
  fs.writeFileSync(
    path.join(day, `rollout-2026-11-12T11-21-00-${id}.jsonl`),
    [
      JSON.stringify({ type: 'session_meta', payload: { id, cwd: 'D:\Work\app' } }),
      msg('developer', 'input_text', 'rules'),
      msg('user', 'input_text', '<environment_context>cwd</environment_context>'),
      msg('user', 'input_text', 'Add a login page'),
      msg('user', 'input_text', 'Add a login page'),
      msg('assistant', 'output_text', 'Added src/login.tsx.'),
      'not json',
    ].join('\n'),
  );
  try {
    assert.deepStrictEqual(agents.turns('codex', id, home), [
      { role: 'user', text: 'Add a login page' },
      { role: 'assistant', text: 'Added src/login.tsx.' },
    ]);
    assert.deepStrictEqual(agents.turns('codex', 'missing-id', home), []);
    assert.deepStrictEqual(agents.turns('kimi', id, home), []);
    assert.deepStrictEqual(agents.turns('codex', '../x', home), []);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the model a Codex conversation last ran on is read from its file', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-agent-model-'));
  const day = path.join(home, '.codex', 'sessions', '2026', '11', '12');
  fs.mkdirSync(day, { recursive: true });
  const id = '01a1ce57-0a81-70b1-bea4-7fcc492e0494';
  const ctx = (model) => JSON.stringify({ type: 'turn_context', payload: { cwd: 'D:\Work\app', model } });
  const file = path.join(day, `rollout-2026-11-12T11-29-33-${id}.jsonl`);
  fs.writeFileSync(file, [JSON.stringify({ type: 'session_meta', payload: { id } }), ctx('gpt-5.5'), ctx('gpt-5.6-terra')].join('\n') + '\n');
  try {
    assert.strictEqual(agents.modelOf('codex', id, home), 'gpt-5.6-terra');
    fs.appendFileSync(file, ctx('gpt-5.6-luna') + '\n');
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
    assert.strictEqual(agents.modelOf('codex', id, home), 'gpt-5.6-luna', 'a changed file is read again');
    assert.strictEqual(agents.modelOf('codex', 'missing', home), '');
    assert.strictEqual(agents.modelOf('kimi', id, home), '');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
