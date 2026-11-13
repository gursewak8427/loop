// How much of a plan's usage limits a session's account has used, for the
// status bar. Read the same way the tools themselves read it:
//
//   Claude Code  GET api.anthropic.com/api/oauth/usage with the account's own
//                sign-in (what /usage shows): the 5-hour session, the week, and
//                the week for one model.
//   Codex        GET chatgpt.com/backend-api/wham/usage with the Codex sign-in
//                (what /status shows): a short window and a long one, by plan.
//
// Loop only reads a sign-in; it never refreshes one, so the tools' own logins are
// never disturbed. A sign-in that has run out shows the last figures it had.
const fs = require('fs');
const path = require('path');

const FRESH = 60e3; // ask again after a minute
const BACKOFF = 5 * 60e3; // after a refusal or a busy server
const cache = new Map(); // key -> { at, data, error, until }

let claudeHome = () => '';
let claudeJson = () => ''; // the account's .claude.json, which names the login
let store = ''; // userData/limits.json: the last good figures per account, kept across restarts
let codexHome = () => '';

function init(opts = {}) {
  if (opts.claudeHome) claudeHome = opts.claudeHome;
  if (opts.claudeJson) claudeJson = opts.claudeJson;
  if (opts.codexHome) codexHome = opts.codexHome;
  if (opts.file) {
    store = opts.file;
    for (const [key, view] of Object.entries(readJson(store) || {})) if (view && view.windows) cache.set(key, { at: 0, view: { ...view, stale: true }, good: view });
  }
}

function keep() {
  if (!store) return;
  const out = {};
  for (const [key, c] of cache) if (c.good) out[key] = c.good;
  try {
    fs.writeFileSync(store, JSON.stringify(out));
  } catch {
    // kept in memory until the next good read
  }
}

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

// A window as the bar draws it: how much is used, how long it is, when it resets.
const win = (key, label, used, resetsAt, length) => ({
  key,
  label,
  used: Math.max(0, Math.min(100, Math.round(Number(used) || 0))),
  resetsAt: Number(resetsAt) || 0,
  length: Number(length) || 0,
});

const H = 3600e3;
const DAY = 24 * H;

async function claude(account) {
  const creds = readJson(path.join(claudeHome(account), '.credentials.json'));
  const o = creds && creds.claudeAiOauth;
  if (!o || !o.accessToken) return { error: 'Not signed in' };
  if (o.expiresAt && o.expiresAt < Date.now() + 30e3) return { error: 'expired', plan: o.subscriptionType || '' };
  const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
    headers: { Authorization: `Bearer ${o.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'Loop' },
    signal: AbortSignal.timeout(15e3),
  });
  if (!res.ok) return { error: res.status === 401 ? 'expired' : `busy ${res.status}`, plan: o.subscriptionType || '' };
  const j = await res.json();
  const windows = [];
  const at = (s) => (s ? Date.parse(s) : 0);
  if (Array.isArray(j.limits) && j.limits.length) {
    for (const l of j.limits) {
      const name = l.scope && l.scope.model && l.scope.model.display_name;
      if (l.kind === 'session') windows.push(win('session', '5h', l.percent, at(l.resets_at), 5 * H));
      else if (l.kind === 'weekly_all') windows.push(win('week', 'week', l.percent, at(l.resets_at), 7 * DAY));
      else if (l.group === 'weekly' && name) windows.push(win(`week-${name}`, `${name} week`, l.percent, at(l.resets_at), 7 * DAY));
    }
  } else {
    if (j.five_hour) windows.push(win('session', '5h', j.five_hour.utilization, at(j.five_hour.resets_at), 5 * H));
    if (j.seven_day) windows.push(win('week', 'week', j.seven_day.utilization, at(j.seven_day.resets_at), 7 * DAY));
    if (j.seven_day_opus) windows.push(win('week-opus', 'Opus week', j.seven_day_opus.utilization, at(j.seven_day_opus.resets_at), 7 * DAY));
  }
  // Which login this is, so two accounts signed in as the same person show it.
  const who = (readJson(claudeJson(account)) || {}).oauthAccount || {};
  return { plan: o.subscriptionType || '', email: who.emailAddress || '', windows };
}

const lengthName = (sec) => {
  if (!sec) return 'window';
  const h = sec / 3600;
  if (h <= 6) return `${Math.round(h)}h`;
  if (h <= 24 * 8) return h >= 24 * 6 ? 'week' : `${Math.round(h / 24)}d`;
  return h >= 24 * 28 ? 'month' : `${Math.round(h / 24)}d`;
};

async function codex(account) {
  const auth = readJson(path.join(codexHome(account), 'auth.json'));
  const t = auth && auth.tokens;
  if (!t || !t.access_token) return { error: auth && auth.OPENAI_API_KEY ? 'API key: no plan limits' : 'Not signed in' };
  let exp = 0;
  try {
    exp = JSON.parse(Buffer.from(t.access_token.split('.')[1], 'base64url').toString()).exp * 1000;
  } catch {
    // not a token Loop can read; ask anyway
  }
  if (exp && exp < Date.now() + 30e3) return { error: 'expired' };
  const res = await fetch('https://chatgpt.com/backend-api/wham/usage', {
    headers: { Authorization: `Bearer ${t.access_token}`, 'ChatGPT-Account-Id': t.account_id || '', 'User-Agent': 'codex_cli_rs' },
    signal: AbortSignal.timeout(15e3),
  });
  if (!res.ok) return { error: res.status === 401 ? 'expired' : `busy ${res.status}` };
  const j = await res.json();
  const r = j.rate_limit || {};
  const windows = [];
  for (const [key, w] of [
    ['primary', r.primary_window],
    ['secondary', r.secondary_window],
  ]) {
    if (!w) continue;
    windows.push(win(key, lengthName(w.limit_window_seconds), w.used_percent, (w.reset_at || 0) * 1000, (w.limit_window_seconds || 0) * 1000));
  }
  return { plan: j.plan_type || '', email: j.email || '', windows, reached: Boolean(r.limit_reached) };
}

const READERS = { claude, codex };

// { plan, windows: [{ key, label, used, resetsAt, length }], at, stale } or { error }.
async function get(agent, account = 'default') {
  const read = READERS[agent];
  if (!read) return { error: 'No limits to show' };
  const key = `${agent}|${account}`;
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && (now - hit.at < FRESH || now < (hit.until || 0))) return hit.view;
  let out;
  try {
    out = await read(account);
  } catch (e) {
    out = { error: e.name === 'TimeoutError' ? 'busy timeout' : e.message };
  }
  if (out.windows) {
    const view = { ...out, at: now };
    cache.set(key, { at: now, view, good: view });
    keep();
    return view;
  }
  // Keep showing the last good figures, marked as old, and wait before asking again.
  const good = hit && hit.good;
  const view = good ? { ...good, stale: true, why: out.error } : out;
  cache.set(key, { at: now, view, good, until: now + (String(out.error).startsWith('busy') ? BACKOFF : FRESH) });
  return view;
}

module.exports = { init, get, lengthName };
