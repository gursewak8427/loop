// Installed copies update from the newest GitHub release. These settings decide
// whether they can find it: break one and every copy out there stops updating.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const pkg = require('../package.json');

test('releases are looked for in the public repo', () => {
  const pub = [].concat(pkg.build.publish)[0];
  assert.strictEqual(pub.provider, 'github');
  assert.strictEqual(`${pub.owner}/${pub.repo}`, 'gursewak8427/loop');
});

test('the installer is named the way the updater asks for it', () => {
  // The updater turns spaces into dashes when it asks GitHub for the file, and
  // loop.prismaple.com/download/windows looks for an .exe: so dashes, no spaces.
  const name = pkg.build.nsis.artifactName;
  assert.ok(!/\s/.test(name), name);
  assert.strictEqual(name.replace('${productName}', 'Loop').replace('${version}', '1.2.3').replace('${ext}', 'exe'), 'Loop-Setup-1.2.3.exe');
});

test('building never publishes by itself', () => {
  assert.match(pkg.scripts.dist, /--publish never/);
});

test('electron-updater ships with the app', () => {
  assert.ok(pkg.dependencies['electron-updater']);
});

test('files that are never loaded stay out of the package (long paths break updates)', () => {
  for (const f of ['!node_modules/**/*.map', '!node_modules/@huggingface/transformers/types/**', '!node_modules/@huggingface/transformers/src/**']) assert.ok(pkg.build.files.includes(f), f);
});

test('the updater module is wired: check, download, install', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'updater.js'), 'utf8');
  for (const word of ['checkForUpdates', 'downloadUpdate', 'quitAndInstall', 'autoInstallOnAppQuit', 'app-update.yml']) assert.ok(src.includes(word), word);
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  for (const ch of ['update:state', 'update:check', 'update:download', 'update:install']) assert.ok(main.includes(`'${ch}'`), ch);
});
