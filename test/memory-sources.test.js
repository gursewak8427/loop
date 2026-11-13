const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sources } = require('../src/main/memory-import');

// A pretend home and project with every agent's files where each one keeps them.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-mem-sources-'));
const home = path.join(tmp, 'home');
const claudeDir = path.join(home, '.claude');
const proj = path.join(tmp, 'work', 'eventhive');
const DIR = 'D--work-eventhive';
const put = (file, text = '# x\nsomething\n') => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

test.before(() => {
  // Claude Code
  put(path.join(claudeDir, 'projects', DIR, 'memory', 'MEMORY.md'));
  put(path.join(claudeDir, 'projects', DIR, 'memory', 'deploy.md'));
  put(path.join(proj, 'CLAUDE.md'));
  put(path.join(proj, '.claude', 'CLAUDE.md'));
  put(path.join(proj, 'CLAUDE.local.md'));
  put(path.join(proj, '.claude', 'rules', 'testing.md'));
  put(path.join(proj, 'lms', 'CLAUDE.md'));
  put(path.join(proj, 'node_modules', 'pkg', 'CLAUDE.md')); // downloaded code: not looked in
  put(path.join(claudeDir, 'CLAUDE.md'));
  put(path.join(claudeDir, 'rules', 'style.md'));
  // Codex
  put(path.join(proj, 'AGENTS.md'));
  put(path.join(proj, 'AGENTS.override.md'));
  put(path.join(proj, 'web', 'AGENTS.md'));
  put(path.join(home, '.codex', 'AGENTS.md'));
  put(path.join(home, '.codex', 'memories', 'MEMORY.md'));
  put(path.join(home, '.codex', 'memories', 'memory_summary.md'));
  put(path.join(home, '.codex', 'memories', 'rollout_summaries', 'a.md')); // raw summaries stay out
  // Kimi Code
  put(path.join(proj, '.kimi-code', 'AGENTS.md'));
  put(path.join(home, '.kimi-code', 'AGENTS.md'));
  put(path.join(home, '.agents', 'AGENTS.md'));
  // Grok Build
  put(path.join(proj, '.grok', 'rules', 'api.md'));
  put(path.join(home, '.grok', 'AGENTS.md'));
  put(path.join(home, '.grok', 'memory', 'MEMORY.md'));
  put(path.join(home, '.grok', 'memory', 'topics', 'prefs.md'));
  put(path.join(home, '.grok', 'memory', 'eventhive-1a2b', 'MEMORY.md'));
  put(path.join(home, '.grok', 'memory', 'venli-9f9f', 'MEMORY.md')); // another project's
  // Gemini (Antigravity)
  put(path.join(proj, 'GEMINI.md'));
  put(path.join(proj, '.agent', 'rules', 'ui.md'));
  put(path.join(home, '.gemini', 'GEMINI.md'));
  put(path.join(home, '.gemini', 'antigravity', 'knowledge', 'item1', 'artifacts', 'overview.md'));
  // Empty files are nothing to bring.
  put(path.join(proj, 'empty', 'CLAUDE.md'), '');
});
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const found = () => sources(DIR, proj, home, claudeDir);
const files = (agent, scope) =>
  found()
    .filter((x) => x.agent === agent && x.scope === scope)
    .map((x) => path.relative(tmp, x.file).replace(/\\/g, '/'))
    .sort();

test('Claude Code: its memory, project instructions, local notes, rules and sub-project files', () => {
  assert.deepStrictEqual(files('claude', 'project'), [
    'home/.claude/projects/D--work-eventhive/memory/deploy.md',
    'work/eventhive/.claude/CLAUDE.md',
    'work/eventhive/.claude/rules/testing.md',
    'work/eventhive/CLAUDE.local.md',
    'work/eventhive/CLAUDE.md',
    'work/eventhive/lms/CLAUDE.md',
  ]);
  assert.deepStrictEqual(files('claude', 'company'), ['home/.claude/CLAUDE.md', 'home/.claude/rules/style.md']);
});

test('Codex: AGENTS files in the project and below, and its memories for every project', () => {
  assert.deepStrictEqual(files('codex', 'project'), ['work/eventhive/AGENTS.md', 'work/eventhive/AGENTS.override.md', 'work/eventhive/web/AGENTS.md']);
  assert.deepStrictEqual(files('codex', 'company'), ['home/.codex/AGENTS.md', 'home/.codex/memories/MEMORY.md', 'home/.codex/memories/memory_summary.md']);
});

test('Kimi Code: project AGENTS files, its own global file and the one any agent reads', () => {
  assert.deepStrictEqual(files('kimi', 'project'), ['work/eventhive/.kimi-code/AGENTS.md', 'work/eventhive/AGENTS.md']);
  assert.deepStrictEqual(files('kimi', 'company'), ['home/.agents/AGENTS.md', 'home/.kimi-code/AGENTS.md']);
});

test("Grok Build: rules, its global memory, and only this project's workspace memory", () => {
  assert.deepStrictEqual(files('grok', 'project'), ['home/.grok/memory/eventhive-1a2b/MEMORY.md', 'work/eventhive/.grok/rules/api.md', 'work/eventhive/AGENTS.md']);
  assert.deepStrictEqual(files('grok', 'company'), ['home/.grok/AGENTS.md', 'home/.grok/memory/MEMORY.md', 'home/.grok/memory/topics/prefs.md']);
});

test('Gemini: GEMINI.md, Antigravity rules, and what it remembers and knows for every project', () => {
  assert.deepStrictEqual(files('antigravity', 'project'), ['work/eventhive/.agent/rules/ui.md', 'work/eventhive/GEMINI.md']);
  assert.deepStrictEqual(files('antigravity', 'company'), ['home/.gemini/GEMINI.md', 'home/.gemini/antigravity/knowledge/item1/artifacts/overview.md']);
});

test('nothing in downloaded code, no empty files, and every item has a title', () => {
  const all = found();
  assert.ok(!all.some((x) => x.file.includes('node_modules')));
  assert.ok(!all.some((x) => x.file.includes(`${path.sep}empty${path.sep}`)));
  assert.ok(all.every((x) => x.id && x.agent && (x.scope === 'project' || x.scope === 'company')));
  // The same file under two agents (AGENTS.md) has one id, so it is imported once.
  const agents = all.filter((x) => x.file === path.join(proj, 'AGENTS.md'));
  assert.ok(agents.length >= 2 && new Set(agents.map((x) => x.id)).size === 1);
});
