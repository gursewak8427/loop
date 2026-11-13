const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const bridge = require('../src/main/llm-bridge');
const llms = require('../src/main/llms');

const openai = { name: 'Fake', protocol: 'openai', baseUrl: 'http://127.0.0.1:1/v1', model: 'fake-1', key: 'real-key' };

test('a request becomes OpenAI chat, with tool calls and answers in the right order', () => {
  const { request } = bridge.toOpenAI(
    {
      stream: true,
      max_tokens: 32000,
      temperature: 1,
      system: [{ type: 'text', text: 'Be brief.', cache_control: { type: 'ephemeral' } }],
      messages: [
        { role: 'user', content: 'List files' },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'hm', signature: 'x' }, { type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'a.txt' }] }, { type: 'text', text: 'and?' }] },
      ],
      tools: [{ name: 'Bash', description: 'Run', input_schema: { $schema: 'x', type: 'object', properties: { command: { type: 'string' } } } }],
    },
    openai,
  );
  assert.strictEqual(request.model, 'fake-1');
  assert.strictEqual(request.max_tokens, undefined, 'left to the provider');
  assert.strictEqual(request.temperature, undefined, 'left to the provider');
  assert.deepStrictEqual(request.messages.map((m) => m.role), ['system', 'user', 'assistant', 'tool', 'user']);
  assert.strictEqual(request.messages[0].content, 'Be brief.');
  assert.strictEqual(request.messages[2].content, 'Looking.');
  assert.deepStrictEqual(request.messages[2].tool_calls[0].function, { name: 'Bash', arguments: '{"command":"ls"}' });
  assert.deepStrictEqual(request.messages[3], { role: 'tool', tool_call_id: 't1', content: 'a.txt' });
  assert.strictEqual(request.tools[0].function.parameters.$schema, undefined);
});

test('user messages side by side are joined, because some providers refuse them', () => {
  const { request } = bridge.toOpenAI({ messages: [{ role: 'user', content: 'first' }, { role: 'user', content: [{ type: 'text', text: 'second' }] }] }, openai);
  assert.deepStrictEqual(request.messages, [{ role: 'user', content: 'first\n\nsecond' }]);
  const img = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA' } };
  const mixed = bridge.toOpenAI({ messages: [{ role: 'user', content: 'look' }, { role: 'user', content: [img] }] }, openai).request;
  assert.strictEqual(mixed.messages.length, 1);
  assert.deepStrictEqual(mixed.messages[0].content.map((p) => p.type), ['text', 'image_url']);
});

test('a turn that was only thinking is left out', () => {
  const { request } = bridge.toOpenAI({ messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'hm' }] }, { role: 'user', content: 'hi' }] }, openai);
  assert.deepStrictEqual(request.messages.map((m) => m.role), ['user']);
});

test('long tool names are shortened and come back whole; too many tools are cut, MCP first', () => {
  const long = 'mcp__' + 'x'.repeat(80) + '__do.it';
  const alias = bridge.toolAlias(long);
  assert.ok(alias.length <= 64 && /^[a-zA-Z0-9_-]+$/.test(alias), alias);
  const schema = { type: 'object', properties: {} };
  const tools = [...Array.from({ length: 200 }, (_, i) => ({ name: `mcp__t__${i}`, input_schema: schema })), { name: 'Bash', input_schema: schema }, { name: long, input_schema: schema }];
  const { request, names } = bridge.toOpenAI({ messages: [], tools }, openai);
  assert.strictEqual(request.tools.length, 128);
  assert.strictEqual(request.tools[0].function.name, 'Bash');
  const small = bridge.toOpenAI({ messages: [], tools: [{ name: long, input_schema: schema }] }, openai);
  assert.strictEqual(small.names.get(alias), long);
  assert.ok(names instanceof Map);
});

test('schemas are cleaned for Gemini, without touching parameters that share a keyword name', () => {
  const out = bridge.cleanSchema({ $schema: 's', type: 'object', additionalProperties: false, properties: { default: { type: 'string', format: 'uri', default: 'a' }, kind: { const: 'x' } } }, true);
  assert.deepStrictEqual(out, { type: 'object', properties: { default: { type: 'string' }, kind: { enum: ['x'] } } });
});

function collect(run) {
  const events = [];
  const s = new bridge.Streamer(new Map([['short', 'mcp__long.name']]), 'fake-1', (t) => {
    const [e, d] = t.trim().split('\n');
    events.push({ event: e.slice(7), data: JSON.parse(d.slice(6)) });
  });
  run(s);
  return events;
}
const sse = (o) => `data: ${JSON.stringify(o)}\n\n`;

test('a stream of words and split-up tool calls becomes well-formed Anthropic events', () => {
  const events = collect((s) => {
    s.feed(sse({ choices: [{ delta: { content: 'Hel' } }] }) + sse({ choices: [{ delta: { content: 'lo' } }] }).slice(0, 10));
    s.feed(sse({ choices: [{ delta: { content: 'lo' } }] }).slice(10));
    s.feed(sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'short', arguments: '{"a"' } }] } }] }));
    s.feed(sse({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'c2', function: { name: 'Bash', arguments: '{"b":2}' } }] } }] }));
    s.feed(sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] }, finish_reason: 'tool_calls' }] }));
    s.feed(sse({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 3 } }) + 'data: [DONE]\n\n');
    s.end();
  });
  assert.deepStrictEqual(events.map((e) => e.event), [
    'message_start',
    'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop',
    'content_block_start', 'content_block_delta', 'content_block_stop',
    'content_block_start', 'content_block_delta', 'content_block_stop',
    'message_delta', 'message_stop',
  ]);
  assert.strictEqual(events[5].data.index, 1);
  assert.strictEqual(events[5].data.content_block.name, 'mcp__long.name');
  assert.strictEqual(events[6].data.delta.partial_json, '{"a":1}');
  assert.strictEqual(events[8].data.index, 2);
  assert.strictEqual(events[11].data.delta.stop_reason, 'tool_use');
  assert.strictEqual(events[11].data.usage.input_tokens, 10);
  assert.strictEqual(events[11].data.usage.output_tokens, 3);
});

test('Gemini: whole calls under one index stay separate, and the signature goes back next turn', () => {
  const events = collect((s) => {
    s.feed(sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'g1', extra_content: { google: { thought_signature: 'SIG' } }, function: { name: 'A', arguments: '{}' } }] } }] }));
    s.feed(sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'g2', function: { name: 'B', arguments: '{}' } }] }, finish_reason: 'stop' }] }));
    s.end();
  });
  assert.deepStrictEqual(events.filter((e) => e.event === 'content_block_start').map((e) => e.data.content_block.id), ['g1', 'g2']);
  assert.strictEqual(events.find((e) => e.event === 'message_delta').data.delta.stop_reason, 'tool_use');
  const { request } = bridge.toOpenAI({ messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'g1', name: 'A', input: {} }] }] }, { ...openai, preset: 'gemini' });
  assert.deepStrictEqual(request.messages[0].tool_calls[0].extra_content, { google: { thought_signature: 'SIG' } });
});

test('broken tool arguments do not break the stream', () => {
  const events = collect((s) => {
    s.feed(sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'A', arguments: '{oops' } }] } }] }));
    s.end();
  });
  assert.strictEqual(events.find((e) => e.data.delta && e.data.delta.type === 'input_json_delta').data.delta.partial_json, '{}');
});

// A provider on this PC, so a whole request can be followed through the bridge.
function provider(handle) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
      handle(req, res, seen[seen.length - 1]);
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() })));
}

async function through(llm, opts = {}) {
  const b = bridge.create((id) => (id === 'abc' ? llm : null));
  const port = await b.start();
  const r = await fetch(`http://127.0.0.1:${port}/${opts.id || 'abc'}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.token ?? b.token}` },
    body: JSON.stringify({ model: 'claude-sonnet', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }], ...opts.body }),
  });
  const text = await r.text();
  b.stop();
  return { status: r.status, text };
}

test('the bridge turns away anyone without its token', async () => {
  const r = await through(openai, { token: 'wrong' });
  assert.strictEqual(r.status, 401);
});

test('a saved key that cannot be read is reported, not left hanging', async () => {
  const b = bridge.create(() => {
    throw new Error('decrypt failed');
  });
  const port = await b.start();
  const r = await fetch(`http://127.0.0.1:${port}/abc/v1/messages`, { method: 'POST', headers: { authorization: `Bearer ${b.token}` }, body: '{}' });
  const body = await r.json();
  b.stop();
  assert.strictEqual(r.status, 500);
  assert.match(body.error.message, /could not be read/);
});

test('the bridge adds the real key, uses the chosen model, and answers in Anthropic form', async () => {
  const p = await provider((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'Hi there' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 2 } }));
  });
  const r = await through({ ...openai, baseUrl: `${p.url}/v1` });
  p.close();
  assert.strictEqual(p.seen[0].url, '/v1/chat/completions');
  assert.strictEqual(p.seen[0].headers.authorization, 'Bearer real-key');
  assert.strictEqual(p.seen[0].body.model, 'fake-1');
  const out = JSON.parse(r.text);
  assert.deepStrictEqual(out.content, [{ type: 'text', text: 'Hi there' }]);
  assert.strictEqual(out.stop_reason, 'end_turn');
});

test('a provider that refuses stream_options is asked again without it', async () => {
  const p = await provider((req, res, got) => {
    if (got.body.stream_options) {
      res.writeHead(400);
      return res.end('{"error":{"message":"unknown field"}}');
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sse({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }));
  });
  const r = await through({ ...openai, baseUrl: `${p.url}/v1` }, { body: { stream: true } });
  p.close();
  assert.strictEqual(p.seen.length, 2);
  assert.match(r.text, /"text":"ok"/);
});

test('what the provider says went wrong reaches the session', async () => {
  const p = await provider((req, res) => {
    res.writeHead(401);
    res.end('{"error":{"message":"bad key"}}');
  });
  const r = await through({ ...openai, baseUrl: `${p.url}/v1` });
  p.close();
  assert.strictEqual(r.status, 401);
  const e = JSON.parse(r.text);
  assert.strictEqual(e.error.type, 'authentication_error');
  assert.match(e.error.message, /Fake answered 401: bad key/);
});

test('an Anthropic-format provider gets the request as it is, with the real key and model', async () => {
  const p = await provider((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"id":"m","content":[]}');
  });
  const r = await through({ ...openai, protocol: 'anthropic', baseUrl: `${p.url}/anthropic` });
  p.close();
  assert.strictEqual(p.seen[0].url, '/anthropic/v1/messages');
  assert.strictEqual(p.seen[0].headers['x-api-key'], 'real-key');
  assert.strictEqual(p.seen[0].body.model, 'fake-1');
  assert.strictEqual(p.seen[0].body.max_tokens, 10);
  assert.strictEqual(r.text, '{"id":"m","content":[]}');
});

// ---- the saved list ----

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-llms-'));
const crypt = { encrypt: (t) => Buffer.from(t).toString('hex'), decrypt: (h) => Buffer.from(h, 'hex').toString() };
test.after(() => {
  llms.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a key is stored encrypted, never shown to the window, and kept when left blank', () => {
  llms.init(dir, crypt);
  const made = llms.save({ name: 'Grok', preset: 'grok', baseUrl: 'https://api.x.ai/v1/', model: 'grok-x', key: 'xai-SECRET' });
  assert.strictEqual(made.baseUrl, 'https://api.x.ai/v1');
  assert.strictEqual(made.hasKey, true);
  assert.ok(!JSON.stringify(llms.all()).includes('SECRET'));
  assert.ok(!fs.readFileSync(path.join(dir, 'llms.json'), 'utf8').includes('xai-SECRET'));
  llms.save({ id: made.id, name: 'Grok 2', preset: 'grok', baseUrl: 'https://api.x.ai/v1', model: 'grok-y', key: '' });
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'llms.json'), 'utf8')).list[0];
  assert.strictEqual(crypt.decrypt(saved.key), 'xai-SECRET');
  assert.strictEqual(saved.name, 'Grok 2');
  llms.remove(made.id);
  assert.deepStrictEqual(llms.all(), []);
});

test('a key is refused over plain http to the internet, and allowed on this PC', () => {
  llms.init(dir, crypt);
  assert.throws(() => llms.save({ name: 'X', baseUrl: 'http://example.com/v1', model: 'm', key: 'k' }), /plain http/);
  assert.throws(() => llms.save({ name: 'X', baseUrl: 'nope', model: 'm' }), /web address/);
  assert.throws(() => llms.save({ name: '', baseUrl: 'https://a.b', model: 'm' }), /name/);
  assert.throws(() => llms.save({ name: 'X', baseUrl: 'https://a.b', model: '' }), /model/);
  const local = llms.save({ name: 'Local', baseUrl: 'http://127.0.0.1:11434/v1', model: 'm', key: 'k' });
  llms.remove(local.id);
});

test('the session choice beats the project; "claude" keeps a session on Claude', () => {
  const config = { sessionLlm: { s1: 'aaa', s2: 'claude' }, projectLlm: { d: 'bbb' } };
  assert.strictEqual(llms.pick(config, 'd', 's1'), 'aaa');
  assert.strictEqual(llms.pick(config, 'd', 's2'), '');
  assert.strictEqual(llms.pick(config, 'd', 's3'), 'bbb');
  assert.strictEqual(llms.pick(config, 'other', 's3'), '');
  assert.strictEqual(llms.pick({}, 'd', 's1'), '');
});

test('a session is given the bridge and its token, never the real key', async () => {
  llms.init(dir, crypt);
  await llms.start();
  const m = llms.save({ name: 'Grok', preset: 'grok', baseUrl: 'https://api.x.ai/v1', model: 'grok-x', key: 'xai-SECRET' });
  const env = llms.envFor(m.id);
  assert.ok(!JSON.stringify(env).includes('SECRET'));
  assert.match(env.ANTHROPIC_BASE_URL, new RegExp(`^http://127\\.0\\.0\\.1:\\d+/${m.id}$`));
  assert.strictEqual(env.ANTHROPIC_MODEL, 'grok-x');
  assert.strictEqual(env.ANTHROPIC_API_KEY, '');
  assert.deepStrictEqual(llms.envFor(''), {});
  llms.remove(m.id);
  assert.throws(() => llms.envFor(m.id), /removed/);
});
