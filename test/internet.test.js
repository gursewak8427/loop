// "Accessible on the internet": a browser gets in only with a ticket the cloud
// vouches for, then with the key it was given; turning it off locks everyone out.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const internet = require('../src/main/internet');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-internet-'));
const redeemed = [];
const cloud = {
  state: () => ({ signedIn: true, email: 'me@example.com' }),
  setRemote: async () => ({ ok: true }),
  testRemote: async () => ({ ok: true }),
  redeemTicket: async (t) => {
    redeemed.push(t);
    if (t.startsWith('bad')) throw new Error('That link has expired or was already used.');
    return { ok: true, viewer: 'Chrome on Android' };
  },
};
let blockers = 0;
const powerSaveBlocker = { start: () => ++blockers, stop: () => {}, isStarted: (id) => id === blockers };
let phone = null;

test.before(() => internet.init(tmp, { cloud, shell: { openExternal: () => {} }, powerSaveBlocker, phonePort: () => 8787, phoneOn: () => (phone = internet.isOn()), onChange: () => {} }));
test.after(() => {
  internet.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const T = 'a'.repeat(48);

test('while off, a ticket opens nothing', async () => {
  const r = await internet.openTicket(T);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(redeemed.length, 0, 'the cloud is not even asked');
});

test('on: the bridge runs, the PC is kept awake, and a good ticket becomes a key', async () => {
  await internet.setOn(true);
  assert.strictEqual(phone, true);
  assert.ok(blockers > 0);
  const r = await internet.openTicket(T);
  assert.strictEqual(r.ok, true);
  assert.match(r.key, /^[a-f0-9]{64}$/);
  assert.strictEqual(internet.visitorOk(r.key), true);
  assert.strictEqual(internet.visitorOk(r.key.toUpperCase()), true, 'the app sends codes lowercased; either way works');
  assert.strictEqual(internet.visitorOk('f'.repeat(64)), false);
  assert.ok(!fs.readFileSync(path.join(tmp, 'internet-keys.json'), 'utf8').includes(r.key), 'only a hash of the key is kept');
});

test('a malformed or refused ticket gives nothing', async () => {
  assert.strictEqual((await internet.openTicket('not-a-ticket')).ok, false);
  const r = await internet.openTicket('bad' + 'a'.repeat(45));
  assert.strictEqual(r.ok, false);
  assert.match(r.why, /expired/);
});

test('turning it off locks every browser out and stops the bridge', async () => {
  const r = await internet.openTicket('b'.repeat(48));
  await internet.setOn(false);
  assert.strictEqual(phone, false);
  assert.strictEqual(internet.visitorOk(r.key), false);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(tmp, 'internet-keys.json'), 'utf8')), {});
});
