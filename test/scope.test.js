// Loop's scope is terminal sessions. A session the Claude desktop app wrote to
// last (/desktop moves it there) is that app's; continued in a terminal, it is Loop's again.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-scope-'));
process.env.CLAUDE_CONFIG_DIR = home;
const { scanProjects, encodePath } = require('../src/main/scanner');

const folder = path.join(home, 'work');
fs.mkdirSync(folder);
const dir = path.join(home, 'projects', encodePath(folder));
fs.mkdirSync(dir, { recursive: true });
const line = (entrypoint, text) =>
  JSON.stringify({ type: 'user', entrypoint, cwd: folder, sessionId: 'x', message: { role: 'user', content: text } });
const write = (id, lines) => fs.writeFileSync(path.join(dir, `${id}.jsonl`), lines.join('\n') + '\n');

const TERM = '11111111-1111-4111-8111-111111111111';
const MOVED = '22222222-2222-4222-8222-222222222222';
const BACK = '33333333-3333-4333-8333-333333333333';
write(TERM, [line('cli', 'only in a terminal')]);
write(MOVED, [line('cli', 'started in a terminal'), line('claude-desktop', 'then /desktop')]);
write(BACK, [line('claude-desktop', 'started in the app'), line('cli', 'resumed in a terminal')]);

test.after(() => fs.rmSync(home, { recursive: true, force: true }));

test('a session goes with whoever wrote to it last', async () => {
  const p = (await scanProjects()).find((x) => x.dir === encodePath(folder));
  assert.ok(p, 'the project is found');
  const by = Object.fromEntries(p.sessions.map((s) => [s.id, s]));
  assert.strictEqual(by[TERM].inApp, false);
  assert.strictEqual(by[MOVED].inApp, true, 'moved to the Claude app with /desktop');
  assert.strictEqual(by[BACK].inApp, false, 'continued in a terminal, so it is back');
});
