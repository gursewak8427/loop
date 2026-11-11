const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { missingSpeech } = require('../scripts/check-web');

const script = path.join(__dirname, '..', 'scripts', 'check-web.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-check-web-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

// Writes a made-up build with the given main.dart.js and runs the check on it.
function build(name, js) {
  const out = path.join(dir, name);
  fs.mkdirSync(out);
  if (js !== undefined) fs.writeFileSync(path.join(out, 'main.dart.js'), js);
  return { out, run: spawnSync(process.execPath, [script, out], { encoding: 'utf8' }) };
}

test('a build with both speech plugins passes', () => {
  const { out, run } = build('ok', 'new self.webkitSpeechRecognition(); new SpeechSynthesisUtterance(t);');
  assert.deepStrictEqual(missingSpeech(out), []);
  assert.strictEqual(run.status, 0, run.stderr);
});

test('a build without the speech plugins fails and says to run flutter clean', () => {
  const { out, run } = build('stale', 'main() {}');
  assert.deepStrictEqual(missingSpeech(out), ['speech_to_text', 'flutter_tts']);
  assert.notStrictEqual(run.status, 0);
  assert.match(run.stderr, /speech_to_text and flutter_tts/);
  assert.match(run.stderr, /cd app && flutter clean/);
});

test('a build missing only one plugin names that one', () => {
  const { out, run } = build('half', 'new SpeechSynthesisUtterance(t);');
  assert.deepStrictEqual(missingSpeech(out), ['speech_to_text']);
  assert.notStrictEqual(run.status, 0);
  assert.match(run.stderr, /without speech_to_text,/);
});

test('no build at all fails too', () => {
  const { run } = build('empty');
  assert.notStrictEqual(run.status, 0);
  assert.match(run.stderr, /main\.dart\.js not found/);
});
