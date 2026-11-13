const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Claude Code's folder is read when the scanner loads, so it is set first.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-mem-import-'));
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
const memory = require('../src/main/memory');
const memoryImport = require('../src/main/memory-import');

const DIR = 'D--work-shop';
const proj = path.join(tmp, 'shop');
const own = path.join(tmp, 'claude', 'projects', DIR, 'memory');

test.before(async () => {
  fs.mkdirSync(own, { recursive: true });
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(own, 'MEMORY.md'), '- [Flow](flow-feature.md)\n');
  fs.writeFileSync(path.join(own, 'flow-feature.md'), '---\nname: flow-feature\ndescription: How checkout flows\n---\n\nCart, then pay.\n');
  fs.writeFileSync(path.join(proj, 'CLAUDE.md'), '# Rules\nUse pnpm.\n');
  fs.writeFileSync(path.join(proj, 'AGENTS.md'), '# Agents\nRun tests.\n');
  fs.writeFileSync(path.join(proj, 'GEMINI.md'), '# Gemini\nBe brief.\n');
  await memory.init(path.join(tmp, 'userdata'), path.join(tmp, 'loop-memory'));
});
test.after(() => {
  memory.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("each agent's memory files for a project are found; Claude's index is not a memory", async () => {
  const items = (await memoryImport.list(DIR, proj)).filter((i) => i.scope === 'project');
  const by = (agent) => items.filter((i) => i.agent === agent).map((i) => i.title);
  assert.deepStrictEqual(by('claude').sort(), ['Project instructions (CLAUDE.md)', 'flow feature'].sort());
  assert.deepStrictEqual(by('codex'), ['Project instructions (AGENTS.md)']);
  assert.deepStrictEqual(by('kimi'), ['Project instructions (AGENTS.md)']);
  assert.deepStrictEqual(by('antigravity'), ['Project instructions (GEMINI.md)']);
  assert.ok(items.every((i) => !i.imported));
});

test('importing copies into Loop, keeps the original, and does not copy twice', async () => {
  const flow = (await memoryImport.list(DIR, proj)).find((i) => i.title === 'flow feature');
  assert.strictEqual(await memoryImport.bring(DIR, proj, [flow.id]), 1);
  const file = path.join(tmp, 'loop-memory', 'projects', 'shop', 'shared', 'flow-feature.md');
  const saved = fs.readFileSync(file, 'utf8');
  assert.match(saved, /title: flow feature/);
  assert.match(saved, /How checkout flows\n\nCart, then pay\./);
  assert.match(saved, /tags: imported, claude, from-/);
  assert.ok(fs.existsSync(path.join(own, 'flow-feature.md')), 'the original stays');
  assert.strictEqual((await memoryImport.list(DIR, proj)).find((i) => i.id === flow.id).imported, true);
  assert.strictEqual(await memoryImport.bring(DIR, proj, [flow.id]), 0);
});

test('notes get readable file names, numbered only when the name is taken', async () => {
  await memory.saveNote({ dir: DIR, scope: 'project', title: 'Checkout', body: 'one' });
  await memory.saveNote({ dir: DIR, scope: 'project', title: 'Checkout', body: 'two' });
  await memory.saveNote({ dir: DIR, scope: 'project', title: 'Loop', body: 'not the index' });
  const names = fs.readdirSync(path.join(tmp, 'loop-memory', 'projects', 'shop', 'shared'));
  assert.ok(names.includes('checkout.md') && names.includes('checkout-2.md'), names.join(', '));
  assert.ok(names.includes('loop-note.md'), 'a note never takes the index name');
  const index = fs.readFileSync(path.join(tmp, 'loop-memory', 'projects', 'shop', 'shared', 'loop.md'), 'utf8');
  assert.match(index, /\[Checkout\]\(checkout\.md\) — one/);
});

test('when Loop owns memory, a session is told the rules and the notes it has', async () => {
  await memory.listAll(DIR);
  const brief = memory.ownerBrief(DIR);
  assert.match(brief, /kept by Loop/);
  assert.match(brief, /memory_search/);
  assert.match(brief, /flow feature/);
});

test("importing everything changes nothing in Claude's folder or the project: sessions, memory and instructions stay byte for byte", async () => {
  const crypto = require('crypto');
  const session = path.join(tmp, 'claude', 'projects', DIR, '11111111-2222-4333-8444-555555555555.jsonl');
  fs.writeFileSync(session, '{"type":"user","message":{"content":"keep me"}}\n');
  const snapshot = (dir) => {
    const out = {};
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else out[path.relative(dir, p)] = crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
      }
    };
    walk(dir);
    return out;
  };
  const beforeClaude = snapshot(path.join(tmp, 'claude'));
  const beforeProject = snapshot(proj);
  const all = await memoryImport.list(DIR, proj);
  await memoryImport.bring(DIR, proj, all.map((i) => i.id));
  assert.deepStrictEqual(snapshot(path.join(tmp, 'claude')), beforeClaude);
  assert.deepStrictEqual(snapshot(proj), beforeProject);
  assert.ok(Object.keys(beforeClaude).some((f) => f.endsWith('.jsonl')), 'a session transcript was part of the check');
});
