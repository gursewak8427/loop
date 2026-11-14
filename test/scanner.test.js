const test = require('node:test');
const assert = require('node:assert');
const { encodePath, rootOf, UUID_RE, peek, ensureProjectDir } = require('../src/main/scanner');

test('encodePath matches how Claude Code names project folders', () => {
  assert.strictEqual(encodePath('D:\\Personal\\automation'), 'D--Personal-automation');
  assert.strictEqual(encodePath('D:\\Jobs\\Acme\\LMS\\lms_tech'), 'D--Jobs-Acme-LMS-lms-tech');
  assert.strictEqual(encodePath('D:\\'), 'D--');
});

test('a project folder is found from the root of its drive, or from / on macOS and Linux', () => {
  assert.deepStrictEqual(rootOf('D--Personal-automation', 'win32'), { root: 'D:\\', rest: 'Personal-automation' });
  assert.strictEqual(rootOf('-Users-acme-shop', 'win32'), null);
  assert.deepStrictEqual(rootOf('-Users-acme-shop', 'darwin'), { root: '/', rest: 'Users-acme-shop' });
  assert.deepStrictEqual(rootOf('-home-acme-shop', 'linux'), { root: '/', rest: 'home-acme-shop' });
  assert.strictEqual(rootOf('D--Personal', 'linux'), null);
  assert.strictEqual(encodePath('/Users/acme/my.shop'), '-Users-acme-my-shop');
});

test('UUID_RE accepts session ids and rejects anything else', () => {
  assert.ok(UUID_RE.test('00e3cdef-bb15-4768-861e-a547d98e1ba1'));
  assert.ok(!UUID_RE.test('../../etc/passwd'));
  assert.ok(!UUID_RE.test('00e3cdef-bb15-4768-861e-a547d98e1ba1 & calc'));
});

test('peek refuses ids that could escape the projects folder', async () => {
  assert.deepStrictEqual(await peek('..', '00e3cdef-bb15-4768-861e-a547d98e1ba1'), []);
  assert.deepStrictEqual(await peek('D--x', 'not-a-uuid'), []);
});

// Under an account Loop added, Claude Code cannot make a new project's folder
// itself (its mkdir through the linked "projects" fails), and saves nothing.
test('the folder a new project keeps its conversations in is made before a session starts', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-projects-'));
  assert.strictEqual(ensureProjectDir('D:/shop/ecom', root), true);
  assert.ok(fs.statSync(path.join(root, 'D--shop-ecom')).isDirectory());
  assert.strictEqual(ensureProjectDir('D:/shop/ecom', root), true); // there already: nothing to do
  assert.strictEqual(ensureProjectDir('', root), false);
});
