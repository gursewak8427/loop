// Plan limits for the status bar, with the network answered here.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const limits = require('../src/main/limits');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-limits-'));
const claudeDir = path.join(tmp, 'claude');
const codexDir = path.join(tmp, 'codex');
fs.mkdirSync(claudeDir, { recursive: true });
fs.mkdirSync(codexDir, { recursive: true });
limits.init({ claudeHome: () => claudeDir, claudeJson: () => path.join(claudeDir, '.claude.json'), codexHome: () => codexDir });
fs.writeFileSync(path.join(claudeDir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'me@example.com' } }));

const realFetch = global.fetch;
let asked = [];
let reply = () => ({ status: 200, body: {} });
test.beforeEach(() => {
  asked = [];
  global.fetch = async (url, opts) => {
    asked.push({ url, headers: opts.headers });
    const r = reply(url);
    return { ok: r.status === 200, status: r.status, json: async () => r.body };
  };
});
test.after(() => {
  global.fetch = realFetch;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const jwt = (exp) => `x.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.y`;

test("Claude: the account's own sign-in is used, and the limits list becomes windows", async () => {
  fs.writeFileSync(path.join(claudeDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'tok-a', expiresAt: Date.now() + 3600e3, subscriptionType: 'max' } }));
  reply = () => ({
    status: 200,
    body: {
      limits: [
        { kind: 'session', group: 'session', percent: 34, resets_at: '2026-11-12T12:00:00Z' },
        { kind: 'weekly_all', group: 'weekly', percent: 16, resets_at: '2026-11-15T17:00:00Z' },
        { kind: 'weekly_scoped', group: 'weekly', percent: 2, resets_at: '2026-11-15T17:00:00Z', scope: { model: { display_name: 'Fable' } } },
      ],
    },
  });
  const d = await limits.get('claude', 'a1');
  assert.strictEqual(asked[0].url, 'https://api.anthropic.com/api/oauth/usage');
  assert.strictEqual(asked[0].headers.Authorization, 'Bearer tok-a');
  assert.strictEqual(d.plan, 'max');
  assert.strictEqual(d.email, 'me@example.com', 'the login is named, so two accounts on one login show it');
  assert.deepStrictEqual(
    d.windows.map((w) => [w.label, w.used, w.length]),
    [
      ['5h', 34, 5 * 3600e3],
      ['week', 16, 7 * 86400e3],
      ['Fable week', 2, 7 * 86400e3],
    ],
  );
  assert.strictEqual(d.windows[0].resetsAt, Date.parse('2026-11-12T12:00:00Z'));
});

test('a second look within a minute is answered from memory', async () => {
  await limits.get('claude', 'a1');
  assert.strictEqual(asked.length, 0);
});

test('a sign-in that has run out is not used or renewed; the last figures stay, marked old', async () => {
  fs.writeFileSync(path.join(claudeDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'old', expiresAt: Date.now() - 1000 } }));
  const fresh = await limits.get('claude', 'a2');
  assert.strictEqual(asked.length, 0, 'nothing sent with a token that has run out');
  assert.strictEqual(fresh.error, 'expired');
});

test('Codex: the sign-in in its home is used, and both windows are read', async () => {
  fs.writeFileSync(path.join(codexDir, 'auth.json'), JSON.stringify({ tokens: { access_token: jwt(Date.now() / 1000 + 3600), account_id: 'acc-1' } }));
  reply = () => ({
    status: 200,
    body: {
      plan_type: 'plus',
      rate_limit: {
        primary_window: { used_percent: 41, limit_window_seconds: 18000, reset_at: 1797054748 },
        secondary_window: { used_percent: 12, limit_window_seconds: 604800, reset_at: 1797454748 },
      },
    },
  });
  const d = await limits.get('codex', 'default');
  assert.strictEqual(asked[0].url, 'https://chatgpt.com/backend-api/wham/usage');
  assert.strictEqual(asked[0].headers['ChatGPT-Account-Id'], 'acc-1');
  assert.deepStrictEqual(
    d.windows.map((w) => [w.label, w.used, w.resetsAt]),
    [
      ['5h', 41, 1797054748000],
      ['week', 12, 1797454748000],
    ],
  );
});

test('window lengths read as people say them', () => {
  assert.strictEqual(limits.lengthName(18000), '5h');
  assert.strictEqual(limits.lengthName(604800), 'week');
  assert.strictEqual(limits.lengthName(2592000), 'month');
  assert.strictEqual(limits.lengthName(86400), '1d');
});

test('agents without plan limits answer so, without asking anyone', async () => {
  const d = await limits.get('kimi', 'default');
  assert.ok(d.error);
  assert.strictEqual(asked.length, 0);
});
