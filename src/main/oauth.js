// Signing in to a tool server the way the MCP standard describes (OAuth 2.1
// with PKCE): ask the server where its sign-in lives, register Loop there,
// send the person to its sign-in page, and trade what comes back for a token.
//
// This file is kept the same in cloud/oauth.js and src/main/oauth.js.
//
// Nothing is stored here and nothing is fetched directly: every call goes
// through `req(url, { method, headers, body })`, which answers
// { status, headers, text } with header names in lower case. Loop Cloud passes
// one that refuses private addresses; the app passes a plain one.
const crypto = require('crypto');

const b64u = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const parse = (r) => {
  try {
    return JSON.parse(r.text);
  } catch {
    return null;
  }
};
const isWeb = (u) => {
  try {
    return /^https?:$/.test(new URL(u).protocol);
  } catch {
    return false;
  }
};

async function getJson(req, url) {
  if (!isWeb(url)) return null;
  try {
    const r = await req(url, { method: 'GET', headers: { Accept: 'application/json' } });
    return r.status === 200 ? parse(r) : null;
  } catch {
    return null;
  }
}

// Where a "well-known" document for an address may be: with its path after
// the well-known part, at the root, and (the older way) after its path.
function wellKnown(base, name) {
  const u = new URL(base);
  const p = u.pathname.replace(/\/+$/, '');
  return [...new Set([p ? `${u.origin}/.well-known/${name}${p}` : '', `${u.origin}/.well-known/${name}`, p ? `${u.origin}${p}/.well-known/${name}` : ''].filter(Boolean))];
}

// Asks the tool server, with no token, whether it wants a sign-in and where.
// { needed: false } when it answers without one.
async function discover(req, url) {
  const hello = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'Loop', version: '1' } } };
  const probe = await req(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify(hello) });
  if (probe.status !== 401) return { needed: false, status: probe.status };
  const www = String(probe.headers['www-authenticate'] || '');
  const named = /resource_metadata="?([^",\s]+)"?/i.exec(www);
  const asked = /scope="([^"]*)"/i.exec(www);
  let pr = null;
  for (const c of [named && named[1], ...wellKnown(url, 'oauth-protected-resource')].filter(Boolean)) {
    const j = await getJson(req, c);
    if (j && Array.isArray(j.authorization_servers) && j.authorization_servers.length) {
      pr = j;
      break;
    }
  }
  const issuer = pr ? String(pr.authorization_servers[0]) : new URL(url).origin;
  if (!isWeb(issuer)) throw new Error('It names a sign-in service that is not a web address.');
  let as = null;
  for (const c of [...wellKnown(issuer, 'oauth-authorization-server'), ...wellKnown(issuer, 'openid-configuration')]) {
    const j = await getJson(req, c);
    if (j && j.authorization_endpoint && j.token_endpoint) {
      as = j;
      break;
    }
  }
  if (!as) {
    if (pr) throw new Error('It asks for a sign-in, but its sign-in service does not say how.');
    // The first version of the standard: fixed paths on the server itself.
    const o = new URL(url).origin;
    as = { authorization_endpoint: `${o}/authorize`, token_endpoint: `${o}/token`, registration_endpoint: `${o}/register` };
  }
  if (!isWeb(as.authorization_endpoint) || !isWeb(as.token_endpoint)) throw new Error('Its sign-in service gave an address that is not a web address.');
  let scopes = asked ? asked[1] : Array.isArray(pr && pr.scopes_supported) ? pr.scopes_supported.join(' ') : '';
  // Where the sign-in service has it, ask to stay signed in: without it the
  // token cannot be renewed and the person signs in again every hour or so.
  if (scopes && Array.isArray(as.scopes_supported) && as.scopes_supported.includes('offline_access') && !scopes.split(' ').includes('offline_access')) scopes += ' offline_access';
  return { needed: true, authorize: String(as.authorization_endpoint), token: String(as.token_endpoint), register: isWeb(as.registration_endpoint) ? String(as.registration_endpoint) : '', scope: String(scopes).slice(0, 2000), resource: String((pr && pr.resource) || url) };
}

// Starts a sign-in. Answers { needed: false }, or { needed: true, url, state,
// pending }: send the person to url, keep pending, and give it to finish()
// with the code that comes back to `redirect`.
// opts.clientId / opts.clientSecret: for a service where Loop was registered by hand.
async function begin(req, url, redirect, opts = {}) {
  const d = await discover(req, url);
  if (!d.needed) return d;
  let clientId = String(opts.clientId || '').trim();
  let clientSecret = String(opts.clientSecret || '');
  let basic = false; // the service wants its secret in a header, not in the form
  if (!clientId) {
    if (!d.register) throw new Error('This service does not let an app register itself. Register Loop with it by hand, then give the client ID it hands you.');
    const body = { client_name: 'Loop', redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', ...(d.scope ? { scope: d.scope } : {}) };
    const r = await req(d.register, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
    const j = parse(r);
    if (r.status < 200 || r.status >= 300 || !j || !j.client_id) {
      const why = j && (j.error_description || j.error) ? String(j.error_description || j.error).slice(0, 160).replace(/[.\s]+$/, '') : '';
      const e = new Error(`Its sign-in service would not register Loop${why ? `: ${why}` : ` (it answered ${r.status})`}.`);
      // .redirect: it is the address to come back to that it will not have,
      // which a service does when it lets only an app on a computer sign in.
      e.redirect = Boolean(j && (j.error === 'invalid_redirect_uri' || /redirect/i.test(why)));
      e.register = true;
      throw e;
    }
    clientId = String(j.client_id);
    clientSecret = String(j.client_secret || '');
    basic = Boolean(clientSecret) && j.token_endpoint_auth_method === 'client_secret_basic';
  }
  const verifier = b64u(crypto.randomBytes(32));
  const state = b64u(crypto.randomBytes(24));
  const a = new URL(d.authorize);
  a.searchParams.set('response_type', 'code');
  a.searchParams.set('client_id', clientId);
  a.searchParams.set('redirect_uri', redirect);
  a.searchParams.set('state', state);
  a.searchParams.set('code_challenge', b64u(crypto.createHash('sha256').update(verifier).digest()));
  a.searchParams.set('code_challenge_method', 'S256');
  a.searchParams.set('resource', d.resource);
  if (d.scope) a.searchParams.set('scope', d.scope);
  return { needed: true, url: a.toString(), state, pending: { verifier, redirect, token: d.token, clientId, clientSecret, ...(basic ? { basic } : {}), resource: d.resource, origin: new URL(url).origin } };
}

async function tokenCall(req, p, form) {
  const body = new URLSearchParams({ ...form, client_id: p.clientId, ...(p.clientSecret && !p.basic ? { client_secret: p.clientSecret } : {}), ...(p.resource ? { resource: p.resource } : {}) }).toString();
  const enc = (t) => encodeURIComponent(t).replace(/%20/g, '+');
  const r = await req(p.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', ...(p.basic ? { Authorization: `Basic ${Buffer.from(`${enc(p.clientId)}:${enc(p.clientSecret)}`).toString('base64')}` } : {}) }, body });
  const j = parse(r);
  if (r.status !== 200 || !j || !j.access_token) {
    const e = new Error(`Its sign-in service refused${j && (j.error_description || j.error) ? `: ${String(j.error_description || j.error).slice(0, 160)}` : ` (it answered ${r.status})`}.`);
    e.refused = r.status >= 400 && r.status < 500;
    throw e;
  }
  return { access: String(j.access_token), refresh: String(j.refresh_token || form.refresh_token || ''), expires: Number(j.expires_in) > 0 ? Date.now() + Number(j.expires_in) * 1000 : 0 };
}

// The sign-in a tool keeps, from the code its service sent back.
async function finish(req, pending, code) {
  const t = await tokenCall(req, pending, { grant_type: 'authorization_code', code: String(code), redirect_uri: pending.redirect, code_verifier: pending.verifier });
  return { type: 'oauth', token: pending.token, clientId: pending.clientId, clientSecret: pending.clientSecret, ...(pending.basic ? { basic: true } : {}), resource: pending.resource, origin: pending.origin, ...t };
}

// A fresh token from the stored one. Throws (with .refused) when the service
// wants the person to sign in again.
async function renew(req, auth) {
  if (!auth || !auth.refresh) {
    const e = new Error('Its sign-in has run out.');
    e.refused = true;
    throw e;
  }
  return { ...auth, ...(await tokenCall(req, auth, { grant_type: 'refresh_token', refresh_token: auth.refresh })) };
}

const signedIn = (auth) => Boolean(auth && auth.type === 'oauth' && auth.access);
// True a minute before the token runs out.
const stale = (auth) => Boolean(auth && auth.expires && Date.now() > auth.expires - 60e3);

module.exports = { discover, begin, finish, renew, signedIn, stale, wellKnown };
