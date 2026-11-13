// Which model a session last ran on, shown when its row is pointed at.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Claude Code's folder is read when the scanner loads, so it is set first.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-session-model-'));
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
const { scanProjects } = require('../src/main/scanner');

const DIR = 'D--work-shop';
const line = (o) => JSON.stringify(o);
const user = (text) => line({ type: 'user', cwd: 'D:\\work\\shop', message: { role: 'user', content: text } });
const reply = (model) => line({ type: 'assistant', cwd: 'D:\\work\\shop', message: { id: 'm', type: 'message', role: 'assistant', model, content: [{ type: 'text', text: 'ok' }] } });

test.before(() => {
  const folder = path.join(tmp, 'claude', 'projects', DIR);
  fs.mkdirSync(folder, { recursive: true });
  // Switched model halfway: the newest reply counts, and Claude Code's own notices do not.
  fs.writeFileSync(path.join(folder, '11111111-2222-4333-8444-555555555555.jsonl'), [user('hi'), reply('claude-sonnet-5-5'), user('again'), reply('claude-opus-5-5'), reply('<synthetic>')].join('\n') + '\n');
  // A long session ending in 600 KB of bookkeeping lines: the reply is further back.
  const filler = Array.from({ length: 3000 }, () => line({ type: 'system', subtype: 'bridge_status', content: 'x'.repeat(200) }));
  fs.writeFileSync(path.join(folder, '33333333-2222-4333-8444-555555555555.jsonl'), [user('long'), reply('claude-fable-5-2'), ...filler].join('\n') + '\n');
  // Asked, never answered.
  fs.writeFileSync(path.join(folder, '22222222-2222-4333-8444-555555555555.jsonl'), user('hello') + '\n');
});
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('a session carries the model of its newest real reply, or none before the first', async () => {
  const p = (await scanProjects()).find((x) => x.dir === DIR || x.name === DIR || (x.sessions || []).length);
  const byId = Object.fromEntries(p.sessions.map((s) => [s.id.slice(0, 8), s.model]));
  assert.strictEqual(byId['11111111'], 'claude-opus-5-5');
  assert.strictEqual(byId['22222222'], '');
  assert.strictEqual(byId['33333333'], 'claude-fable-5-2');
});

test('model ids read the way people say them', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
  const body = /function modelName\(id\) \{[\s\S]*?\n\}\n/.exec(src)[0];
  const modelName = new Function(`${body}; return modelName;`)();
  assert.strictEqual(modelName('claude-opus-5-5'), 'Opus 5.5');
  assert.strictEqual(modelName('claude-opus-5'), 'Opus 5');
  assert.strictEqual(modelName('claude-haiku-4-5-20251001'), 'Haiku 4.5');
  assert.strictEqual(modelName('claude-opus-4-20250514'), 'Opus 4');
  assert.strictEqual(modelName('claude-3-5-sonnet-20241022'), 'Sonnet 3.5');
  assert.strictEqual(modelName('gemma4:31b'), 'gemma4:31b');
  assert.strictEqual(modelName(''), '');
});
