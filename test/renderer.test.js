// The window loads its files one after another into a single shared scope.
// Two files declaring the same name is not a warning there: the second file
// stops dead, and everything after it never runs, so the window comes up with
// pieces missing. Cheap to check here, miserable to find by hand.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'src', 'renderer');
const page = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');

// The files the window loads, in the order it loads them.
const loaded = [...page.matchAll(/<script src="([^"]+\.js)"><\/script>/g)]
  .map((m) => m[1])
  .filter((f) => !f.startsWith('../'));

test('the window loads the files it is meant to', () => {
  assert.ok(loaded.includes('app.js'), 'app.js is loaded');
  assert.ok(loaded.includes('voice.js'), 'voice.js is loaded');
  for (const f of loaded) assert.ok(fs.existsSync(path.join(DIR, f)), `${f} is there`);
});

test('no two renderer files declare the same name', () => {
  const seen = new Map(); // name -> file that declared it first
  const clashes = [];
  for (const file of loaded) {
    const src = fs.readFileSync(path.join(DIR, file), 'utf8');
    for (const m of src.matchAll(/^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)) {
      const name = m[1];
      if (seen.has(name)) clashes.push(`${name}: ${seen.get(name)} and ${file}`);
      else seen.set(name, file);
    }
  }
  assert.deepStrictEqual(clashes, [], 'these names are declared twice, and the second file will not load');
});

test('every renderer file parses on its own', () => {
  const vm = require('node:vm');
  for (const file of loaded) {
    const src = fs.readFileSync(path.join(DIR, file), 'utf8');
    assert.doesNotThrow(() => new vm.Script(src, { filename: file }), `${file} does not parse`);
  }
});

// On a Mac the shortcuts are Cmd, so what the window shows must follow MOD too.
// Ctrl+Tab is the one that stays Ctrl everywhere: Cmd+Tab belongs to the system.
test('shortcut hints name Cmd on a Mac, not a fixed Ctrl', () => {
  const fixed = [];
  for (const file of loaded) {
    const lines = fs.readFileSync(path.join(DIR, file), 'utf8').split('\n');
    lines.forEach((line, i) => {
      const code = line.replace(/\/\/.*$|^\s*(\/\*\*?|\*).*$/, '');
      if (/^const MOD =/.test(code)) return; // where MOD itself is set
      if (/['"`]Ctrl\b/.test(code) && !/'Ctrl'\), ' ', h\('kbd', \{\}, 'Tab'\)/.test(code)) fixed.push(`${file}:${i + 1}`);
      if (/Ctrl\+(Shift|Enter|K)/.test(code)) fixed.push(`${file}:${i + 1}`);
    });
  }
  assert.deepStrictEqual(fixed, [], 'use MOD for these hints');
});

test('app shortcuts take Cmd on a Mac and Ctrl elsewhere', () => {
  const vm = require('node:vm');
  const src = fs.readFileSync(path.join(DIR, 'app.js'), 'utf8');
  const head = src.slice(0, src.indexOf('const S = {'));
  const on = (platform) => vm.runInNewContext(`${head}; ({ MOD, modKey })`, { deck: { platform } });
  const mac = on('darwin');
  const win = on('win32');
  assert.strictEqual(mac.MOD, 'Cmd');
  assert.strictEqual(win.MOD, 'Ctrl');
  assert.ok(mac.modKey({ metaKey: true, ctrlKey: false }));
  assert.ok(!mac.modKey({ metaKey: false, ctrlKey: true }), 'Ctrl stays with the terminal on a Mac');
  assert.ok(win.modKey({ metaKey: false, ctrlKey: true }));
  assert.ok(!win.modKey({ metaKey: true, ctrlKey: false }));
});
