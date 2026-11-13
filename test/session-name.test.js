// One name per session: Loop writes it into the conversation the way Claude
// Code does, and a resumed session is started with it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const transcript = require('../src/main/transcript');
const chat = require('../src/main/chat');
const ptys = require('../src/main/ptys');

const ID = '11111111-2222-4333-8444-555555555555';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-name-'));
const file = path.join(tmp, `${ID}.jsonl`);
const realFile = transcript.localFile;
transcript.localFile = () => file;
test.after(() => {
  transcript.localFile = realFile;
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('a rename is written as Claude Code writes it, and the newest name wins', async () => {
  fs.writeFileSync(file, `${JSON.stringify({ type: 'custom-title', customTitle: 'Old name', sessionId: ID })}\n`);
  assert.strictEqual(await chat.rename('proj', ID, '  New\nname  '), true);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepStrictEqual(lines.slice(-2), [
    { type: 'custom-title', customTitle: 'New name', sessionId: ID },
    { type: 'agent-name', agentName: 'New name', sessionId: ID },
  ]);
  const raw = fs.readFileSync(file, 'utf8').split('\n');
  assert.ok(raw[raw.length - 3].startsWith('{"type":"custom-title"'), 'the scanner reads lines that start this way');
});

test('a rename needs a real session and a name, and never creates a file', async () => {
  assert.strictEqual(await chat.rename('proj', 'not-an-id', 'Name'), false);
  assert.strictEqual(await chat.rename('proj', ID, '   '), false);
  fs.rmSync(file);
  await assert.rejects(chat.rename('proj', ID, 'Name'));
  assert.ok(!fs.existsSync(file));
});

test('a resumed session starts with its name, so Remote Control uses it', () => {
  const cmd = ptys.buildCommand({ kind: 'resume', sessionId: ID, name: 'Loop "Dev" & co' }, {});
  assert.match(cmd, new RegExp(`--resume ${ID} -n "Loop Dev  co"`));
  assert.doesNotMatch(ptys.buildCommand({ kind: 'resume', sessionId: ID }, {}), / -n /);
});
