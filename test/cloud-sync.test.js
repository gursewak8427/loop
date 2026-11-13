// Two machines on one Loop Cloud account, against a real server and Postgres.
// Runs only with TEST_DATABASE_URL (and cloud/node_modules installed); CI skips it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DB = process.env.TEST_DATABASE_URL;
const skip = (!DB || !fs.existsSync(path.join(__dirname, '..', 'cloud', 'node_modules'))) && 'needs TEST_DATABASE_URL and cloud/node_modules';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-cloud-sync-'));
let server;
let mailer;

// A fresh copy of cloud.js for each machine: its state is per process.
function machine(name) {
  const key = require.resolve('../src/main/cloud');
  delete require.cache[key];
  const cloud = require('../src/main/cloud');
  const root = path.join(tmp, name, 'memory');
  const userData = path.join(tmp, name, 'userdata');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  cloud.init(userData, { root: () => root });
  return { cloud, root, userData, name };
}
const put = (m, rel, text) => {
  const full = path.join(m.root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
  // A new time, so the change is seen even within the same millisecond.
  const t = new Date(Date.now() + Math.floor(Math.random() * 1000) + 1000);
  fs.utimesSync(full, t, t);
};
const read = (m, rel) => {
  try {
    return fs.readFileSync(path.join(m.root, ...rel.split('/')), 'utf8');
  } catch {
    return null;
  }
};

async function signIn(m, email) {
  await m.cloud.sendCode(email);
  const code = mailer.lastSent().filter((x) => x.email === email).pop().code;
  await m.cloud.verify(email, code);
  // verify starts a first run of its own a moment later; wait it out.
  await new Promise((r) => setTimeout(r, 2500));
}

let A;
let B;

test.before(async () => {
  if (skip) return;
  const { Client } = require(path.join(__dirname, '..', 'cloud', 'node_modules', 'pg'));
  const c = new Client({ connectionString: DB });
  await c.connect();
  await c.query('drop table if exists backup_files, backups, files, blobs, devices, login_codes, users cascade; drop sequence if exists file_seq');
  await c.end();
  process.env.DATABASE_URL = DB;
  process.env.PORT = '0';
  process.env.NODE_ENV = 'test';
  process.env.CODE_COOLDOWN_MS = '1';
  delete process.env.SMTP_HOST;
  mailer = require('../cloud/mailer');
  server = await require('../cloud/server').start();
  process.env.LOOP_CLOUD_URL = `http://127.0.0.1:${server.address().port}`;

  A = machine('a');
  put(A, 'projects/shop/shared/checkout.md', '---\ntitle: Checkout\n---\n\nCart, then pay.\n');
  put(A, 'projects/shop/shared/deploy.md', 'Deploy with git.\n');
  put(A, 'projects/shop/sessions/dev--abc123/todo.md', 'Fix the cart.\n');
  put(A, 'projects/shop/.loop-project', '{"dir":"D--shop"}');
  put(A, 'company/style.md', 'Be brief.\n');
  put(A, '.backup-before-new-layout-x/old.md', 'not memory'); // Loop's own backups stay home
  put(A, 'projects/shop/shared/photo.png', 'not a note');
});
test.after(async () => {
  if (A) A.cloud.stop();
  if (B) B.cloud.stop();
  if (server) server.close();
  if (!skip) await require('../cloud/store').close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('signing in backs up the memory, and only the memory', { skip }, async () => {
  await signIn(A, 'sync@example.com');
  const s = A.cloud.state();
  assert.strictEqual(s.signedIn, true);
  assert.strictEqual(s.mode, 'backup');
  assert.ok(s.lastBackup > 0, s.error);
  const list = await A.cloud.backups();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].files, 5, 'notes, markers and nothing else');
});

test('a second machine brings a project in, then sync keeps it fresh', { skip }, async () => {
  B = machine('b');
  await signIn(B, 'sync@example.com');
  // A fresh machine pulls nothing on its own: a project is brought in first.
  await B.cloud.bringIn([{ folder: 'shop', dir: 'D--shop' }], true);
  B.cloud.setMode('sync');
  await new Promise((r) => setTimeout(r, 1500));
  await B.cloud.syncNow();
  assert.match(read(B, 'projects/shop/shared/checkout.md'), /Cart, then pay/);
  assert.strictEqual(JSON.parse(read(B, 'projects/shop/.loop-project')).dir, 'D--shop');
  assert.strictEqual(read(B, 'projects/shop/shared/photo.png'), null);
});

test('a change on one machine reaches the other', { skip }, async () => {
  A.cloud.setMode('sync');
  await new Promise((r) => setTimeout(r, 1500));
  put(A, 'projects/shop/shared/deploy.md', 'Deploy with git, then pull on the server.\n');
  await A.cloud.syncNow();
  await B.cloud.syncNow();
  assert.strictEqual(read(B, 'projects/shop/shared/deploy.md'), 'Deploy with git, then pull on the server.\n');
});

test('when both machines change a note, neither change is lost', { skip }, async () => {
  put(B, 'company/style.md', 'Be brief. (B)\n');
  await B.cloud.syncNow();
  put(A, 'company/style.md', 'Be brief. (A)\n');
  await A.cloud.syncNow();
  assert.strictEqual(read(A, 'company/style.md'), 'Be brief. (A)\n', "A keeps its own");
  const side = fs.readdirSync(path.join(A.root, 'company')).find((n) => n.includes('.from-cloud-'));
  assert.ok(side, 'the cloud copy sits beside it');
  assert.strictEqual(read(A, `company/${side}`), 'Be brief. (B)\n');
  await B.cloud.syncNow();
  assert.strictEqual(read(B, 'company/style.md'), 'Be brief. (A)\n');
  assert.strictEqual(read(B, `company/${side}`), 'Be brief. (B)\n');
});

test('a note deleted on one machine is set aside on the other, not deleted', { skip }, async () => {
  fs.rmSync(path.join(A.root, 'projects', 'shop', 'sessions', 'dev--abc123', 'todo.md'));
  await A.cloud.syncNow();
  await B.cloud.syncNow();
  assert.strictEqual(read(B, 'projects/shop/sessions/dev--abc123/todo.md'), null);
  const aside = path.join(B.root, '.removed-by-sync');
  const kept = fs.readdirSync(aside).map((d) => path.join(aside, d, 'projects', 'shop', 'sessions', 'dev--abc123', 'todo.md'));
  assert.ok(kept.some((f) => fs.existsSync(f) && fs.readFileSync(f, 'utf8') === 'Fix the cart.\n'));
});

test('restoring a backup puts its notes back and keeps what it replaced', { skip }, async () => {
  const [first] = (await B.cloud.backups()).slice(-1);
  const out = await B.cloud.restore(first.id);
  assert.ok(out.restored >= 2);
  assert.strictEqual(read(B, 'projects/shop/shared/deploy.md'), 'Deploy with git.\n');
  assert.strictEqual(read(B, 'projects/shop/sessions/dev--abc123/todo.md'), 'Fix the cart.\n');
  const kept = fs.readFileSync(path.join(out.keptIn, 'projects', 'shop', 'shared', 'deploy.md'), 'utf8');
  assert.strictEqual(kept, 'Deploy with git, then pull on the server.\n');
});

test('signing out from elsewhere stops this machine cleanly', { skip }, async () => {
  await A.cloud.signOut();
  assert.strictEqual(A.cloud.state().signedIn, false);
  await assert.rejects(() => A.cloud.syncNow(), /Sign in/);
  assert.ok(!fs.readFileSync(path.join(A.userData, 'cloud.json'), 'utf8').includes('lc_'), 'no token left in the file');
});

let C;
test.after(() => C && C.cloud.stop());

test('a project is recognised across machines by its git remote and brought in', { skip }, async () => {
  // B publishes a project whose marker names its git remote, as layout now writes it.
  put(B, 'projects/web/.loop-project', '{"dir":"D--old-web","remote":"https://github.com/acme/webapp.git"}');
  put(B, 'projects/web/shared/api.md', 'The API speaks JSON.\n');
  await B.cloud.syncNow();
  C = machine('c'); // a new laptop, different folder structure
  await signIn(C, 'sync@example.com');
  const held = await C.cloud.cloudProjects(true);
  const matched = C.cloud.matchProjects(held.list, [{ dir: 'C--new-site', name: 'site', remote: 'git@github.com:Acme/WebApp.git' }]);
  const web = matched.find((x) => x.folder === 'web');
  assert.strictEqual(web.match.how, 'remote');
  assert.strictEqual(web.notes, 1);
  assert.strictEqual(matched.find((x) => x.folder === 'shop').match, null, 'a project this machine lacks matches nothing');
  const out = await C.cloud.bringIn([{ folder: 'web', dir: 'C--new-site' }], true);
  assert.ok(out.added >= 1);
  assert.strictEqual(read(C, 'projects/web/shared/api.md'), 'The API speaks JSON.\n');
  assert.strictEqual(JSON.parse(read(C, 'projects/web/.loop-project')).dir, 'C--new-site', 'the marker now names this machine');
  assert.match(read(C, 'company/style.md') || '', /Be brief/);
  assert.strictEqual(read(C, 'projects/shop/shared/checkout.md'), null, 'unticked projects stay in the cloud');
});

test('sync brings this machine only the projects it has', { skip }, async () => {
  C.cloud.setMode('sync');
  await new Promise((r) => setTimeout(r, 1600));
  put(B, 'projects/shop/shared/fresh.md', 'New in shop.\n');
  put(B, 'projects/web/shared/more.md', 'New in web.\n');
  await B.cloud.syncNow();
  await C.cloud.syncNow();
  assert.strictEqual(read(C, 'projects/web/shared/more.md'), 'New in web.\n');
  assert.strictEqual(read(C, 'projects/shop/shared/fresh.md'), null);
  assert.ok(!fs.existsSync(path.join(C.root, 'projects', 'shop')), 'the unmatched project never lands here');
});

let D;
test.after(() => D && D.cloud.stop());

test('a locally created project imports specific cloud notes, by its own key', { skip }, async () => {
  put(B, 'projects/web/shared/deploy-notes.md', 'Ship from main.\n');
  put(B, 'projects/web/sessions/dev--abc123/.loop-session', '{"id":"11111111-2222-4333-8444-555555555555","dir":"D--old-web"}');
  put(B, 'projects/web/sessions/dev--abc123/standup.md', 'Dev session note.\n');
  put(B, 'projects/web/shared/loop.md', '# Project memory\n\n- [How we deploy](deploy-notes.md) — Ship from main.\n- [API shape](api.md) — The API speaks JSON.\n');
  await B.cloud.syncNow();
  D = machine('d'); // the project exists locally first, under its own name and key
  await signIn(D, 'sync@example.com');
  const got = await D.cloud.cloudNotes('web', 'D--mine');
  const by = Object.fromEntries(got.rows.map((r) => [r.rel, r]));
  assert.strictEqual(by['shared/deploy-notes.md'].title, 'How we deploy', 'titles come from the cloud index');
  assert.strictEqual(by['shared/deploy-notes.md'].state, 'new');
  assert.strictEqual(by['sessions/dev--abc123/standup.md'].group, 'dev--abc123');
  // Only one chosen note comes down, with its session marker; the rest stays up.
  const out = await D.cloud.bringNotes('web', 'D--mine', ['sessions/dev--abc123/standup.md']);
  assert.strictEqual(out.added, 1);
  assert.strictEqual(read(D, 'projects/web/sessions/dev--abc123/standup.md'), 'Dev session note.\n');
  assert.ok(read(D, 'projects/web/sessions/dev--abc123/.loop-session'), 'the session marker travels with its notes');
  assert.strictEqual(read(D, 'projects/web/shared/deploy-notes.md'), null);
  assert.strictEqual(JSON.parse(read(D, 'projects/web/.loop-project')).dir, 'D--mine');
  // Asked again, that note reads as already here; a differing local one is kept.
  const again = await D.cloud.cloudNotes('web', 'D--mine');
  assert.strictEqual(again.rows.find((r) => r.rel === 'sessions/dev--abc123/standup.md').state, 'same');
  put(D, 'projects/web/shared/api.md', 'My own words.\n');
  const two = await D.cloud.bringNotes('web', 'D--mine', ['shared/api.md']);
  assert.strictEqual(two.besides, 1);
  assert.strictEqual(read(D, 'projects/web/shared/api.md'), 'My own words.\n', 'the local note stays');
  const names = fs.readdirSync(path.join(D.root, 'projects', 'web', 'shared'));
  assert.ok(names.some((n) => n.includes('.from-cloud-')), "the cloud's copy sits beside it");
});

test('once brought in, the project is recognised by its memory folder name', { skip }, async () => {
  const held = await D.cloud.cloudProjects(true);
  const matched = D.cloud.matchProjects(held.list, [{ dir: 'D--mine', name: 'totally-else', remote: '', folder: 'web' }]);
  assert.strictEqual(matched.find((x) => x.folder === 'web').match.how, 'linked');
});

test('signing in again sends everything, even when an earlier sign-in already had', { skip }, async () => {
  const E = machine('e');
  put(E, 'projects/solo/shared/one.md', 'One.\n');
  put(E, 'projects/solo/shared/two.md', 'Two.\n');
  await signIn(E, 'fresh@example.com');
  assert.strictEqual((await E.cloud.backups())[0].files, 2);
  // The account is deleted on the website and made again with the same email.
  const { Client } = require(path.join(__dirname, '..', 'cloud', 'node_modules', 'pg'));
  const c = new Client({ connectionString: DB });
  await c.connect();
  await c.query(`delete from users where email = 'fresh@example.com'`);
  await c.end();
  await new Promise((r) => setTimeout(r, 1600));
  await signIn(E, 'fresh@example.com');
  const list = await E.cloud.backups();
  assert.strictEqual(list[0].files, 2, 'both files went up again, not only what changed');
  E.cloud.stop();
});

// ---- each project its own setting ----
let F;
let G;
test.after(() => {
  if (F) F.cloud.stop();
  if (G) G.cloud.stop();
});

test('a project linked on two machines stays the same, whatever each calls it', { skip }, async () => {
  F = machine('f');
  put(F, 'projects/ecom-store/.loop-project', '{"dir":"F--work-ecom","remote":""}');
  put(F, 'projects/ecom-store/shared/payments.md', 'Payments go through Stripe.\n');
  await signIn(F, 'link@example.com');
  F.cloud.setProjectMode('F--work-ecom', 'linked');
  await F.cloud.syncNow();

  // The new laptop: the project is in another folder, under another name, with a note of its own.
  G = machine('g');
  put(G, 'projects/my-shop/.loop-project', '{"dir":"G--clients-shop","remote":""}');
  put(G, 'projects/my-shop/shared/setup.md', 'Run npm install first.\n');
  await signIn(G, 'link@example.com');
  const out = await G.cloud.link('G--clients-shop', 'ecom-store');
  assert.strictEqual(out.folder, 'ecom-store');
  assert.strictEqual(read(G, 'projects/ecom-store/shared/payments.md'), 'Payments go through Stripe.\n', 'the cloud memory came down');
  assert.strictEqual(read(G, 'projects/ecom-store/shared/setup.md'), 'Run npm install first.\n', 'its own note is kept');
  assert.ok(!fs.existsSync(path.join(G.root, 'projects', 'my-shop')), 'one memory folder, under the cloud name');
  assert.strictEqual(JSON.parse(read(G, 'projects/ecom-store/.loop-project')).dir, 'G--clients-shop', "the marker names this machine's project");

  await G.cloud.syncNow();
  await F.cloud.syncNow();
  assert.strictEqual(read(F, 'projects/ecom-store/shared/setup.md'), 'Run npm install first.\n', "the laptop's note reached the first machine");
  assert.strictEqual(JSON.parse(read(F, 'projects/ecom-store/.loop-project')).dir, 'F--work-ecom', 'each machine keeps its own marker');

  put(F, 'projects/ecom-store/shared/payments.md', 'Payments go through Stripe and UPI.\n');
  await F.cloud.syncNow();
  await G.cloud.syncNow();
  assert.strictEqual(read(G, 'projects/ecom-store/shared/payments.md'), 'Payments go through Stripe and UPI.\n');
});

test('This PC only never goes up; Backed up never comes down', { skip }, async () => {
  put(F, 'projects/private/.loop-project', '{"dir":"F--private","remote":""}');
  put(F, 'projects/private/shared/secret.md', 'Not for the cloud.\n');
  F.cloud.setProjectMode('F--private', 'local');
  await F.cloud.syncNow();
  const held = await F.cloud.cloudProjects(true);
  assert.ok(!held.list.some((p) => p.folder === 'private'), 'a This PC only project is not in the cloud');

  put(G, 'projects/notes/.loop-project', '{"dir":"G--notes","remote":""}');
  put(G, 'projects/notes/shared/a.md', 'From G.\n');
  G.cloud.setProjectMode('G--notes', 'backup');
  await G.cloud.syncNow();
  put(F, 'projects/notes/.loop-project', '{"dir":"F--notes","remote":""}');
  F.cloud.setProjectMode('F--notes', 'backup');
  put(F, 'projects/notes/shared/b.md', 'From F.\n');
  await F.cloud.syncNow();
  await G.cloud.syncNow();
  assert.strictEqual(read(G, 'projects/notes/shared/b.md'), null, "a backed-up project does not take the cloud's changes");
});

test('the old single switch still works: Sync links every project here', { skip }, async () => {
  G.cloud.setMode('sync');
  const st = G.cloud.state();
  assert.strictEqual(st.projects['G--notes'], 'linked');
  assert.strictEqual(st.defaultMode, 'linked');
});
