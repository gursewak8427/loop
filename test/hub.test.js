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
let cloud;
let cloudBase;
const cloudSaw = [];
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
  // Loop Cloud, as far as the hub knows it: the address that takes this machine's sign-in.
  cloud = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      cloudSaw.push({ url: req.url, auth: req.headers.authorization || '' });
      if (req.headers.authorization !== 'Bearer machine-sign-in') return res.writeHead(401).end();
      const m = JSON.parse(raw);
      if (m.id === undefined) return res.writeHead(202).end();
      const result =
        m.method === 'initialize'
          ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'Far', version: '1' } }
          : m.method === 'tools/list'
            ? { tools: [{ name: 'far', description: 'Runs in the cloud', inputSchema: { type: 'object' } }] }
            : { content: [{ type: 'text', text: 'from the cloud' }] };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
    });
  });
  await new Promise((r) => cloud.listen(0, '127.0.0.1', r));
  cloudBase = `http://127.0.0.1:${cloud.address().port}`;
  await hub.init(tmp, { cloudHeaders: () => ({ Authorization: 'Bearer machine-sign-in' }), cloudBase });
});
test.after(() => {
  hub.stop();
  web.close();
  cloud.close();
  cloud.closeAllConnections(); // the hub's calls leave a connection open; do not wait for it
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

test('what is set up on Loop Cloud is taken as it is; this PC keeps its own choices', async () => {
  const work = hub.state().envs.find((e) => e.name === 'Client work');
  // The website's document: the two tools this PC knows, a program it has never seen,
  // one that lives on another machine, and a renamed environment.
  const theirs = {
    at: Date.now() + 5000,
    servers: {
      [shoutKey]: { name: 'Shout', kind: 'stdio', command: process.execPath, args: [prog], env: { KEY: 'hunter2' } },
      newprog: { name: 'New program', kind: 'stdio', command: process.execPath, args: [prog], env: { KEY: 'fromcloud' } },
      far: { name: 'Far away', kind: 'stdio', command: 'C:\other\tool.exe', args: [], env: {}, on: 'Some other machine' },
    },
    envs: { [work.id]: { name: 'Clients', only: true, servers: [shoutKey, 'newprog', 'far'] } },
  };
  assert.strictEqual(hub.adopt(theirs, 'This machine'), true);
  assert.strictEqual(hub.adopt(theirs, 'This machine'), false, 'the same thing twice changes nothing');
  assert.strictEqual(hub.envOf('proj-b').name, 'Clients', 'projects keep their environment');
  assert.strictEqual(hub.envOf('proj-a'), null, 'an environment the website removed is gone here too');

  const by = Object.fromEntries(hub.state().servers.map((x) => [x.key, x]));
  assert.strictEqual(by[shoutKey].ask, false, 'a program allowed before stays allowed');
  assert.strictEqual(by.newprog.ask, true, 'a program the cloud names is not run until someone here says so');
  assert.strictEqual(by.far.here, false);

  // Until it is allowed, its tools are simply not there, and the others work.
  assert.deepStrictEqual(names(await rpc('proj-b', 'tools/list')), ['loop_find_tools', 'loop_run_tool', `${shoutKey}__shout`]);
  const refused = await rpc('proj-b', 'tools/call', { name: 'newprog__shout', arguments: { text: 'x' } });
  assert.strictEqual(refused.isError, true);
  assert.match(refused.content[0].text, /not been allowed/);

  assert.strictEqual(hub.approve('newprog'), true);
  const ok = await rpc('proj-b', 'tools/call', { name: 'newprog__shout', arguments: { text: 'now' } });
  assert.strictEqual(ok.content[0].text, 'NOW fromcloud');

  // A changed command asks again.
  const changed = JSON.parse(JSON.stringify(theirs));
  changed.at += 1;
  changed.servers.newprog.args = [prog, '--other'];
  hub.adopt(changed, 'This machine');
  assert.strictEqual(hub.state().servers.find((x) => x.key === 'newprog').ask, true);
});

test('a tool carries its files: each machine puts them in place and the command is given the path', async () => {
  // A tool whose one job is to read the file it was pointed at, and the file named in its key.
  const reader = path.join(tmp, 'reader.js');
  fs.writeFileSync(
    reader,
    `const fs=require('fs');let buf='';process.stdin.on('data',d=>{buf+=d;let i;while((i=buf.indexOf('\\n'))>=0){const l=buf.slice(0,i);buf=buf.slice(i+1);if(!l.trim())continue;const m=JSON.parse(l);if(m.id===undefined)continue;
const r=x=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:x})+'\\n');
if(m.method==='initialize')r({protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'reader',version:'1'}});
else if(m.method==='tools/list')r({tools:[{name:'read',description:'Reads its key file',inputSchema:{type:'object'}}]});
else if(m.method==='tools/call')r({content:[{type:'text',text:fs.readFileSync(process.argv[2].slice(6),'utf8')+'|'+fs.readFileSync(process.env.CERT,'utf8')+'|'+process.argv[2]}]});
else r({});}});`,
  );
  const b64 = (t) => Buffer.from(t).toString('base64');
  const state0 = hub.state();
  const work = state0.envs[0];
  const servers = Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(path.join(tmp, 'mcp-hub.json'), 'utf8')).servers));
  servers.keyed = { name: 'Keyed', kind: 'stdio', command: process.execPath, args: [reader, '--key={file:id_test}'], env: { CERT: '{file:ca.pem}' }, files: { id_test: b64('PRIVATE-KEY-BODY'), 'ca.pem': b64('CERT-BODY') } };
  const theirs = { at: Date.now() + 60000, servers, envs: { [work.id]: { name: work.name, only: true, servers: [...work.servers, 'keyed'] } } };
  hub.adopt(theirs, 'This machine');
  const seen = hub.state().servers.find((s) => s.key === 'keyed');
  assert.deepStrictEqual(seen.fileNames, ['id_test', 'ca.pem']);
  assert.ok(!JSON.stringify(hub.state()).includes(b64('PRIVATE-KEY-BODY')), 'a window is told the names of files, never what is in them');
  assert.strictEqual(seen.ask, true, 'a program with files still waits to be allowed');
  hub.approve('keyed');

  const out = (await rpc('proj-b', 'tools/call', { name: 'keyed__read', arguments: {} })).content[0].text.split('|');
  assert.strictEqual(out[0], 'PRIVATE-KEY-BODY', 'the path in the command leads to the file');
  assert.strictEqual(out[1], 'CERT-BODY', 'so does the path in a key');
  const at = out[2].slice(6);
  assert.ok(at.startsWith(path.join(tmp, 'mcp-files', 'keyed')) && fs.existsSync(at));

  // A changed file asks again; a removed file is taken off the disk; a removed tool takes its folder.
  const next = JSON.parse(JSON.stringify(theirs));
  next.at += 1;
  next.servers.keyed.files = { id_test: b64('ROTATED-KEY') };
  next.servers.keyed.env = {};
  hub.adopt(next, 'This machine');
  assert.strictEqual(hub.state().servers.find((s) => s.key === 'keyed').ask, true, 'a new key file is a new thing to allow');
  hub.approve('keyed');
  await hub.test('keyed');
  assert.strictEqual(fs.readFileSync(at, 'utf8'), 'ROTATED-KEY');
  assert.ok(!fs.existsSync(path.join(tmp, 'mcp-files', 'keyed', 'ca.pem')));
  const gone = JSON.parse(JSON.stringify(next));
  gone.at += 1;
  delete gone.servers.keyed;
  hub.adopt(gone, 'This machine');
  assert.ok(!fs.existsSync(path.join(tmp, 'mcp-files', 'keyed')));
});

test("a tool that runs in Loop Cloud is called there with this machine's sign-in, and nowhere else", async () => {
  const file = JSON.parse(fs.readFileSync(path.join(tmp, 'mcp-hub.json'), 'utf8'));
  const work = hub.state().envs[0];
  const servers = { ...file.servers };
  // As the cloud sends one: an address on Loop Cloud, and no key at all.
  servers.cloudy = { name: 'Cloudy', kind: 'http', url: `${cloudBase}/api/gw/cloudy`, viaCloud: true, on: 'Some other machine' };
  // A document that has been tampered with: marked the same way, pointing somewhere else.
  servers.stray = { name: 'Stray', kind: 'http', url: webUrl, viaCloud: true };
  servers.lookalike = { name: 'Lookalike', kind: 'http', url: `${cloudBase}.example.com/api/gw/x`, viaCloud: true };
  hub.adopt({ at: Date.now() + 120000, servers, envs: { [work.id]: { name: work.name, only: true, servers: [...work.servers, 'cloudy', 'stray'] } } }, 'This machine');

  const by = Object.fromEntries(hub.state().servers.map((s) => [s.key, s]));
  assert.strictEqual(by.cloudy.viaCloud, true);
  assert.strictEqual(by.cloudy.ask, false, 'nothing of it runs here, so there is nothing to allow');
  assert.strictEqual(by.cloudy.here, true, 'it is on every machine, whatever the document says about one');
  assert.strictEqual(by[sumsKey] ? by[sumsKey].viaCloud : false, false);

  assert.deepStrictEqual((await hub.test('cloudy')).tools, ['far']);
  const ran = await rpc('proj-b', 'tools/call', { name: 'cloudy__far', arguments: {} });
  assert.strictEqual(ran.content[0].text, 'from the cloud');
  assert.ok(cloudSaw.length >= 3 && cloudSaw.every((c) => c.auth === 'Bearer machine-sign-in' && c.url === '/api/gw/cloudy'), 'every call carried the sign-in');

  // The sign-in is never sent to an address outside Loop Cloud.
  sawToken = '';
  const calls = cloudSaw.length;
  for (const key of ['stray', 'lookalike']) {
    const out = await hub.test(key);
    assert.strictEqual(out.ok, false);
    assert.match(out.error, /somewhere else/);
    assert.ok(!out.error.includes('machine-sign-in'));
  }
  assert.strictEqual(sawToken, '', 'the other address was not called at all');
  assert.strictEqual(cloudSaw.length, calls);
  assert.ok(!JSON.stringify(hub.state()).includes('machine-sign-in'), 'a window never sees the sign-in');
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
  assert.deepStrictEqual(by.hosted.envNames, ['TOKEN']);
  assert.strictEqual(hub.importClaude(file).added, 0);
});

test('command lines and key lists are read the way people type them', () => {
  assert.deepStrictEqual(hub.words('npx -y "@scope/pkg name" --flag'), ['npx', '-y', '@scope/pkg name', '--flag']);
  assert.deepStrictEqual(hub.pairs('A=1\nB: two words\n\nC', { C: 'kept' }), { A: '1', B: 'two words', C: 'kept' });
});
