const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeDemo, DEMO } = require('../scripts/demo');

// The scanner reads where Claude Code's data is when it is loaded, so the demo is written first.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-demo-test-'));
const { claudeDir, userData } = writeDemo(dir);
process.env.CLAUDE_CONFIG_DIR = claudeDir;
const { scanProjects, peek, UUID_RE } = require('../src/main/scanner');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('Loop finds every demo project, in its own folder, newest first', async () => {
  const projects = await scanProjects();
  const names = DEMO.flatMap((w) => w.projects.map((p) => p.name));
  assert.deepStrictEqual(projects.map((p) => p.name).sort(), names.sort());
  assert.ok(projects.every((p) => p.exists && p.path.startsWith(dir)));
  assert.strictEqual(projects[0].name, 'acme-shop');
  const shop = projects.find((p) => p.name === 'acme-shop');
  assert.deepStrictEqual(
    shop.sessions.map((s) => s.title),
    DEMO[0].projects[0].sessions.map((s) => s.title),
  );
  assert.ok(shop.sessions.every((s) => UUID_RE.test(s.id) && !s.empty));
});

test('a demo session reads like a real one', async () => {
  const shop = (await scanProjects()).find((p) => p.name === 'acme-shop');
  const turns = await peek(shop.dir, shop.sessions[0].id);
  assert.strictEqual(turns[0].role, 'user');
  assert.match(turns[0].text, /Big carts time out/);
  assert.match(turns[turns.length - 1].text, /^Done: /);
});

test('the demo has its own settings, with workspaces and a stand-in for Claude Code', () => {
  const config = JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8'));
  assert.deepStrictEqual(
    config.workspaces.map((w) => w.name),
    DEMO.map((w) => w.workspace),
  );
  assert.strictEqual(config.settings.claudeCmd, 'claude-demo');
  const shim = fs.readdirSync(path.join(dir, 'bin'));
  assert.deepStrictEqual(shim, [process.platform === 'win32' ? 'claude-demo.cmd' : 'claude-demo']);
});
