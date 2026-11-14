// The list of services "Add a tool" offers, in the app and on the website.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'src', 'renderer', 'tool-catalog.js');
const WEB = path.join(ROOT, 'cloud', 'web', 'tool-catalog.js');
const src = fs.readFileSync(APP, 'utf8');
// The public copy of Loop has no cloud folder: what compares the two is skipped there.
const noWeb = !fs.existsSync(WEB) && 'the Loop Cloud website is not in this checkout';
const list = vm.runInNewContext(`${src}; TOOL_CATALOG`);
const programs = vm.runInNewContext(`${src}; TOOL_PROGRAMS`);

test('the app and the website have the same list, byte for byte', { skip: noWeb }, () => {
  assert.ok(fs.readFileSync(APP).equals(fs.readFileSync(WEB)));
});

test('it is a plain script: one list, nothing brought in or handed out', () => {
  assert.ok(Array.isArray(list) && list.length >= 20);
  assert.ok(!/\b(require|import|export|module)\b/.test(src.replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/^\s*\/\/.*$/gm, '')));
});

test('every service has an id of its own and an address of its own', () => {
  assert.strictEqual(new Set(list.map((c) => c.id)).size, list.length);
  assert.strictEqual(new Set(list.map((c) => c.url)).size, list.length);
  assert.strictEqual(new Set(list.map((c) => c.name)).size, list.length);
});

test('every service is filled in the way the pages expect', () => {
  for (const c of list) {
    assert.deepStrictEqual(Object.keys(c).sort(), ['about', 'color', 'docs', 'header', 'icon', 'id', 'name', 'sign', 'url'], c.id);
    assert.match(c.id, /^[a-z0-9-]+$/, c.id);
    assert.ok(c.name && c.name.length <= 60, `${c.id}: a name the form takes`);
    assert.strictEqual(new URL(c.url).protocol, 'https:', `${c.id}: https`);
    assert.strictEqual(new URL(c.docs).protocol, 'https:', `${c.id}: docs`);
    assert.ok(c.about && c.about.length < 80, `${c.id}: about is ${c.about.length} long`);
    assert.ok(['browser', 'key', 'none'].includes(c.sign), `${c.id}: sign`);
    if (c.sign === 'key') assert.match(c.header, /^[A-Za-z-]+: \S/, `${c.id}: the header line to fill`);
    else assert.strictEqual(c.header, '', `${c.id}: no header unless it takes a key`);
    if (c.icon) {
      assert.match(c.icon, /^[Mm][\d\s.,a-zA-Z-]+$/, `${c.id}: icon is path data only`);
      assert.match(c.color, /^#[0-9A-F]{6}$/i, `${c.id}: colour`);
    } else assert.strictEqual(c.color, '', `${c.id}: no colour without an icon`);
  }
});

test('both pages load the list before the script that uses it', () => {
  const app = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');
  assert.ok(app.indexOf('src="tool-catalog.js"') > 0 && app.indexOf('src="tool-catalog.js"') < app.indexOf('src="tools.js"'));
  if (noWeb) return;
  const web = fs.readFileSync(path.join(ROOT, 'cloud', 'web', 'index.html'), 'utf8');
  assert.ok(web.indexOf('src="/tool-catalog.js"') > 0 && web.indexOf('src="/tool-catalog.js"') < web.indexOf('src="/app.js"'));
  // The website gives it an address that changes with the file, as it does app.js.
  assert.match(fs.readFileSync(path.join(ROOT, 'cloud', 'server.js'), 'utf8'), /tool-catalog\.js\?v=\$\{printAt\('tool-catalog\.js'\)\}/);
});

test('a program Loop knows is filled in the way the form expects', () => {
  assert.ok(programs.length >= 1);
  assert.strictEqual(new Set([...list, ...programs].map((c) => c.id)).size, list.length + programs.length, 'ids are not shared with the services');
  assert.strictEqual(new Set([...list, ...programs].map((c) => c.name)).size, list.length + programs.length);
  for (const c of programs) {
    assert.deepStrictEqual(Object.keys(c).sort(), ['about', 'color', 'command', 'docs', 'fill', 'icon', 'id', 'keys', 'name'], c.id);
    assert.match(c.id, /^[a-z0-9-]+$/, c.id);
    assert.match(c.command, /^[A-Za-z0-9@._/ -]+$/, `${c.id}: a plain command, nothing a shell would act on`);
    for (const line of c.keys.split('\n')) assert.match(line, /^[A-Z][A-Z0-9_]*=\S*$/, `${c.id}: ${line}`);
    assert.ok(!/=(sk-|ghp_|eyJ)/.test(c.keys), `${c.id}: no key of anyone's is written here`);
    assert.ok(c.about && c.about.length < 80 && c.fill, c.id);
    assert.strictEqual(new URL(c.docs).protocol, 'https:');
    if (c.icon) {
      assert.match(c.icon, /^[Mm][\d\s.,a-zA-Z-]+$/, `${c.id}: icon is path data only`);
      assert.match(c.color, /^#[0-9A-F]{6}$/i);
    } else assert.strictEqual(c.color, '');
  }
});
