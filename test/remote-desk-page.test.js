// The page a browser gets for Loop's own window: phone-sized on a phone, with
// the browser's link to the PC, and without the policy meant for Electron.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const rd = require('../src/main/remote-desk');

test('the page served to a browser fits a phone and talks to the PC', () => {
  const root = path.join(__dirname, '..');
  rd.init({ renderer: path.join(root, 'src', 'renderer'), nodeModules: path.join(root, 'node_modules'), preload: path.join(root, 'src', 'main', 'preload.js'), onGone() {} });
  let page = '';
  const handled = rd.serve({ url: '/desk/', headers: {} }, { writeHead() {}, end: (b) => (page = String(b)) });
  assert.strictEqual(handled, true);
  assert.match(page, /<meta name="viewport" content="width=device-width, initial-scale=1/, 'without it a phone lays the page out 980 px wide');
  assert.match(page, /<script src="\/desk\/remote-deck\.js"><\/script>\s*<script src="app\.js">/);
  assert.doesNotMatch(page, /Content-Security-Policy/);
});
