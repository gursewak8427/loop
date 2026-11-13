// Each project's marker names its git remote, so other machines recognise it
// whatever folder it lives in there.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const layout = require('../src/main/memory-layout');
const { normalizeRemote, matchProjects } = require('../src/main/cloud');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-layout-remote-'));
layout.attach(() => tmp);
layout.setProjectNamer(async () => 'shop');
layout.setRemoteLookup(async (dir) => (dir === 'D--shop' ? 'git@github.com:acme/shop.git' : ''));

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("a project's marker keeps its git remote, and older markers get theirs filled in", async () => {
  fs.mkdirSync(path.join(tmp, 'projects', 'old'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'projects', 'old', '.loop-project'), JSON.stringify({ dir: 'D--old' }));
  fs.writeFileSync(path.join(tmp, 'projects', 'old', 'note.md'), 'kept\n');
  await layout.ready();
  const made = await layout.projectDir('D--shop');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(made, '.loop-project'), 'utf8')).remote, 'git@github.com:acme/shop.git');
  assert.ok('remote' in JSON.parse(fs.readFileSync(path.join(tmp, 'projects', 'old', '.loop-project'), 'utf8')), 'asked once, then written even when empty');
});

test('git remotes in any spelling name the same project', () => {
  const want = 'github.com/acme/web-app';
  for (const u of ['git@github.com:Acme/Web-App.git', 'https://github.com/acme/web-app', 'ssh://git@github.com/Acme/web-app.git/', 'https://user@github.com/acme/web-app.git']) {
    assert.strictEqual(normalizeRemote(u), want, u);
  }
  assert.strictEqual(normalizeRemote('ssh://git@host.io:2222/a/b.git'), 'host.io:2222/a/b');
});

test('matching prefers the remote, then the folder key, then the name, one local each', () => {
  const cloud = [
    { folder: 'venli', dir: 'D--old-z', remote: 'github.com/acme/venli', notes: 3 },
    { folder: 'shop', dir: 'D--shop', remote: '', notes: 2 },
    { folder: 'blog', dir: 'D--blog', remote: '', notes: 1 },
    { folder: 'gone', dir: 'D--gone', remote: '', notes: 1 },
  ];
  const locals = [
    { dir: 'C--z', name: 'zl', remote: 'git@github.com:Acme/Venli.git' },
    { dir: 'D--shop', name: 'myshop', remote: '' },
    { dir: 'C--b', name: 'Blog', remote: '' },
  ];
  const got = matchProjects(cloud, locals).map((x) => `${x.folder}:${x.match ? x.match.how : '-'}`);
  assert.deepStrictEqual(got, ['venli:remote', 'shop:dir', 'blog:name', 'gone:-']);
});

test('a project brought in before is recognised by its folder, above all else', () => {
  const got = matchProjects([{ folder: 'venli', dir: 'D--old', remote: 'github.com/a/b', notes: 1 }], [{ dir: 'C--x', name: 'anything', remote: '', folder: 'venli' }]);
  assert.strictEqual(got[0].match.how, 'linked');
});
