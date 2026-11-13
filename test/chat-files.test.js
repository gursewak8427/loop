// Photos and files sent from the chat: kept in the upload folder, shown again
// from there only, and named in the conversation by their own names.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const chat = require('../src/main/chat');
const transcript = require('../src/main/transcript');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-uploads-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c40000000049454e44ae426082', 'hex');

test('a photo is saved as phone-<id>.<ext> and shown again from the folder', async () => {
  const r = await chat.upload(dir, { name: 'IMG 0042.PNG', b64: PNG.toString('base64') });
  assert.strictEqual(r.image, true);
  assert.match(path.basename(r.path), /^phone-[\w-]+\.png$/);
  assert.deepStrictEqual(fs.readFileSync(r.path), PNG);
  const src = await chat.picture(dir, r.path);
  assert.ok(src.startsWith('data:image/png;base64,'));
});

test('another file keeps its name after the id', async () => {
  const r = await chat.upload(dir, { name: 'Q3 report (final).pdf', b64: Buffer.from('%PDF-1.4').toString('base64') });
  assert.strictEqual(r.image, false);
  assert.match(path.basename(r.path), /^phone-[\w-]+--Q3_report_\(final\)\.pdf$/);
});

test('pictures are only read from the upload folder, and only pictures', async () => {
  const outside = path.join(os.tmpdir(), 'phone-abc.png');
  assert.strictEqual(await chat.picture(dir, '../../secret.png'), null);
  assert.strictEqual(await chat.picture(dir, 'C:\\Windows\\win.ini'), null);
  assert.strictEqual(await chat.picture(dir, outside), null, 'a phone- name elsewhere is looked up in the folder, where it is not');
  assert.strictEqual(await chat.picture('', 'phone-x.png'), null);
});

test('too big, or empty, is refused', async () => {
  await assert.rejects(chat.upload(dir, { name: 'a.png', b64: '' }));
  await assert.rejects(chat.upload(dir, { name: 'a.bin', b64: 'A'.repeat(30 * 1024 * 1024) }));
});

test('in the conversation, a sent file shows as its name and a photo as a picture', () => {
  const up = path.join(dir, 'phone-abc-12ef.png');
  const doc = path.join(dir, 'phone-abc-34ef--notes.txt').replace(dir, 'C:\\Users\\X\\AppData\\Roaming\\Loop\\phone-uploads');
  const line = JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-11-12T10:00:00Z', message: { role: 'user', content: `Look at these C:\\Users\\X\\AppData\\Roaming\\Loop\\phone-uploads\\phone-abc-12ef.png ${doc}` } });
  const [item] = transcript.parse([line]);
  assert.strictEqual(item.text, 'Look at these');
  assert.deepStrictEqual(item.files.map((f) => f.name), ['notes.txt']);
  assert.strictEqual(item.images.length, 1);
  assert.match(item.images[0].file, /phone-abc-12ef\.png$/);
  assert.ok(up);
});

test('a file sent in parts arrives whole, named on the last part', async () => {
  const data = Buffer.alloc(2.5 * 1024 * 1024, 7);
  const b64 = data.toString('base64');
  const CH = 1 << 20;
  const of = Math.ceil(b64.length / CH);
  let r;
  for (let i = 0; i < of; i++) r = await chat.uploadPart(dir, { id: 'abc123xyz', name: 'big photo.jpg', i, of, b64: b64.slice(i * CH, (i + 1) * CH) });
  assert.match(path.basename(r.path), /^phone-[\w-]+\.jpg$/);
  assert.deepStrictEqual(fs.readFileSync(r.path), data);
  assert.ok(!fs.existsSync(path.join(dir, '.part-abc123xyz')), 'the part file is gone');
});

test('parts must come in order, with a sane id', async () => {
  await assert.rejects(chat.uploadPart(dir, { id: 'zz9999', name: 'a.png', i: 1, of: 2, b64: 'AAAA' }));
  await assert.rejects(chat.uploadPart(dir, { id: '../x', name: 'a.png', i: 0, of: 1, b64: 'AAAA' }));
});

test('a removed file goes from the folder; nothing outside it can be removed', async () => {
  const r = await chat.upload(dir, { name: 'drop me.txt', b64: Buffer.from('x').toString('base64') });
  assert.strictEqual(await chat.discard(dir, r.path), true);
  assert.ok(!fs.existsSync(r.path));
  assert.strictEqual(await chat.discard(dir, 'C:\Windows\win.ini'), false);
  assert.strictEqual(await chat.discard(dir, '..\..\config.json'), false);
});
