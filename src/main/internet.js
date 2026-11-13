// "Accessible on the internet": this machine's Loop, opened from
// loop.prismaple.com or the phone app, signed in with the same email.
//
// The getting-started steps, each checked before anything is done:
//   1. signed in to Loop Cloud (so the machine is listed on the account)
//   2. Tailscale installed
//   3. Tailscale signed in (the machine has a name on the tailnet)
//   4. Tailscale Funnel points the machine's https address at Loop
//   5. the PC kept awake while this is on
//   6. listed on the account as reachable, checked in every minute
//
// Nobody gets in by knowing the address. Opening the machine takes a one-time
// ticket from Loop Cloud, made for a viewer signed in with the same email;
// Loop checks it with the cloud and only then hands that browser a key of its
// own (kept here, 30 days, revocable by turning this off).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');

const KEY_DAYS = 30;
const BEAT = 60e3;

let file = '';
let keysFile = '';
let st = { on: false };
let keys = {}; // sha256(key) -> { exp, viewer }
let deps = null; // { cloud, shell, powerSaveBlocker, phonePort, phoneOn, onChange }
let blocker = null;
let beat = null;
let last = { steps: [], url: '', test: null, busy: '', note: '' };

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const readJson = (f, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return fallback;
  }
};
const writeJson = (f, v) => {
  try {
    fs.writeFileSync(f, JSON.stringify(v, null, 2), { mode: 0o600 });
  } catch {
    // kept in memory until the next write
  }
};

const TAILSCALE = [
  path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe'),
  '/usr/bin/tailscale',
  '/usr/local/bin/tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
];
const tailscaleExe = () => TAILSCALE.find((p) => fs.existsSync(p)) || '';

function ts(args, timeout = 20e3) {
  const exe = tailscaleExe();
  if (!exe) return Promise.resolve({ code: -1, out: '', err: 'Tailscale is not installed' });
  return new Promise((resolve) => {
    execFile(exe, args, { windowsHide: true, timeout }, (err, out, errOut) => resolve({ code: err ? err.code || 1 : 0, out: String(out || ''), err: String(errOut || '') }));
  });
}
const urlIn = (text) => (/(https:\/\/login\.tailscale\.com\/\S+)/.exec(text) || [])[1] || '';

async function tailnet() {
  const r = await ts(['status', '--json'], 8e3);
  try {
    const j = JSON.parse(r.out);
    const dns = String((j.Self && j.Self.DNSName) || '').replace(/\.$/, '');
    return { running: j.BackendState === 'Running', dns, authUrl: j.AuthURL || '' };
  } catch {
    return { running: false, dns: '', authUrl: '' };
  }
}

// Whether the machine's https address on 443 goes to Loop and is open to the internet.
async function funnelState(dns, port) {
  const r = await ts(['funnel', 'status', '--json'], 8e3);
  try {
    const j = JSON.parse(r.out || '{}');
    const host = `${dns}:443`;
    const web = (j.Web || {})[host];
    const proxy = String((((web || {}).Handlers || {})['/'] || {}).Proxy || '');
    const ours = new RegExp(`:${port}/?$`).test(proxy);
    const open = Boolean((j.AllowFunnel || {})[host]);
    return { ours, open, other: proxy && !ours ? proxy : '' };
  } catch {
    return { ours: false, open: false, other: '' };
  }
}

const url = () => last.url;

async function check() {
  const c = deps.cloud.state();
  const exe = tailscaleExe();
  const net = exe ? await tailnet() : { running: false, dns: '' };
  const port = deps.phonePort();
  const fun = net.running && net.dns ? await funnelState(net.dns, port) : { ours: false, open: false, other: '' };
  last.url = net.dns ? `https://${net.dns}` : '';
  const funnelOk = fun.ours && fun.open;
  last.steps = [
    { key: 'cloud', label: 'Signed in to Loop Cloud', ok: Boolean(c.signedIn), detail: c.signedIn ? c.email : 'Your machines are listed on your Loop Cloud account', action: c.signedIn ? '' : 'Sign in' },
    { key: 'install', label: 'Tailscale is installed', ok: Boolean(exe), detail: exe ? 'Found on this PC' : 'Tailscale gives this PC its own https address', action: exe ? '' : 'Download Tailscale' },
    { key: 'login', label: 'Tailscale is signed in', ok: net.running && Boolean(net.dns), detail: net.dns || 'Sign in once, in the browser', action: exe && !(net.running && net.dns) ? 'Sign in to Tailscale' : '' },
    {
      key: 'funnel',
      label: 'Open Loop to the internet',
      ok: funnelOk,
      detail: funnelOk ? last.url : fun.other ? `This address now goes to ${fun.other}; Loop takes it over` : 'Tailscale Funnel gives this PC a public https address for Loop',
      action: net.running && net.dns && !funnelOk ? 'Turn on' : '',
    },
    { key: 'awake', label: 'Keep this PC awake', ok: Boolean(blocker !== null && deps.powerSaveBlocker.isStarted(blocker)), detail: 'Only while remote access is on' },
    { key: 'listed', label: 'Listed on your account', ok: Boolean(st.listedAt && Date.now() - st.listedAt < BEAT * 2.5), detail: 'Shows as online at loop.prismaple.com and in the phone app' },
  ];
  last.ready = funnelOk && Boolean(c.signedIn);
  return state();
}

function state() {
  return { on: Boolean(st.on), url: last.url, steps: last.steps, ready: Boolean(last.ready), test: last.test, busy: last.busy, note: last.note, viewers: Object.values(keys).filter((k) => k.exp > Date.now()).length };
}

function changed() {
  deps.onChange(state());
}

// Every minute while on: tell Loop Cloud this machine is reachable (which also
// keeps it listed as online).
async function report() {
  if (!st.on || !last.ready) return;
  try {
    await deps.cloud.setRemote({ on: true, url: last.url, os: `${os.type() === 'Windows_NT' ? 'Windows' : os.type()}` });
    st.listedAt = Date.now();
  } catch (e) {
    last.note = e.message;
  }
}

async function tick() {
  if (!st.on) return;
  await check();
  await report();
  await check();
  changed();
}

async function setOn(on) {
  st.on = Boolean(on);
  writeJson(file, st);
  if (st.on) {
    if (blocker === null || !deps.powerSaveBlocker.isStarted(blocker)) blocker = deps.powerSaveBlocker.start('prevent-app-suspension');
    deps.phoneOn(true);
    clearInterval(beat);
    beat = setInterval(() => tick().catch(() => {}), BEAT);
    if (beat.unref) beat.unref();
    await tick();
  } else {
    clearInterval(beat);
    beat = null;
    if (blocker !== null && deps.powerSaveBlocker.isStarted(blocker)) deps.powerSaveBlocker.stop(blocker);
    blocker = null;
    deps.phoneOn(false);
    // Off means off: every browser's key goes, and the account shows it off.
    keys = {};
    writeJson(keysFile, keys);
    st.listedAt = 0;
    if (deps.cloud.state().signedIn) await deps.cloud.setRemote({ on: false, url: '', os: '' }).catch(() => {});
    await check();
  }
  changed();
  return state();
}

// One getting-started step's button.
async function act(key) {
  last.busy = key;
  last.note = '';
  changed();
  try {
    if (key === 'install') deps.shell.openExternal('https://tailscale.com/download');
    if (key === 'login') {
      // Tailscale prints a sign-in address; the browser opens it.
      const exe = tailscaleExe();
      const p = spawn(exe, ['up'], { windowsHide: true });
      let seen = '';
      const look = (d) => {
        seen += String(d);
        const u = urlIn(seen);
        if (u) {
          deps.shell.openExternal(u);
          last.note = 'Sign in to Tailscale in the browser page that opened.';
          changed();
        }
      };
      p.stdout.on('data', look);
      p.stderr.on('data', look);
      setTimeout(() => p.kill(), 120e3);
    }
    if (key === 'funnel') {
      const r = await ts(['funnel', '--bg', String(deps.phonePort())], 25e3);
      const u = urlIn(r.out + r.err);
      if (u) {
        // Funnel has to be allowed for the tailnet once; Tailscale's own page does it.
        deps.shell.openExternal(u);
        last.note = 'Allow Funnel in the Tailscale page that opened, then press Check again.';
      } else if (r.code !== 0) last.note = (r.err || r.out).trim().split('\n').pop() || 'Tailscale could not turn Funnel on.';
    }
  } finally {
    last.busy = '';
  }
  await tick().catch(() => {});
  await check();
  changed();
  return state();
}

async function test() {
  last.busy = 'test';
  changed();
  try {
    last.test = await deps.cloud.testRemote();
  } catch (e) {
    last.test = { ok: false, why: e.message };
  } finally {
    last.busy = '';
  }
  last.test.at = Date.now();
  changed();
  return state();
}

// A browser arrives with a ticket from Loop Cloud: checked there, then given a
// key of its own, which the phone app pairs with.
async function openTicket(ticket) {
  if (!st.on) return { ok: false, why: 'Remote access is off on this PC.' };
  if (!/^[a-f0-9]{48}$/.test(String(ticket || ''))) return { ok: false, why: 'That link is not complete.' };
  let v;
  try {
    v = await deps.cloud.redeemTicket(ticket);
  } catch (e) {
    return { ok: false, why: e.message };
  }
  const key = crypto.randomBytes(32).toString('hex');
  for (const [h, k] of Object.entries(keys)) if (k.exp < Date.now()) delete keys[h];
  keys[sha(key)] = { exp: Date.now() + KEY_DAYS * 864e5, viewer: v.viewer || 'A browser', at: Date.now() };
  writeJson(keysFile, keys);
  changed();
  const host = last.url.replace(/^https:\/\//, '');
  return { ok: true, key, host };
}

const visitorOk = (key) => {
  const k = keys[sha(String(key || '').toLowerCase())];
  return Boolean(st.on && k && k.exp > Date.now());
};

function init(userData, d) {
  deps = d;
  file = path.join(userData, 'internet.json');
  keysFile = path.join(userData, 'internet-keys.json');
  st = readJson(file, { on: false });
  keys = readJson(keysFile, {});
  // Picked up where it was: on stays on across restarts.
  if (st.on) setTimeout(() => setOn(true).catch(() => {}), 3000).unref?.();
}

function stop() {
  clearInterval(beat);
  beat = null;
}

module.exports = { init, stop, state, check, setOn, act, test, openTicket, visitorOk, url, isOn: () => Boolean(st.on), tailscaleExe };
