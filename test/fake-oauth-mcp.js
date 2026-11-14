// A tool server that wants a browser sign-in, for tests: the MCP address, the
// documents that say where its sign-in lives, registration, a sign-in page
// that says yes at once, and a token desk that checks the PKCE proof.
const http = require('http');
const crypto = require('crypto');

// opts.onlyLocal: like the services that let only an app on a computer sign
// in, it registers no address to come back to but an app's own on 127.0.0.1
// or localhost (/oauth/callback, which is where the Loop app listens).
async function start(opts = {}) {
  const st = { clients: new Map(), codes: new Map(), access: '', refresh: '', n: 0, registered: 0, renewed: 0 };
  let base = '';
  const json = (res, code, body, headers = {}) => {
    res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
  const issue = () => {
    st.n += 1;
    st.access = `tok-${st.n}`;
    st.refresh = `ref-${st.n}`;
    return { access_token: st.access, refresh_token: st.refresh, token_type: 'Bearer', expires_in: 3600 };
  };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, base);
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      // A caller that does not say who it is is turned away, as some services do.
      if (!req.headers['user-agent']) {
        res.writeHead(302, { Location: `${base}/unsupported` });
        return res.end();
      }
      if (req.method === 'GET' && u.pathname === '/.well-known/oauth-protected-resource/mcp') return json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ['read'] });
      if (req.method === 'GET' && u.pathname === '/.well-known/oauth-authorization-server') return json(res, 200, { issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register` });
      if (req.method === 'POST' && u.pathname === '/register') {
        const b = JSON.parse(raw);
        if (opts.onlyLocal && !b.redirect_uris.every((u) => /^http:\/\/(127\.0\.0\.1|localhost):\d+\/oauth\/callback$/.test(u))) return json(res, 400, { error: 'invalid_redirect_uri', error_description: 'That redirect URI is not in the allowlist.' });
        const id = `client-${(st.registered += 1)}`;
        st.clients.set(id, b.redirect_uris);
        return json(res, 201, { client_id: id, redirect_uris: b.redirect_uris });
      }
      if (req.method === 'GET' && u.pathname === '/authorize') {
        const q = u.searchParams;
        const uris = st.clients.get(q.get('client_id'));
        if (!uris || !uris.includes(q.get('redirect_uri')) || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge') || q.get('response_type') !== 'code') return json(res, 400, { error: 'invalid_request' });
        const code = crypto.randomBytes(8).toString('hex');
        st.codes.set(code, { client: q.get('client_id'), redirect: q.get('redirect_uri'), challenge: q.get('code_challenge') });
        const back = new URL(q.get('redirect_uri'));
        back.searchParams.set('code', code);
        back.searchParams.set('state', q.get('state'));
        res.writeHead(302, { Location: back.toString() });
        return res.end();
      }
      if (req.method === 'POST' && u.pathname === '/token') {
        const f = new URLSearchParams(raw);
        if (f.get('grant_type') === 'authorization_code') {
          const c = st.codes.get(f.get('code'));
          st.codes.delete(f.get('code'));
          const proof = crypto.createHash('sha256').update(String(f.get('code_verifier'))).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
          if (!c || c.client !== f.get('client_id') || c.redirect !== f.get('redirect_uri') || c.challenge !== proof) return json(res, 400, { error: 'invalid_grant' });
          return json(res, 200, issue());
        }
        if (f.get('grant_type') === 'refresh_token') {
          if (!st.refresh || f.get('refresh_token') !== st.refresh) return json(res, 400, { error: 'invalid_grant' });
          st.renewed += 1;
          return json(res, 200, issue());
        }
        return json(res, 400, { error: 'unsupported_grant_type' });
      }
      if (req.method === 'POST' && u.pathname === '/mcp') {
        if (!st.access || req.headers.authorization !== `Bearer ${st.access}`) {
          res.writeHead(401, { 'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` });
          return res.end();
        }
        const m = JSON.parse(raw);
        if (m.id === undefined) return res.writeHead(202).end();
        const result =
          m.method === 'initialize'
            ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'signed', version: '1' } }
            : m.method === 'tools/list'
              ? { tools: [{ name: 'whoami', description: 'Says who is signed in', inputSchema: { type: 'object' } }] }
              : { content: [{ type: 'text', text: `signed in with ${st.access}` }] };
        return json(res, 200, { jsonrpc: '2.0', id: m.id, result });
      }
      res.writeHead(404).end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  return {
    url: `${base}/mcp`,
    state: st,
    // The token stops working, as one does when its hour is up. The refresh one still works.
    expire: () => (st.access = 'gone'),
    // The person takes their consent back: nothing works until they sign in again.
    revoke: () => ((st.access = ''), (st.refresh = '')),
    close: () => server.close(),
  };
}

module.exports = { start };
