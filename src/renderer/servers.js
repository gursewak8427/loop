/* global deck, S, h, icon, put, menu, closeOverlay, formDialog, confirmBox, toast, save, openPanel , syncTeamNames */
/* global tabFor, wsById, wsOf, isHiddenProject, accountFor, accountList, multiAccount */
/* global createTab, closeTab, renderAll, renderRail, renderList, renderTabs, renderStatus, renderUsage, tabTitle, switchWorkspace, gb */
'use strict';

// ---------- servers: sessions that run on another machine ----------

const serverById = (id) => (S.config.servers || []).find((s) => s.id === id);

function serverChip(id, long) {
  const s = serverById(id);
  if (!s) return null;
  const st = S.srv.get(id);
  return h(
    'span.acct.far',
    { style: `--acct:${s.color}`, title: `Runs on ${s.name}\n${serverLine(id)}` },
    st && !st.connected ? '!' : null,
    long ? s.name : s.name.slice(0, 8),
  );
}

// One line on how a server is doing.
function serverLine(id) {
  const st = S.srv.get(id);
  if (!st) return 'Connecting';
  if (!st.connected) return st.error || 'Not connected';
  const parts = [];
  if (!st.claude) parts.push('Claude Code is not installed there');
  else if (st.auth && !st.auth.loggedIn) parts.push('Claude is not signed in there');
  else if (st.auth)
    parts.push(st.auth.email ? `${st.auth.email}${st.auth.plan ? ', ' + st.auth.plan[0].toUpperCase() + st.auth.plan.slice(1) : ''}` : 'Signed in');
  if (st.load) parts.push(`${st.load.cores} cores at ${st.load.cpu}%`, `${gb(st.load.memUsed)} of ${gb(st.load.memTotal)} GB used`);
  if (st.claude && !st.tmux) parts.push('tmux is missing, so sessions stop when their tab closes');
  if (st.claude && st.user === 'root') parts.push('Sessions run as root, so they ask before each action. Choose another user to let them work unattended');
  else if (st.user && st.login && st.user !== st.login) parts.push(`Sessions run as ${st.user}`);
  return parts.join('. ');
}

// Projects on this PC first, then each server's.
function mergeProjects() {
  const far = S.switches && S.switches.servers ? [...S.srv.values()].flatMap((st) => (serverById(st.id) ? st.projects || [] : [])) : [];
  S.projects = [...S.local, ...far];
  syncTeamNames();
}

// Server sessions that were open when Loop closed are still running over there.
// Once their server has reported, attach to the ones that are.
function restoreFar() {
  if (!S.bootOpen || !S.bootOpen.length) return;
  for (const it of S.bootOpen.slice()) {
    const st = S.srv.get(it.server);
    if (!serverById(it.server)) S.bootOpen = S.bootOpen.filter((x) => x !== it);
    if (!st || !st.connected || !st.tmuxSessions) continue;
    S.bootOpen = S.bootOpen.filter((x) => x !== it);
    if (tabFor(it.sessionId) || !st.tmuxSessions.includes('loop-' + String(it.sessionId).slice(0, 13))) continue;
    createTab({ kind: 'resume', dir: it.dir, cwd: it.cwd, sessionId: it.sessionId, server: it.server }, S.order.length === 0);
  }
}

function wireServers() {
  const take = (list) => {
    S.srv = new Map(list.map((st) => [st.id, st]));
    mergeProjects();
    restoreFar();
    if (serversPaint) serversPaint();
    renderRail();
    renderList();
    renderTabs();
    renderStatus();
  };
  deck.onServers(take);
  deck.serverState().then(take);
}

// The rail gets one entry per server, under the workspaces.
function railServers(item, liveIn) {
  if (!S.switches || !S.switches.servers) return [];
  return (S.config.servers || []).map((s) => {
    const st = S.srv.get(s.id);
    const el = item(
      'srv:' + s.id,
      s.name.slice(0, 2).toUpperCase(),
      `${s.name} (server)\n${serverLine(s.id)}`,
      s.color,
      liveIn((p) => p.server === s.id),
    );
    el.classList.add('far');
    if (st && !st.connected) el.classList.add('down');
    el.oncontextmenu = (e) => {
      e.preventDefault();
      serverMenu(e.clientX, e.clientY, s);
    };
    return el;
  });
}

const serverShell = (s) => closeOverlay() || createTab({ kind: 'shell', dir: null, cwd: null, sessionId: null, server: s.id, name: s.name });

// Claude Code's own sign-in, run on the server: it prints a link to open here and waits for the code.
// Sessions and sign-in need Claude Code on the server. If it is missing, say so
// and offer to install it, which is your call to make, not Loop's.
async function claudeMissing(s) {
  const st = S.srv.get(s.id);
  if (!st || !st.connected) {
    toast(`${s.name} is not connected: ${serverLine(s.id)}`, true);
    return true;
  }
  if (st.claude) return false;
  // What Loop knows may be a little old, for example right after an install: ask the server itself.
  const now = await deck.serverProbe(s.id);
  if (now) S.srv.set(s.id, { ...st, ...now });
  if (now && now.claude) return false;
  const ok = await confirmBox({
    title: `Claude Code is not installed on ${s.name}`,
    body: `Sessions and sign-in need it there. Loop can run Anthropic's installer on the server in a tab: it downloads Claude Code into the home folder of ${st.user || 'the user'} and changes nothing else. If the server runs other things, be sure you want it there.`,
    confirm: 'Install it there',
  });
  if (ok) {
    const tab = createTab({ kind: 'install', dir: null, cwd: null, sessionId: null, server: s.id, name: `Install on ${s.name}` });
    const check = () => (S.tabs.has(tab.id) && !tab.exited ? setTimeout(check, 2000) : deck.serverProbe(s.id));
    setTimeout(check, 4000);
  }
  return true;
}

async function serverSignIn(s) {
  closeOverlay();
  serversPaint = null;
  if (await claudeMissing(s)) return;
  const tab = createTab({ kind: 'login', dir: null, cwd: null, sessionId: null, server: s.id, name: `Sign in on ${s.name}` });
  const check = () => {
    if (!S.tabs.has(tab.id) || tab.exited) return deck.serverProbe(s.id);
    setTimeout(check, 2000);
  };
  setTimeout(check, 4000);
}

// Choose which user on the server the sessions run as: the one SSH logs in as,
// another one that exists there, or a new one. Each user has their own Claude
// sign-in, folders and sessions, so this is also how one server holds several
// Claude accounts. Resolves to true if it changed, false if not, null if cancelled.
async function chooseUser(s) {
  const st = S.srv.get(s.id) || {};
  if (!st.connected) {
    toast(`${s.name} is not connected: ${serverLine(s.id)}`, true);
    return null;
  }
  const login = st.login || s.user || '';
  const users = [...new Set([login, ...(st.users || []), s.runAs].filter(Boolean))];
  const v = await formDialog({
    title: `Who sessions run as on ${s.name}`,
    body: `Loop logs in${login ? ' as ' + login : ''}. Sessions can run as that user or as another one on the server; each has their own Claude sign-in, folders and sessions. As root, Claude Code asks before every action. As a normal user it can work without asking.`,
    fields: [
      {
        key: 'user',
        label: 'Run sessions as',
        type: 'select',
        value: s.runAs || login,
        options: [
          ...users.map((u) => ({ value: u, label: u === 'root' ? 'root (asks before every action)' : u === login ? `${u} (the login user)` : u })),
          { value: '+', label: 'A new user on this server' },
        ],
      },
    ],
    confirm: 'Use this user',
  });
  if (!v) return null;
  let u = v.user;
  if (u === '+') {
    const n = await formDialog({
      title: `New user on ${s.name}`,
      body: 'Loop adds a normal user with a home folder and nothing else: no password and no admin rights. Sessions then run as that user, in that home folder. Claude Code has to be installed and signed in once for it; Loop offers both.',
      fields: [{ key: 'name', label: 'User name', value: 'loop', mono: true }],
      confirm: 'Add user',
    });
    if (!n) return null;
    u = String(n.name).trim();
    const r = await deck.serverAddUser(s.id, u);
    if (!r || !r.ok) {
      toast((r && r.error) || 'The server could not add that user.', true);
      return null;
    }
  }
  const cfg = serverById(s.id) || s;
  const next = u === login ? '' : u;
  cfg.userAsked = true;
  if ((cfg.runAs || '') === next) {
    save();
    return false;
  }
  cfg.runAs = next;
  S.srv.delete(s.id);
  save();
  renderAll();
  toast(`Connecting to ${s.name} as ${u}`);
  // wait for the first full report made as that user
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const now = S.srv.get(s.id);
    if (now && now.connected && now.user && now.auth) break;
    if (now && !now.connected && now.error && now.error !== 'Connecting' && i > 20) break;
  }
  const now = S.srv.get(s.id);
  if (!now || !now.connected) toast(`${s.name} did not let Loop work as ${u}: ${serverLine(s.id)}`, true);
  return true;
}

// A server can run sessions once Claude Code is there and signed in. If not, say what is missing and offer the fix.
async function serverReady(s) {
  // Root is rarely what you want for sessions, so ask once which user to use.
  const first = S.srv.get(s.id);
  if (first && first.connected && first.user === 'root' && !(serverById(s.id) || s).userAsked && (await chooseUser(s)) === null) return false;
  if (await claudeMissing(s)) return false;
  const st = S.srv.get(s.id);
  if (st && st.auth && !st.auth.loggedIn) {
    const ok = await confirmBox({
      title: `Claude is not signed in on ${s.name}`,
      body: 'A session there needs a Claude sign-in on the server first. It takes a moment and opens in your browser.',
      confirm: 'Sign in there',
    });
    if (ok) serverSignIn(s);
    return false;
  }
  return true;
}

// One dialog for every new session: where it runs (this PC or a server), which
// folder, and its name. Resolves to { server, cwd, name, account } or null.
function newSessionDialog(first) {
  return new Promise((resolve) => {
    const ws = wsById(S.config.activeWorkspace);
    const servers = S.switches && S.switches.servers ? S.config.servers || [] : [];
    const inView = (p) => !isHiddenProject(p) && (!ws || wsOf(p) === ws.id);
    const leaf = (p) => p.split(/[\\/]/).filter(Boolean).pop() || p;
    const bad = (p) => /['"%!\r\n]/.test(p);
    let where = null; // null is this PC, otherwise the server
    let here = null; // what the server last listed
    let asked = 0;

    const done = (v) => {
      closeOverlay();
      resolve(v);
    };

    // this PC
    const localIn = h('input', { type: 'text', spellcheck: false, placeholder: 'C:\\Projects\\my-project', value: (ws && ws.roots && ws.roots[0]) || '' });
    const browse = h(
      'button.btn',
      {
        type: 'button',
        onclick: async () => {
          const picked = await deck.pickFolder(localIn.value);
          if (picked) localIn.value = picked;
        },
      },
      icon('folder'),
      'Browse',
    );
    const localUsed = S.local.filter((p) => p.exists && inView(p)).slice(0, 6);
    const localPane = h(
      'div',
      {},
      h('div.field.mono', {}, h('span', {}, 'Folder on this PC'), h('div.with-button', {}, localIn, browse)),
      localUsed.length
        ? h(
            'div.dir-used',
            {},
            h('span', {}, 'Used before'),
            localUsed.map((p) => h('button.chip', { type: 'button', title: p.path, onclick: () => (localIn.value = p.path) }, leaf(p.path))),
          )
        : null,
    );

    // a server
    const pathIn = h('input', { type: 'text', spellcheck: false, placeholder: 'Folder on the server' });
    const list = h('div.dir-list');
    const note = h('small.dir-note');
    const used = h('div.dir-used');
    const newIn = h('input', { type: 'text', spellcheck: false, placeholder: 'New folder name, or a git address to clone here' });
    const isGit = (v) => /^(https:\/\/|ssh:\/\/|git@)\S+$/.test(v);
    const makeBtn = h('button.btn', { type: 'button', onclick: () => make() });
    const paintMake = () => put(makeBtn, icon('plus'), isGit(newIn.value.trim()) ? 'Clone here' : 'New folder');
    newIn.addEventListener('input', paintMake);
    paintMake();
    const up = h('button.btn', { type: 'button', title: 'Go to the folder above', onclick: () => here && go(here.path.replace(/\/[^/]*$/, '') || '/') }, 'Up');
    const home = h('button.btn', { type: 'button', title: 'Go to the home folder', onclick: () => go('') }, 'Home');
    const farLabel = h('span.far-label');
    const farPane = h(
      'div',
      { hidden: true },
      h('div.field.mono', {}, farLabel, h('div.with-button', {}, up, home, pathIn, h('button.btn', { type: 'button', onclick: () => go(pathIn.value.trim()) }, 'Open'))),
      used,
      list,
      note,
      h('div.field.mono', {}, h('div.with-button', {}, newIn, makeBtn)),
    );

    const nameIn = h('input', { type: 'text', placeholder: 'Backend developer' });
    const acctIn = multiAccount()
      ? h(
          'select',
          {},
          accountList().map((a) => h('option', { value: a.id, selected: a.id === ((ws && ws.account) || S.config.defaultAccount || 'default') }, a.name)),
        )
      : null;
    const acctField = acctIn ? h('label.field', {}, h('span', {}, 'Claude account'), acctIn) : null;
    const start = h('button.btn.primary', { type: 'submit' }, 'Start session');
    const chips = h('div.where');

    async function go(dir) {
      const s = where;
      if (!s) return;
      if (bad(dir)) return toast('That folder name has characters that cannot be used here.', true);
      if (here && dir.startsWith('~')) dir = here.home + dir.slice(1);
      const mine = ++asked;
      if (!here) put(list, h('div.dir-empty', {}, `Connecting to ${s.name}`));
      list.classList.add('busy');
      const r = await deck.serverList(s.id, dir);
      if (mine !== asked || !box.isConnected) return;
      list.classList.remove('busy');
      if (!r) {
        put(list, h('div.dir-empty', {}, `${s.name} did not answer. Check that it is connected, then try again.`));
        return;
      }
      here = r;
      pathIn.value = r.path;
      start.disabled = false;
      start.textContent = `Start session in ${leaf(r.path) === r.path ? '/' : leaf(r.path)}`;
      up.disabled = r.path === '/';
      note.textContent = r.missing
        ? `"${dir}" does not exist on ${s.name}, so this is the home folder. Use New folder below to make it.`
        : r.git
          ? 'This folder is a git project.'
          : '';
      put(
        list,
        r.dirs.length
          ? r.dirs.map((d) => h('button.dir', { type: 'button', title: 'Open this folder', onclick: () => go(`${r.path.replace(/\/$/, '')}/${d}`) }, icon('folder'), d))
          : h('div.dir-empty', {}, 'No folders inside this one. You can start the session right here.'),
      );
      list.scrollTop = 0;
    }

    async function make() {
      const n = newIn.value.trim();
      if (!n || !here || !where) return;
      if (isGit(n)) {
        // The server fetches the project from git itself; nothing is copied up from this PC.
        const s = where;
        makeBtn.disabled = true;
        note.textContent = `${s.name} is cloning it. A big project can take a minute.`;
        const r = await deck.serverClone(s.id, here.path, n);
        if (!box.isConnected) return;
        makeBtn.disabled = false;
        if (!r || !r.ok) return (note.textContent = (r && r.error) || 'The clone failed.');
        newIn.value = '';
        paintMake();
        await go(r.path);
        if (r.existed) note.textContent = 'That project was already here, so nothing was cloned.';
        return;
      }
      if (bad(n) || n.startsWith('-')) return toast('That folder name has characters that cannot be used here.', true);
      const made = await deck.serverMakeDir(where.id, n.startsWith('/') ? n : `${here.path.replace(/\/$/, '')}/${n}`);
      if (!made) return toast(`${where.name} could not make that folder.`, true);
      newIn.value = '';
      go(made);
    }

    function paintChips() {
      put(
        chips,
        h('button.chip', { type: 'button', class: where ? '' : 'on', onclick: () => pick(null) }, 'This PC'),
        servers.map((s) => {
          const st = S.srv.get(s.id);
          return h(
            'button.chip',
            { type: 'button', class: where === s ? 'on' : '', style: `--acct:${s.color}`, title: serverLine(s.id), onclick: () => pick(s) },
            h('i.dot'),
            s.name,
            st && st.connected ? null : ' (not connected)',
          );
        }),
      );
    }

    async function pick(s) {
      if (s && s !== where) {
        const st = S.srv.get(s.id);
        if (!st || !st.connected) return toast(`${s.name} is not connected: ${serverLine(s.id)}`, true);
        const ok = await serverReady(s);
        // A question in between took this dialog's place: open it again on that server.
        if (!box.isConnected) return resolve(ok ? { again: s } : null);
        if (!ok) return null;
      }
      where = s;
      here = null;
      asked++;
      paintChips();
      localPane.hidden = Boolean(s);
      farPane.hidden = !s;
      if (acctField) acctField.hidden = Boolean(s);
      start.textContent = 'Start session';
      start.disabled = Boolean(s);
      if (!s) return;
      const as = (S.srv.get(s.id) || {}).user;
      put(
        farLabel,
        `Folder on ${s.name}${as ? ', as ' + as : ''}`,
        h(
          'button.link',
          {
            type: 'button',
            title: 'Choose which user on the server the sessions run as',
            onclick: async () => {
              await chooseUser(s);
              resolve({ again: s });
            },
          },
          'Change user',
        ),
      );
      const before = ((S.srv.get(s.id) || {}).projects || []).filter(inView).map((p) => p.path);
      const all = before.length ? before : ((S.srv.get(s.id) || {}).projects || []).map((p) => p.path);
      used.hidden = !all.length;
      put(used, h('span', {}, 'Used before'), all.slice(0, 6).map((p) => h('button.chip', { type: 'button', title: p, onclick: () => go(p) }, leaf(p))));
      go(before[0] || '');
    }

    const enter = (el, fn) =>
      el.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        fn();
      });
    enter(pathIn, () => go(pathIn.value.trim()));
    enter(newIn, make);

    const box = h(
      'form.dialog.wide',
      {
        onsubmit: (e) => {
          e.preventDefault();
          const name = nameIn.value.trim();
          if (!where) {
            const cwd = localIn.value.trim().replace(/[\\/]+$/, '');
            if (!cwd) return toast('Choose a folder first.', true);
            return done({ server: null, cwd, name, account: acctIn ? acctIn.value : null });
          }
          if (!here) return;
          // A path typed but not yet opened: open it first, so what starts is what is shown.
          if (pathIn.value.trim() !== here.path) return go(pathIn.value.trim());
          done({ server: where.id, cwd: here.path, name });
        },
      },
      h('h3', {}, ws ? `New session in ${ws.name}` : 'New session'),
      h(
        'p',
        {},
        servers.length
          ? 'Choose where it runs and the folder to work in. The folder shows up in this list as a project, with its sessions under it.'
          : 'Choose the folder to work in. It shows up in this list as a project, with its sessions under it.',
      ),
      servers.length ? h('div.field', {}, h('span', {}, 'Runs on'), chips) : null,
      localPane,
      farPane,
      h('label.field', {}, h('span', {}, 'Session name (optional)'), nameIn),
      acctField,
      h('div.dialog-actions', {}, h('button.btn', { type: 'button', onclick: () => done(null) }, 'Cancel'), start),
    );
    closeOverlay();
    const scrim = h('div.scrim.dim', { onmousedown: (e) => e.target === scrim && done(null) }, box);
    box.addEventListener('keydown', (e) => e.key === 'Escape' && done(null));
    document.querySelector('#overlay').append(scrim);
    paintChips();
    nameIn.focus();
    if (first) pick(first);
    // Open the connection used for browsing now, so choosing a server answers at once.
    else for (const s of servers) if ((S.srv.get(s.id) || {}).connected) deck.serverList(s.id, '');
  });
}

// Start a session from the current list: on this PC or on a server, in any folder.
// It lands in the workspace you are looking at, wherever it runs.
async function startSession(first) {
  closeOverlay();
  serversPaint = null;
  if (first && !(S.switches && S.switches.servers)) first = null;
  if (first && !(await serverReady(first))) return;
  const v = await newSessionDialog(first || null);
  if (!v) return;
  if (v.again) return startSession(v.again);
  const ws = wsById(S.config.activeWorkspace);
  const sessionId = crypto.randomUUID();
  // Claude Code names a project's folder after its path, with every other character turned into a dash.
  const enc = v.cwd.replace(/[^A-Za-z0-9]/g, '-');
  const dir = v.server ? `srv-${v.server}-${enc}` : enc;
  if (ws && wsOf({ dir, path: v.server ? '' : v.cwd }) !== ws.id) S.config.projectWorkspace[dir] = ws.id;
  if (v.account && v.account !== accountFor(dir, null)) S.config.sessionAccount[sessionId] = v.account;
  save();
  createTab({ kind: 'new', dir, cwd: v.cwd, sessionId, name: v.name, ...(v.server ? { server: v.server } : {}) });
}

const serverNewSession = (s) => startSession(s);

function serverMenu(x, y, s) {
  menu(x, y, [
    { heading: s.name },
    { label: 'Open a terminal', icon: 'terminal', run: () => serverShell(s) },
    { label: 'New session', icon: 'plus', run: () => serverNewSession(s) },
    { label: 'Sign in to Claude there', icon: 'person', run: () => serverSignIn(s) },
    { label: 'Choose the user sessions run as', icon: 'team', run: () => chooseUser(s) },
    '-',
    { label: 'Connect again', icon: 'refresh', run: () => deck.serverRefresh(s.id) },
    { label: 'Edit', icon: 'pencil', run: () => editServer(s) },
    { label: 'Remove', icon: 'trash', danger: true, run: () => removeServer(s) },
  ]);
}

async function stopOnServer(tab) {
  const ok = await confirmBox({
    title: `Stop "${tabTitle(tab)}" on the server?`,
    body: 'Closing the tab leaves it running there. Stopping it ends the session; the conversation is saved and can be opened again.',
    confirm: 'Stop session',
    danger: true,
  });
  if (!ok) return;
  const ref = { server: tab.server, sessionId: tab.sessionId };
  await closeTab(tab.id, true);
  if (!(await deck.serverStop(ref))) toast('The server did not confirm. It may have stopped already.', true);
}

async function editServer(s) {
  // Show what SSH will actually use, including what comes from your SSH config, so no field is a mystery.
  const eff = s && s.host ? (await deck.serverResolve({ host: s.host, user: s.user, port: s.port, key: s.key })) || {} : {};
  const alias = eff.host && eff.host !== s.host ? eff.host : '';
  const v = await formDialog({
    title: s ? 'Edit server' : 'Add a server',
    body: s
      ? null
      : 'Loop connects with the SSH program already on this PC and installs nothing on the server. It needs to log in with a key, without asking for a password.',
    fields: [
      { key: 'name', label: 'Name', value: s ? s.name : '', placeholder: 'Build box' },
      {
        key: 'host',
        label: 'Address',
        value: s ? s.host : '',
        placeholder: '203.0.113.10, or a name from your SSH config',
        mono: true,
        hint: alias ? `"${s.host}" is a name from your SSH config. It points to ${alias}.` : null,
      },
      { key: 'user', label: 'User', value: (s && s.user) || eff.user || '', placeholder: 'deploy', mono: true },
      { key: 'port', label: 'Port', value: (s && s.port) || eff.port || '', placeholder: '22', mono: true },
      {
        key: 'key',
        label: 'Key file (optional)',
        value: (s && s.key) || eff.key || '',
        placeholder: 'C:\\Users\\you\\.ssh\\id_ed25519',
        mono: true,
        hint: 'Leave empty to use your default key or SSH config.',
      },
      { key: 'color', label: 'Colour', type: 'colors', value: s ? s.color : S.colors[((S.config.servers || []).length + 2) % S.colors.length] },
    ],
    confirm: s ? 'Save' : 'Add server',
    extra: 'Choose key file',
    wide: true,
  });
  if (!v) return openServers();
  if (v.__extra) {
    const file = await deck.pickFile();
    return editServer({ ...(s || { name: '', host: '', user: '' }), key: file || (s && s.key) || '', __new: !s || s.__new });
  }
  const host = String(v.host).trim();
  const user = String(v.user).trim();
  const port = String(v.port).trim();
  if (!String(v.name).trim() || !/^[A-Za-z0-9._-]{1,253}$/.test(host))
    return toast('A server needs a name and an address (letters, digits, dots and dashes).', true);
  if (!/^[A-Za-z0-9._-]{0,64}$/.test(user) || (port && !(Number(port) > 0 && Number(port) < 65536))) return toast('Check the user and the port.', true);
  const data = { name: v.name.trim().slice(0, 30), host, user, port: port ? Number(port) : '', key: String(v.key || '').trim(), color: v.color };
  if (s && !s.__new) Object.assign(serverById(s.id), data);
  else S.config.servers.push({ id: 's' + Date.now().toString(36), ...data });
  save();
  renderAll();
  openServers();
}

async function removeServer(s) {
  const open = [...S.tabs.values()].filter((t) => t.server === s.id);
  const ok = await confirmBox({
    title: `Remove the server "${s.name}"?`,
    body: `Loop forgets the server${open.length ? ` and closes its ${open.length} open tab${open.length === 1 ? '' : 's'}` : ''}. Nothing on the server is changed: sessions running there keep running.`,
    confirm: 'Remove server',
    danger: true,
  });
  if (!ok) return;
  for (const t of open) await closeTab(t.id, true);
  S.config.servers = S.config.servers.filter((x) => x.id !== s.id);
  if (S.config.activeWorkspace === 'srv:' + s.id) S.config.activeWorkspace = 'all';
  S.srv.delete(s.id);
  mergeProjects();
  save();
  renderAll();
}

let serversPaint = null; // repaints the Servers panel while it is open

function openServers() {
  const rows = h('div.acct-rows');
  const box = h(
    'div.dialog.wide',
    { tabIndex: -1 },
    h('h3', {}, 'Servers'),
    h(
      'p',
      {},
      'Run sessions on another machine so its processor and memory do the work. A session there keeps running when you close its tab, Loop or this PC.',
    ),
    rows,
    h(
      'div.dialog-actions',
      {},
      h('button.btn', { style: 'margin-right:auto', onclick: () => editServer(null) }, icon('plus'), 'Add server'),
      h('button.btn.primary', { onclick: () => close() }, 'Done'),
    ),
  );
  const paint = () => {
    const list = S.config.servers || [];
    put(
      rows,
      list.length
        ? list.map((s) => {
            const st = S.srv.get(s.id);
            const needsSignIn = st && st.connected && st.claude && st.auth && !st.auth.loggedIn;
            return h(
              'div.acct-row',
              {},
              h('span.acct.big', { style: `--acct:${s.color}` }, s.name.slice(0, 2)),
              h(
                'div.acct-who',
                {},
                h('b', {}, s.name, h('span.tag', {}, `${s.user ? s.user + '@' : ''}${s.host}`)),
                h('span', { class: st && st.connected && !needsSignIn ? '' : 'warn', title: serverLine(s.id) }, serverLine(s.id)),
              ),
              needsSignIn
                ? h('button.btn.small.primary', { onclick: () => serverSignIn(s) }, 'Sign in')
                : h('button.btn.small.primary', { onclick: () => serverNewSession(s) }, 'New session'),
              st && st.connected && st.user
                ? h(
                    'button.btn.small',
                    {
                      title: 'Choose which user on the server the sessions run as',
                      onclick: async () => {
                        await chooseUser(s);
                        openServers();
                      },
                    },
                    `as ${st.user}`,
                  )
                : null,
              h(
                'button.btn.small',
                {
                  onclick: () => {
                    closeOverlay();
                    serverShell(s);
                  },
                },
                'Terminal',
              ),
              h(
                'button.mini',
                {
                  title: 'More',
                  onclick: (e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    serverMenu(r.left, r.bottom + 4, s);
                  },
                },
                icon('dots'),
              ),
            );
          })
        : h('div.side-empty', {}, 'No servers yet. Add one with its address and the user to log in as.'),
    );
  };
  const close = openPanel(box);
  serversPaint = () => (box.isConnected ? paint() : (serversPaint = null));
  paint();
  box.focus();
}

// A server session lives in tmux over there, so a tab that closes because the
// connection dropped has lost nothing. Put it back by itself: wait for the
// server if it is unreachable, then attach again.
const farName = (sessionId) => 'loop-' + sessionId.slice(0, 13);

async function farTabClosed(tab) {
  const s = serverById(tab.server);
  if (!s || !tab.sessionId || !tab.started || (tab.kind !== 'new' && tab.kind !== 'resume')) return false;
  const now = Date.now();
  tab.drops = (tab.drops || []).filter((t) => now - t < 120000);
  if (tab.drops.length >= 4) return false; // it keeps falling over: stop and let the tab say closed
  tab.drops.push(now);
  const alive = () => S.tabs.has(tab.id) && tab.exited;
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  const say = (text) => tab.term.write(`\r\n\x1b[90m${text}\x1b[0m\r\n`);
  // Wait for a report made after the drop, rather than trust one from before it.
  const since = Date.now();
  for (let i = 0; i < 3 && alive(); i++) {
    await pause(1500);
    const st = S.srv.get(s.id);
    if (!st || !st.connected || st.at > since + 500) break;
  }
  if (!alive()) return true;
  let st = S.srv.get(s.id) || {};
  if (st.connected && st.tmux === false) return false;
  if (st.connected && !(st.tmuxSessions || []).includes(farName(tab.sessionId))) return false; // it really ended
  if (!st.connected) {
    say(`The connection to ${s.name} dropped. The session is still running there; this tab comes back when the server is reachable.`);
    for (let i = 0; i < 400 && alive() && !(S.srv.get(s.id) || {}).connected; i++) await pause(3000);
    if (!alive()) return true;
    st = S.srv.get(s.id) || {};
    if (!st.connected) return false;
    await pause(4000); // let the first report after reconnecting arrive
    if (!alive()) return true;
    st = S.srv.get(s.id) || {};
    if (!(st.tmuxSessions || []).includes(farName(tab.sessionId))) {
      say(`${s.name} is back, but this session is no longer running there. Open it from the list to continue the conversation.`);
      return false;
    }
  }
  say(`Connecting to ${s.name} again`);
  const r = await deck.openPty({
    id: tab.id,
    kind: 'resume',
    cwd: tab.cwd,
    dir: tab.dir,
    sessionId: tab.sessionId,
    name: tab.name,
    title: tabTitle(tab),
    account: tab.account,
    server: tab.server,
    cols: tab.term.cols,
    rows: tab.term.rows,
  });
  if (!r.ok || !S.tabs.has(tab.id)) return false;
  tab.exited = false;
  tab.kind = 'resume';
  deck.resize(tab.id, tab.term.cols, tab.term.rows);
  renderTabs();
  renderList();
  return true;
}
