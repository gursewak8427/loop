// Lets a session run on a model that is not Claude. Claude Code only speaks
// Anthropic's Messages API, so it is pointed at this small server on 127.0.0.1,
// which either passes the request on (providers that speak the same API) or
// translates it to and from OpenAI's chat completions, the API that Grok,
// Gemini, OpenAI, Groq, Mistral, OpenRouter, Ollama and most others offer.
//
// The real API key is added here and never put in the session's environment:
// everything a session runs inherits that environment, and a model that is not
// trusted with the key should not be able to print it.
const http = require('http');
const crypto = require('crypto');

const MAX_TOOLS = 128; // OpenAI's limit, which others copy
const MAX_NAME = 64;

const asText = (c) => {
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c
    .filter((b) => b && b.type === 'text')
    .map((b) => b.text)
    .join('\n');
};

// A tool name some APIs would refuse is swapped for a short one, and swapped back
// on the way out. Claude Code's MCP tools run long.
function toolAlias(name) {
  const clean = String(name).replace(/[^a-zA-Z0-9_-]/g, '_');
  if (clean === name && name.length <= MAX_NAME) return name;
  const hash = crypto.createHash('sha1').update(String(name)).digest('hex').slice(0, 8);
  return `${clean.slice(0, MAX_NAME - 9)}_${hash}`;
}

// Gemini refuses much of JSON Schema, and every API dislikes $schema. Names under
// `properties` are the tool's own, so a parameter called "default" is left alone.
const GEMINI_DROPS = new Set(['additionalProperties', 'exclusiveMinimum', 'exclusiveMaximum', 'propertyNames', 'patternProperties', 'default', 'examples', '$id', '$ref', '$defs', 'definitions', 'title']);

function cleanSchema(schema, strict) {
  if (Array.isArray(schema)) return schema.map((s) => cleanSchema(s, strict));
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === '$schema') continue;
    if (strict && GEMINI_DROPS.has(k)) continue;
    if (strict && k === 'format' && !['date-time', 'enum'].includes(v)) continue;
    if (strict && k === 'const') {
      out.enum = [v];
      continue;
    }
    if (k === 'properties' && v && typeof v === 'object') out[k] = Object.fromEntries(Object.entries(v).map(([n, s]) => [n, cleanSchema(s, strict)]));
    else out[k] = cleanSchema(v, strict);
  }
  return out;
}

const isGemini = (llm) => llm.preset === 'gemini' || /generativelanguage\.googleapis\.com/.test(llm.baseUrl || '');

// Gemini hands back a signature with each tool call and refuses the next turn
// without it. Anthropic's format has nowhere to keep it, so it is kept here.
const signatures = new Map();
function remember(id, extra) {
  if (!extra) return;
  signatures.set(id, extra);
  if (signatures.size > 5000) signatures.delete(signatures.keys().next().value);
}

function imagePart(b) {
  const s = b.source || {};
  const url = s.type === 'url' ? s.url : `data:${s.media_type};base64,${s.data}`;
  return { type: 'image_url', image_url: { url } };
}

// Claude Code sends reminders as user messages of their own, right beside the
// person's. Some providers refuse two of the same role in a row, so they are joined.
function addUser(messages, parts) {
  const last = messages[messages.length - 1];
  const before = last && last.role === 'user' ? (typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content) : [];
  const all = [...before, ...parts];
  const content = all.every((p) => p.type === 'text') ? all.map((p) => p.text).join('\n\n') : all;
  if (before.length) last.content = content;
  else messages.push({ role: 'user', content });
}

// Anthropic's request as OpenAI's. Returns the request and the names to swap back.
function toOpenAI(body, llm) {
  const gemini = isGemini(llm);
  const messages = [];
  const system = asText(body.system);
  if (system) messages.push({ role: 'system', content: system });

  for (const m of body.messages || []) {
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content || [];
    if (m.role === 'assistant') {
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
      const calls = blocks
        .filter((b) => b.type === 'tool_use')
        .map((b) => {
          const call = { id: b.id, type: 'function', function: { name: toolAlias(b.name), arguments: JSON.stringify(b.input || {}) } };
          const extra = signatures.get(b.id) || (gemini ? { google: { thought_signature: 'skip_thought_signature_validator' } } : null);
          if (extra) call.extra_content = extra;
          return call;
        });
      if (!text && !calls.length) continue; // only thinking, which other models cannot read
      const out = { role: 'assistant', content: text || null };
      if (calls.length) out.tool_calls = calls;
      messages.push(out);
      continue;
    }
    // A tool's answer has to come straight after the call it answers, so those go
    // first, and anything else the person sent follows as its own message.
    const parts = [];
    for (const b of blocks) {
      if (b.type === 'tool_result') {
        const inner = Array.isArray(b.content) ? b.content : [];
        const text = typeof b.content === 'string' ? b.content : asText(inner);
        messages.push({ role: 'tool', tool_call_id: b.tool_use_id, content: (b.is_error ? 'Error: ' : '') + (text || '(no output)') });
        for (const i of inner) if (i.type === 'image') parts.push(imagePart(i));
      } else if (b.type === 'text') parts.push({ type: 'text', text: b.text });
      else if (b.type === 'image') parts.push(imagePart(b));
      else if (b.type === 'document') parts.push({ type: 'text', text: '[A document was attached here, which this model cannot read.]' });
    }
    if (parts.length) addUser(messages, parts);
  }

  // max_tokens and temperature are left to the provider: Claude Code asks for more
  // than many models allow, and some models refuse any temperature at all.
  const out = { model: llm.model, messages, stream: Boolean(body.stream) };
  if (out.stream) out.stream_options = { include_usage: true };

  const names = new Map();
  // Its own tools matter most, so if there are too many it is MCP tools that wait.
  const tools = [...(body.tools || [])].filter((t) => t.input_schema).sort((a, b) => Number(a.name.startsWith('mcp__')) - Number(b.name.startsWith('mcp__'))).slice(0, MAX_TOOLS);
  if (tools.length) {
    out.tools = tools.map((t) => {
      const alias = toolAlias(t.name);
      names.set(alias, t.name);
      return { type: 'function', function: { name: alias, description: t.description || '', parameters: cleanSchema(t.input_schema, gemini) } };
    });
    const c = body.tool_choice;
    if (c && c.type === 'any') out.tool_choice = 'required';
    else if (c && c.type === 'tool') out.tool_choice = { type: 'function', function: { name: toolAlias(c.name) } };
    else if (c && c.type === 'none') out.tool_choice = 'none';
  }
  return { request: out, names };
}

const stopReason = (finish, hasTools) => (hasTools ? 'tool_use' : finish === 'length' ? 'max_tokens' : 'end_turn');

function usageOf(u) {
  if (!u) return { input_tokens: 0, output_tokens: 0 };
  const cached = (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0;
  return { input_tokens: Math.max(0, (u.prompt_tokens || 0) - cached), output_tokens: u.completion_tokens || 0, cache_read_input_tokens: cached };
}

const newId = (prefix) => prefix + crypto.randomBytes(12).toString('hex');
const validJson = (s) => {
  try {
    const v = JSON.parse(s || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
};

// OpenAI's whole answer as Anthropic's.
function fromOpenAI(res, names, model) {
  const choice = (res.choices && res.choices[0]) || {};
  const msg = choice.message || {};
  const content = [];
  if (msg.content) content.push({ type: 'text', text: msg.content });
  for (const c of msg.tool_calls || []) {
    const id = c.id || newId('toolu_');
    remember(id, c.extra_content);
    content.push({ type: 'tool_use', id, name: names.get(c.function.name) || c.function.name, input: validJson(c.function.arguments) });
  }
  return { id: newId('msg_'), type: 'message', role: 'assistant', model, content, stop_reason: stopReason(choice.finish_reason, (msg.tool_calls || []).length > 0), stop_sequence: null, usage: usageOf(res.usage) };
}

// OpenAI's stream as Anthropic's. Words go out as they arrive. Tool calls are held
// to the end: their pieces can interleave, and Anthropic's blocks cannot.
class Streamer {
  constructor(names, model, write) {
    this.names = names;
    this.write = (event, data) => write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
    this.calls = [];
    this.byKey = new Map();
    this.block = -1;
    this.textOpen = false;
    this.finish = null;
    this.usage = null;
    this.rest = '';
    this.write('message_start', { message: { id: newId('msg_'), type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  }

  feed(text) {
    this.rest += text;
    const lines = this.rest.split('\n');
    this.rest = lines.pop();
    for (const raw of lines) this.line(raw.trim());
  }

  line(l) {
    if (!l.startsWith('data:')) return;
    const data = l.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      return;
    }
    if (chunk.error) throw new Error(chunk.error.message || JSON.stringify(chunk.error));
    if (chunk.usage) this.usage = chunk.usage;
    const choice = chunk.choices && chunk.choices[0];
    if (!choice) return;
    if (choice.finish_reason) this.finish = choice.finish_reason;
    const delta = choice.delta || {};
    if (delta.content) this.text(delta.content);
    for (const c of delta.tool_calls || []) this.call(c);
  }

  text(t) {
    if (!this.textOpen) {
      this.block++;
      this.textOpen = true;
      this.write('content_block_start', { index: this.block, content_block: { type: 'text', text: '' } });
    }
    this.write('content_block_delta', { index: this.block, delta: { type: 'text_delta', text: t } });
  }

  // Most send an index and repeat it for each piece. Gemini can send several whole
  // calls under one index, told apart only by a new id.
  call(c) {
    const key = c.index ?? c.id;
    let held = this.byKey.get(key);
    if (!held || (c.id && held.id && c.id !== held.id)) {
      held = { id: c.id || '', name: '', args: '', extra: null };
      this.byKey.set(key, held);
      this.calls.push(held);
    }
    if (c.id) held.id = c.id;
    if (c.extra_content) held.extra = c.extra_content;
    if (c.function && c.function.name) held.name += c.function.name;
    if (c.function && c.function.arguments) held.args += c.function.arguments;
  }

  end() {
    if (this.rest.trim()) this.line(this.rest.trim());
    if (this.textOpen) this.write('content_block_stop', { index: this.block });
    for (const c of this.calls) {
      const id = c.id || newId('toolu_');
      remember(id, c.extra);
      this.block++;
      this.write('content_block_start', { index: this.block, content_block: { type: 'tool_use', id, name: this.names.get(c.name) || c.name, input: {} } });
      this.write('content_block_delta', { index: this.block, delta: { type: 'input_json_delta', partial_json: JSON.stringify(validJson(c.args)) } });
      this.write('content_block_stop', { index: this.block });
    }
    this.write('message_delta', { delta: { stop_reason: stopReason(this.finish, this.calls.length > 0), stop_sequence: null }, usage: usageOf(this.usage) });
    this.write('message_stop', {});
  }
}

const errorType = (status) => ({ 400: 'invalid_request_error', 401: 'authentication_error', 403: 'permission_error', 404: 'not_found_error', 429: 'rate_limit_error' })[status] || 'api_error';

function sendError(res, status, message) {
  if (res.headersSent) {
    res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: errorType(status), message } })}\n\n`);
    return res.end();
  }
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type: errorType(status), message } }));
}

const trimUrl = (u) => String(u || '').replace(/\/+$/, '');
const bearer = (key) => (key ? { authorization: `Bearer ${key}` } : {});

// What the provider said went wrong, in a line, so it can be read in the terminal.
async function upstreamError(r, name) {
  const raw = await r.text().catch(() => '');
  let why = raw;
  try {
    const j = JSON.parse(raw);
    const e = Array.isArray(j) ? j[0] && j[0].error : j.error;
    why = (e && (e.message || e)) || j.message || raw;
  } catch {
    // not JSON; the text is the best there is
  }
  return `${name} answered ${r.status}: ${String(why).slice(0, 600)}`;
}

function postChat(llm, request, signal) {
  return fetch(`${trimUrl(llm.baseUrl)}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...bearer(llm.key) },
    body: JSON.stringify(request),
    signal,
  });
}

async function viaOpenAI(llm, body, res, signal) {
  const { request, names } = toOpenAI(body, llm);
  let r = await postChat(llm, request, signal);
  if (r.status === 400 && request.stream_options) {
    // Not every provider knows this option; usage is worth losing to get an answer.
    delete request.stream_options;
    r = await postChat(llm, request, signal);
  }
  if (!r.ok) return sendError(res, r.status, await upstreamError(r, llm.name));
  if (!body.stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(fromOpenAI(await r.json(), names, llm.model)));
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const out = new Streamer(names, llm.model, (s) => res.write(s));
  const decoder = new TextDecoder();
  for await (const piece of r.body) out.feed(decoder.decode(piece, { stream: true }));
  out.end();
  res.end();
}

async function viaAnthropic(llm, body, path, req, res, signal) {
  const r = await fetch(`${trimUrl(llm.baseUrl)}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'anthropic-version': req.headers['anthropic-version'] || '2023-06-01',
      ...(llm.key ? { 'x-api-key': llm.key } : {}),
      ...bearer(llm.key),
    },
    body: JSON.stringify({ ...body, model: llm.model }),
    signal,
  });
  if (!r.ok) return sendError(res, r.status, await upstreamError(r, llm.name));
  res.writeHead(200, { 'content-type': r.headers.get('content-type') || 'application/json' });
  for await (const piece of r.body) res.write(piece);
  res.end();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const parts = [];
    req.on('data', (d) => parts.push(d));
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

// lookup(id) gives { name, protocol, baseUrl, model, key }, or null.
function create(lookup) {
  const token = crypto.randomBytes(24).toString('hex');
  const same = (a) => {
    const x = Buffer.from(String(a || ''));
    const y = Buffer.from(token);
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  };

  const server = http.createServer(async (req, res) => {
    const given = req.headers['x-api-key'] || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!same(given)) return sendError(res, 401, 'This address is only for sessions started by Loop.');
    const m = /^\/([a-z0-9]{1,24})(\/[^?]*)/.exec(req.url || '');
    let llm;
    try {
      llm = m && lookup(m[1]);
    } catch {
      return sendError(res, 500, 'The saved API key could not be read on this PC. Enter it again under AI models.');
    }
    if (!llm) return sendError(res, 404, 'That model is no longer set up in Loop.');
    const path = m[2];
    if (req.method !== 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ type: 'model', id: llm.model, display_name: llm.name }], has_more: false }));
    }
    const abort = new AbortController();
    res.on('close', () => !res.writableFinished && abort.abort());
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (llm.protocol === 'anthropic') return await viaAnthropic(llm, body, path, req, res, abort.signal);
      if (path === '/v1/messages/count_tokens') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ input_tokens: Math.ceil(JSON.stringify(body).length / 4) }));
      }
      if (path !== '/v1/messages') return sendError(res, 404, `Loop does not pass on ${path}.`);
      return await viaOpenAI(llm, body, res, abort.signal);
    } catch (e) {
      if (abort.signal.aborted) return res.end();
      return sendError(res, 502, `Could not reach ${llm.name}: ${(e.cause && e.cause.message) || e.message}`);
    }
  });

  return {
    token,
    start: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
      }),
    port: () => (server.address() || {}).port,
    stop: () => server.close(),
  };
}

module.exports = { create, toOpenAI, fromOpenAI, Streamer, cleanSchema, toolAlias, upstreamError, trimUrl, bearer };
