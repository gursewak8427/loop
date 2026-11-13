// Tool environments: two real tool servers (a program and a web address), two
// environments, and what a session in each one sees and can run.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const hub = require('../src/main/hub');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-hub-'));
const SID = '11111111-2222-3333-4444-555555555555';

// A tool server as a program: one tool, "shout", and it tells its KEY back.
const prog = path.join(tmp, 'shout.js');
fs.writeFileSync(
  prog,
  `let buf='';process.stdin.on('data',d=>{buf+=d;let i;while((i=buf.indexOf('\\n'))>=0){const l=buf.slice(0,i);buf=buf.slice(i+1);if(!l.trim())continue;const m=JSON.parse(l);if(m.id===undefined)continue;
const r=x=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:x})+'\\n');
if(m.method==='initialize')r({protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'shout',version:'1'}});
else if(m.method==='tools/list')r({tools:[{name:'shout',description:'Says it louder',inputSchema:{type:'object',properties:{text:{type:'string'}}}}]});
else if(m.method==='tools/call')r({content:[{type:'text',text:String(m.params.arguments.text).toUpperCase()+' '+(process.env.KEY||'')}]});
else r({});}});`,
);

// A tool server as a web address: one tool, "add". It wants a token, and answers as a stream.
let web;
let webUrl;
let sawToken = '';
test.before(async () => {
  web = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      sawToken = req.headers.authorization || '';
      if (sawToken !== 'Bearer s3cret') return res.writeHead(401).end();
      const m = JSON.parse(raw);
      if (m.id === undefined) return res.writeHead(202).end();
      const result =
        m.method === 'initialize'
          ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'sums', version: '1' } }
          : m.method === 'tools/list'
            ? { tools: [{ name: 'add', description: 'Adds two numbers', inputSchema: { type: 'object' } }] }
            : { content: [{ type: 'text', text: String(m.params.arguments.a + m.params.arguments.b) }] };
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Mcp-Session-Id': 'abc' });
      res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: m.id, result })}\n\n`);
    });
  });
  await new Promise((r) => web.listen(0, '127.0.0.1', r));
  webUrl = `http://127.0.0.1:${web.address().port}/mcp`;
  await hub.init(tmp);
});
test.after(() => {
  hub.stop();
  web.close();
});

const rpc = (dir, method, params) => hub.handle({ jsonrpc: '2.0', id: 1, method, params }, dir).then((r) => r.result);
const names = (r) => r.tools.map((t) => t.name).sort();

let shoutKey;
let sumsKey;

test('a tool is connected once, and its key never reaches a window', async () => {
  const a = hub.saveServer({ name: 'Shout', kind: 'stdio', command: `"${process.execPath}" "${prog}"`, env: 'KEY=hunter2' });
  const b = hub.saveServer({ name: 'Sums', kind: 'http', url: webUrl, headers: 'Authorization: Bearer s3cret' });
  assert.ok(a.ok && b.ok);
  shoutKey = a.key;
  sumsKey = b.key;
  const seen = JSON.stringify(hub.state());
  assert.ok(!seen.includes('hunter2') && !seen.includes('s3cret'), 'no secret in what a window gets');
  assert.deepStrictEqual(hub.state().servers.find((s) => s.key === shoutKey).envNames, ['KEY']);
  assert.strictEqual(hub.state().servers.find((s) => s.key === sumsKey).machineOnly, true, 'an address on this PC stays on this PC');
});

test('the Test button connects and lists the tools', async () => {
  assert.deepStrictEqual((await hub.test(shoutKey)).tools, ['shout']);
  assert.deepStrictEqual((await hub.test(sumsKey)).tools, ['add']);
  assert.strictEqual(sawToken, 'Bearer s3cret');
});

test('two environments give two projects different tools', async () => {
  const personal = hub.saveEnv({ name: 'Personal', servers: [shoutKey] }).id;
  const work = hub.saveEnv({ name: 'Client work', servers: [shoutKey, sumsKey] }).id;
  hub.setProjectEnv('proj-a', personal);
  hub.setProjectEnv('proj-b', work);

  assert.deepStrictEqual(names(await rpc('proj-a', 'tools/list')), ['loop_find_tools', 'loop_run_tool', `${shoutKey}__shout`]);
  assert.deepStrictEqual(names(await rpc('proj-b', 'tools/list')), ['loop_find_tools', 'loop_run_tool', `${shoutKey}__shout`, `${sumsKey}__add`]);
  assert.deepStrictEqual((await rpc('proj-c', 'tools/list')).tools, [], 'a project with no environment gets nothing');
  assert.strictEqual(hub.entryFor('proj-c', SID), null);
  assert.match(hub.entryFor('proj-a', SID).server.url, /^http:\/\/127\.0\.0\.1:\d+\/hub\/[a-f0-9]+\/proj-a\//);
});

test('a session runs a tool through Loop, and only the tools of its environment', async () => {
  const said = await rpc('proj-a', 'tools/call', { name: `${shoutKey}__shout`, arguments: { text: 'hello' } });
  assert.strictEqual(said.content[0].text, 'HELLO hunter2', 'the program got its key');
  const sum = await rpc('proj-b', 'tools/call', { name: `${sumsKey}__add`, arguments: { a: 2, b: 40 } });
  assert.strictEqual(sum.content[0].text, '42');
  const no = await rpc('proj-a', 'tools/call', { name: `${sumsKey}__add`, arguments: { a: 1, b: 1 } });
  assert.strictEqual(no.isError, true, 'Personal has no Sums');
});

test('a tool added later is found and run without restarting the session', async () => {
  const personal = hub.state().envs.find((e) => e.name === 'Personal');
  hub.saveEnv({ id: personal.id, name: 'Personal', servers: [shoutKey, sumsKey] });
  const found = JSON.parse((await rpc('proj-a', 'tools/call', { name: 'loop_find_tools', arguments: { query: 'adds numbers' } })).content[0].text);
  assert.deepStrictEqual(found.tools.map((t) => t.name), [`${sumsKey}__add`]);
  const ran = await rpc('proj-a', 'tools/call', { name: 'loop_run_tool', arguments: { name: `${sumsKey}__add`, arguments: { a: 5, b: 6 } } });
  assert.strictEqual(ran.content[0].text, '11');
});

test('the default environment covers projects that chose nothing; "none" opts a project out', async () => {
  const work = hub.state().envs.find((e) => e.name === 'Client work');
  hub.setDefaultEnv(work.id);
  assert.strictEqual(hub.envOf('proj-c').name, 'Client work');
  hub.setProjectEnv('proj-c', 'none');
  assert.strictEqual(hub.envOf('proj-c'), null);
  hub.setProjectEnv('proj-c', '');
  hub.setDefaultEnv('');
});

test('a broken tool does not take the others down, and says why', async () => {
  const bad = hub.saveServer({ name: 'Broken', kind: 'stdio', command: 'no-such-program-xyz' }).key;
  const work = hub.state().envs.find((e) => e.name === 'Client work');
  hub.saveEnv({ id: work.id, name: work.name, servers: [...work.servers, bad] });
  const list = names(await rpc('proj-b', 'tools/list'));
  assert.ok(list.includes(`${shoutKey}__shout`) && list.includes(`${sumsKey}__add`));
  assert.ok(hub.state().servers.find((s) => s.key === bad).error, 'the reason is kept for the window');
  hub.removeServer(bad);
  assert.ok(!hub.state().envs.find((e) => e.id === work.id).servers.includes(bad));
});

test('what travels to other machines leaves machine-only tools behind, and comes back merged', () => {
  const far = hub.saveServer({ name: 'Notion', kind: 'http', url: 'https://mcp.example.com/mcp', headers: 'Authorization: Bearer n' }).key;
  const work = hub.state().envs.find((e) => e.name === 'Client work');
  hub.saveEnv({ id: work.id, name: work.name, servers: [...work.servers, far] });
  const out = hub.shared();
  assert.deepStrictEqual(Object.keys(out.servers), [far], 'only the tool that works anywhere');
  assert.deepStrictEqual(out.envs[work.id].servers, [far]);

  // Another machine renamed the environment and added a tool; this one takes it and keeps its own.
  const theirs = JSON.parse(JSON.stringify(out));
  theirs.at = Date.now() + 5000;
  theirs.envs[work.id].name = 'Clients';
  theirs.servers.linear = { name: 'Linear', kind: 'http', url: 'https://linear.example.com/mcp', headers: {} };
  theirs.envs[work.id].servers.push('linear');
  assert.strictEqual(hub.merged(theirs), true);
  const now = hub.state().envs.find((e) => e.id === work.id);
  assert.strictEqual(now.name, 'Clients');
  assert.ok(now.servers.includes('linear') && now.servers.includes(far));
  assert.ok(now.servers.includes(shoutKey) && now.servers.includes(sumsKey), 'this PC keeps its own tools in the environment');
  assert.strictEqual(hub.envOf('proj-b').name, 'Clients', 'projects keep their environment');
  assert.strictEqual(hub.merged(theirs), false, 'the same thing twice changes nothing');
});

test("bringing in Claude Code's own tools", () => {
  const file = path.join(tmp, 'claude.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      mcpServers: {
        local: { type: 'http', url: 'http://127.0.0.1:7801/x' },
        hosted: { command: 'npx', args: ['-y', 'some-mcp'], env: { TOKEN: 't' } },
        pinned: { command: 'C:\\tools\\node.exe', args: ['C:\\tools\\server.js'] },
        Shout: { command: 'already-here' },
      },
    }),
  );
  assert.strictEqual(hub.importClaude(file).added, 3, 'the one Loop already has is left alone');
  const by = Object.fromEntries(hub.state().servers.map((s) => [s.name, s]));
  assert.strictEqual(by.local.machineOnly, true);
  assert.strictEqual(by.hosted.machineOnly, false);
  assert.strictEqual(by.pinned.machineOnly, process.platform === 'win32');
  assert.deepStrictEqual(by.hosted.envNames, ['TOKEN']);
  assert.strictEqual(hub.importClaude(file).added, 0);
});

test('command lines and key lists are read the way people type them', () => {
  assert.deepStrictEqual(hub.words('npx -y "@scope/pkg name" --flag'), ['npx', '-y', '@scope/pkg name', '--flag']);
  assert.deepStrictEqual(hub.pairs('A=1\nB: two words\n\nC', { C: 'kept' }), { A: '1', B: 'two words', C: 'kept' });
});
