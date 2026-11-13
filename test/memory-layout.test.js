const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-mem-layout-'));
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
const memory = require('../src/main/memory');

const root = path.join(tmp, 'mem');
const DIR = 'D--Freelance-projects-Venli';
const CTO = '7f3a2c11-1111-4111-8111-111111111111';
const names = { [CTO]: 'CTO' };
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

test.before(async () => {
  // Memory as the first layout kept it.
  write(path.join(root, DIR, 'project', 'deploy-steps.md'), '---\ntitle: Deploy steps\n---\n\nPush, then pull on the server.\n');
  write(path.join(root, DIR, 'members', CTO, 'payment-decisions.md'), '---\ntitle: Payment decisions\n---\n\nUse Razorpay.\n');
  write(path.join(root, DIR, 'board.json'), '{"seq":1,"tasks":[]}');
  write(path.join(root, DIR, 'team.json'), '{"roles":[],"members":{}}');
  write(path.join(root, '_company', 'brand-voice.md'), '---\ntitle: Brand voice\n---\n\nPlain words.\n');
  memory.setProjectNamer(async () => 'Venli');
  memory.setSessionNamer((id) => names[id] || '');
  await memory.init(path.join(tmp, 'userdata'), root);
});
test.after(() => {
  memory.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('memory from the first layout moves into readable folders, with a backup', () => {
  const proj = path.join(root, 'projects', 'venli');
  assert.ok(fs.existsSync(path.join(proj, 'shared', 'deploy-steps.md')));
  assert.ok(fs.existsSync(path.join(proj, 'sessions', 'cto--7f3a2c', 'payment-decisions.md')));
  assert.ok(fs.existsSync(path.join(proj, 'board.json')));
  assert.ok(fs.existsSync(path.join(proj, 'team.json')));
  assert.ok(fs.existsSync(path.join(root, 'company', 'brand-voice.md')));
  assert.ok(!fs.existsSync(path.join(root, DIR)), 'the old folder is gone');
  assert.ok(!fs.existsSync(path.join(root, '_company')));
  const backup = fs.readdirSync(root).find((n) => n.startsWith('.backup-before-new-layout-'));
  assert.ok(backup && fs.existsSync(path.join(root, backup, DIR, 'members', CTO, 'payment-decisions.md')));
  // Each folder says what it is, so the layout can be rebuilt from the folders alone.
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(proj, '.loop-project'), 'utf8')).dir, DIR);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(proj, 'sessions', 'cto--7f3a2c', '.loop-session'), 'utf8')).id, CTO);
});

test('notes read from the new layout, with an index made for each folder', async () => {
  const all = await memory.listAll(DIR);
  const by = (scope) => all.filter((n) => n.scope === scope).map((n) => n.title);
  assert.deepStrictEqual(by('project'), ['Deploy steps']);
  assert.deepStrictEqual(by(CTO), ['Payment decisions']);
  assert.deepStrictEqual(by('company'), ['Brand voice']);
  assert.match(fs.readFileSync(path.join(root, 'projects', 'venli', 'sessions', 'cto--7f3a2c', 'loop.md'), 'utf8'), /\[Payment decisions\]\(payment-decisions\.md\)/);
});

test("a session's notes are the session's: saved in its folder, and its folder follows its name", async () => {
  await memory.saveNote({ dir: DIR, scope: CTO, title: 'Flow feature memory', body: 'Cart, then pay.' });
  const sessions = path.join(root, 'projects', 'venli', 'sessions');
  assert.ok(fs.existsSync(path.join(sessions, 'cto--7f3a2c', 'flow-feature-memory.md')));
  names[CTO] = 'Tech lead';
  await memory.saveNote({ dir: DIR, scope: CTO, title: 'Second', body: 'x' });
  assert.ok(fs.existsSync(path.join(sessions, 'tech-lead--7f3a2c', 'flow-feature-memory.md')), 'renamed with the session');
  assert.ok(!fs.existsSync(path.join(sessions, 'cto--7f3a2c')));
  await memory.listAll(DIR);
  const brief = memory.ownerBrief(DIR, CTO);
  assert.match(brief, /belongs to this session/);
  assert.match(brief, /Flow feature memory \(yours\)/);
});

test('the board lives in the project folder', async () => {
  await memory.taskAdd(DIR, { title: 'Ship it', by: CTO });
  const board = JSON.parse(fs.readFileSync(path.join(root, 'projects', 'venli', 'board.json'), 'utf8'));
  assert.ok(board.tasks.some((t) => t.title === 'Ship it'));
});
