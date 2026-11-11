/* global deck, MOD, S, h, icon, put, menu, menuAt, closeOverlay, formDialog, confirmBox, toast, save, ago */
/* global projectByDir, projectTitle, sessionTitle, tabTitle, tabFor, lampFor, wsById, wsOf, isHiddenProject, isHiddenSession */
/* global openServers, serverShell, openPhone */
/* global renderStatus, switchAccount, tabTitle, editAccount, */
/* global accountList, accountById, accountLine, multiAccount, isClaudeTab, closeTab, renderAll, renderTabs, renderList */
/* global openSession, newSession, openShell, createTab, createTabs, activate, setLayout, toggleComposer, toggleDrawer, openSettings, focusActive, toggleVoice */
'use strict';

// A centred panel over a dimmed window. Returns a function that closes it.
function openPanel(node) {
  closeOverlay();
  const close = () => {
    closeOverlay();
    focusActive();
  };
  const scrim = h('div.scrim.dim', { onmousedown: (e) => e.target === scrim && close() }, node);
  node.addEventListener('keydown', (e) => e.key === 'Escape' && close());
  document.querySelector('#overlay').append(scrim);
  return close;
}

// ---------- quick open (Ctrl+K) ----------

function paletteItems() {
  const items = [];
  for (const id of S.order) {
    const tab = S.tabs.get(id);
    const p = projectByDir(tab.dir);
    items.push({
      label: tabTitle(tab),
      hint: `Open here, ${p ? projectTitle(p) : ''}`,
      lamp: lampFor(tab.sessionId, tab),
      rank: 3e13,
      run: () => activate(id),
      key: 'tab' + id,
    });
  }
  for (const p of S.projects) {
    if (isHiddenProject(p)) continue;
    const ws = wsById(wsOf(p));
    const where = ws ? `${projectTitle(p)}, ${ws.name}` : projectTitle(p);
    for (const s of p.sessions) {
      if (s.empty || isHiddenSession(s) || tabFor(s.id)) continue;
      items.push({
        label: sessionTitle(s),
        hint: where,
        lamp: lampFor(s.id),
        rank: s.mtime + (S.live.has(s.id) ? 1e13 : 0),
        extra: s.lastPrompt,
        run: () => openSession(p, s),
      });
    }
    if (p.exists) {
      items.push({ label: `New session in ${projectTitle(p)}`, hint: p.path, glyph: 'plus', rank: p.mtime / 10, run: () => newSession(p) });
      items.push({ label: `Terminal in ${projectTitle(p)}`, hint: p.path, glyph: 'terminal', rank: p.mtime / 10 - 1, run: () => openShell(p) });
    }
  }
  for (const t of S.config.teams || []) {
    items.push({ label: `Open team ${t.name}`, hint: `${t.sessions.length} sessions`, glyph: 'play', rank: 1e12, run: () => openTeam(t) });
  }
  items.push(
    {
      label: 'Switch between Focus and Grid',
      hint: `${MOD}+Shift+G`,
      glyph: 'grid',
      rank: 5,
      run: () => setLayout(S.config.layout === 'grid' ? 'focus' : 'grid'),
    },
    { label: 'Talk to this session (voice mode)', hint: `${MOD}+Shift+V`, glyph: 'mic', rank: 4, run: toggleVoice },
    { label: 'Broadcast a prompt', hint: `${MOD}+Shift+B`, glyph: 'broadcast', rank: 4, run: toggleComposer },
    { label: 'Memory', hint: `${MOD}+Shift+M`, glyph: 'book', rank: 3, run: toggleDrawer },
    { label: 'Claude accounts', hint: 'Add, sign in, switch', glyph: 'person', rank: 2.5, run: openAccounts },
    { label: 'Servers', hint: 'Run sessions on another machine', glyph: 'server', rank: 2.4, run: openServers },
    { label: 'Your phone', hint: 'Work on these sessions from the Loop app', glyph: 'phone', rank: 2.35, run: openPhone },
    ...(S.config.servers || []).map((s) => ({ label: `Terminal on ${s.name}`, hint: s.host, glyph: 'terminal', rank: 2.3, run: () => serverShell(s) })),
    { label: 'Settings', hint: '', glyph: 'gear', rank: 2, run: openSettings },
  );
  return items;
}

function paletteSearch(items, query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length)
    return items
      .slice()
      .sort((a, b) => b.rank - a.rank)
      .slice(0, 40);
  const scored = [];
  for (const it of items) {
    const label = it.label.toLowerCase();
    const all = `${label} ${it.hint.toLowerCase()} ${(it.extra || '').toLowerCase()}`;
    let score = 0;
    let ok = true;
    for (const w of words) {
      if (!all.includes(w)) {
        ok = false;
        break;
      }
      const at = label.indexOf(w);
      score += at === 0 ? 6 : at > 0 && /\W/.test(label[at - 1]) ? 4 : at > 0 ? 2 : 1;
    }
    if (ok) scored.push({ it, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || b.it.rank - a.it.rank)
    .slice(0, 40)
    .map((x) => x.it);
}

function openPalette() {
  const items = paletteItems();
  let shown = [];
  let cursor = 0;
  const list = h('div.palette-list');
  const input = h('input', { type: 'text', placeholder: 'Jump to a session, project or action' });
  const box = h('div.palette', {}, h('label.search', {}, icon('search'), input), list);
  const close = openPanel(box);
  const run = (it) => {
    closeOverlay();
    it.run();
  };
  const paint = () => {
    put(
      list,
      shown.length
        ? shown.map((it, i) =>
            h(
              'button.palette-item',
              { class: i === cursor ? 'on' : '', onclick: () => run(it), onmousemove: () => i !== cursor && ((cursor = i), paint()) },
              it.glyph ? icon(it.glyph) : h('span.lamp', { class: it.lamp || '' }),
              h('span.label', {}, it.label),
              h('span.hint', {}, it.hint),
            ),
          )
        : h('div.side-empty', {}, 'Nothing matches. Try part of a session or project name.'),
    );
    const on = list.querySelector('.on');
    if (on) on.scrollIntoView({ block: 'nearest' });
  };
  const refresh = () => {
    shown = paletteSearch(items, input.value);
    cursor = 0;
    paint();
  };
  input.addEventListener('input', refresh);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      cursor = (cursor + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % Math.max(1, shown.length);
      paint();
    } else if (e.key === 'Enter' && shown[cursor]) run(shown[cursor]);
    else if (e.key === 'Escape') close();
  });
  refresh();
  input.focus();
}

// ---------- teams: named sets of sessions that open together ----------

function openTeam(team) {
  const specs = [];
  let elsewhere = 0;
  let gone = 0;
  for (const ref of team.sessions) {
    const p = projectByDir(ref.dir);
    const s = p && p.sessions.find((x) => x.id === ref.sessionId);
    if (!p || !s || !p.exists) gone++;
    else if (tabFor(s.id)) continue;
    else if (S.live.has(s.id)) elsewhere++;
    else specs.push({ kind: 'resume', dir: p.dir, cwd: p.path, sessionId: s.id });
  }
  const opened = specs.length;
  if (S.order.length + opened > 1) setLayout('grid');
  createTabs(specs);
  const notes = [];
  if (elsewhere) notes.push(`${elsewhere} already running in another window`);
  if (gone) notes.push(`${gone} no longer exist`);
  if (notes.length || !opened)
    toast(opened ? `Opened ${opened}. Skipped: ${notes.join(', ')}.` : notes.length ? `Nothing opened: ${notes.join(', ')}.` : `${team.name} is already open.`);
}

async function saveTeam() {
  const sessions = S.order
    .map((id) => S.tabs.get(id))
    .filter(isClaudeTab)
    .map((t) => ({ dir: t.dir, sessionId: t.sessionId }));
  if (!sessions.length) return toast('Open the sessions that belong together first, then save them as a team.');
  const v = await formDialog({
    title: 'Save open sessions as a team',
    body: `The ${sessions.length} session${sessions.length === 1 ? '' : 's'} open right now will reopen together with one click. Saving under an existing name replaces that team.`,
    fields: [{ key: 'name', label: 'Team name', value: '', placeholder: 'Launch crew' }],
    confirm: 'Save team',
  });
  if (!v || !v.name.trim()) return;
  const name = v.name.trim();
  S.config.teams = (S.config.teams || []).filter((t) => t.name.toLowerCase() !== name.toLowerCase());
  S.config.teams.push({ id: 'team' + Date.now().toString(36), name, sessions });
  save();
  toast(`Team ${name} saved.`);
}

function teamsMenu(anchor) {
  const teams = S.config.teams || [];
  menuAt(anchor, [
    teams.length ? { heading: 'Open a team' } : { heading: 'No teams yet' },
    ...teams.map((t) => ({ label: `${t.name} (${t.sessions.length})`, icon: 'play', run: () => openTeam(t) })),
    '-',
    { label: 'Save open sessions as a team', icon: 'plus', run: saveTeam },
    teams.length
      ? {
          label: 'Delete a team',
          icon: 'trash',
          run: () =>
            menuAt(anchor, [
              { heading: 'Delete which team?' },
              ...teams.map((t) => ({
                label: t.name,
                danger: true,
                run: () => {
                  S.config.teams = S.config.teams.filter((x) => x.id !== t.id);
                  save();
                  toast(`Team ${t.name} deleted. Its sessions are untouched.`);
                },
              })),
            ]),
        }
      : null,
  ]);
}

// ---------- peek: read the end of a session without starting it ----------

async function peekSession(p, s) {
  const turns = await deck.peek({ dir: p.dir, sessionId: s.id });
  // Long tool runs can push your last prompt out of range; show it anyway.
  if (s.lastPrompt && !turns.some((t) => t.role === 'user')) turns.unshift({ role: 'user', text: s.lastPrompt });
  const box = h(
    'div.dialog.wide.peek',
    { tabIndex: -1 },
    h('h3', {}, sessionTitle(s)),
    h('p', {}, `${projectTitle(p)}, last active ${ago(s.mtime)} ago`),
    h(
      'div.peek-turns',
      {},
      turns.length
        ? turns.map((t) => h('div.turn', { class: t.role }, h('b', {}, t.role === 'user' ? 'You' : 'Claude'), h('div', {}, t.text)))
        : h('div.side-empty', {}, 'The end of this session holds only tool activity, with no messages to show.'),
    ),
    h(
      'div.dialog-actions',
      {},
      h('button.btn', { onclick: () => close() }, 'Close'),
      h(
        'button.btn.primary',
        {
          onclick: () => {
            closeOverlay();
            openSession(p, s);
          },
        },
        tabFor(s.id) ? 'Go to terminal' : 'Open session',
      ),
    ),
  );
  const close = openPanel(box);
  box.focus();
  const list = box.querySelector('.peek-turns');
  list.scrollTop = list.scrollHeight;
}

// ---------- a session finished while you were looking elsewhere ----------

function notifyDone(tab) {
  if (S.config.settings.notify === false) return;
  deck.attention();
  if (document.hasFocus()) return;
  const p = projectByDir(tab.dir);
  try {
    const n = new Notification(`${tabTitle(tab)} is ready`, { body: p ? `Finished working in ${projectTitle(p)}` : 'Finished working', silent: true });
    n.onclick = () => {
      deck.focusWindow();
      activate(tab.id);
    };
  } catch {
    // notifications are blocked; the tab highlight still shows it
  }
}

// ---------- accounts: several Claude logins side by side ----------

let accountsPaint = null; // repaints the Accounts panel while it is open

async function refreshAccounts(ids) {
  const list = await deck.accountStatus(ids || null);
  for (const st of list) S.acct.set(st.id, st);
  if (accountsPaint) accountsPaint();
  renderTabs();
  renderStatus();
  return list;
}

// Opens the sign-in in a tab: Claude Code opens the browser and waits there.
// The tab closes by itself once the new login is in place.
function signIn(a) {
  closeOverlay();
  accountsPaint = null;
  const before = (S.acct.get(a.id) || {}).stamp || 0;
  const tab = createTab({ kind: 'login', account: a.id, name: `Sign in: ${a.name}`, dir: null, cwd: null, sessionId: null });
  const check = async () => {
    if (!S.tabs.has(tab.id)) return refreshAccounts([a.id]);
    const [st] = await deck.accountStatus([a.id]);
    if (st && st.loggedIn && st.stamp !== before) {
      S.acct.set(a.id, st);
      closeTab(tab.id, true);
      toast(`${a.name} is signed in as ${st.email || 'your account'}.`);
      renderAll();
      return;
    }
    setTimeout(check, 2500);
  };
  setTimeout(check, 4000);
}

async function editAccount(a) {
  const v = await formDialog({
    title: a ? 'Edit account' : 'Add a Claude account',
    body: a
      ? null
      : 'Give it a name you will recognise, then sign in through your browser. Sessions, settings and memory are shared between accounts, so any session can be continued under any of them.',
    fields: [
      { key: 'name', label: 'Name', value: a ? a.name : '', placeholder: 'Work' },
      { key: 'color', label: 'Colour', type: 'colors', value: a ? a.color : S.colors[(S.config.accounts.length + 1) % S.colors.length] },
    ],
    confirm: a ? 'Save' : 'Add and sign in',
  });
  if (!v || !String(v.name).trim()) return openAccounts();
  if (a) {
    Object.assign(a.id === 'default' ? S.config.mainAccount : a, { name: v.name.trim().slice(0, 30), color: v.color });
    save();
    renderAll();
    return openAccounts();
  }
  const made = { id: 'a' + Date.now().toString(36), name: v.name.trim().slice(0, 30), color: v.color };
  S.config.accounts.push(made);
  save();
  renderAll();
  signIn(made);
}

async function removeAccount(a) {
  const ok = await confirmBox({
    title: `Remove the account "${a.name}"?`,
    body: 'It is signed out and its login is deleted from this PC. Sessions and their history are shared between accounts, so nothing else is lost; sessions that used it go back to the default account.',
    confirm: 'Remove account',
    danger: true,
  });
  if (!ok) return openAccounts();
  const r = await deck.accountRemove(a.id);
  if (!r.ok) {
    toast(r.error, true);
    return openAccounts();
  }
  S.config.accounts = S.config.accounts.filter((x) => x.id !== a.id);
  for (const map of [S.config.sessionAccount, S.config.projectAccount]) for (const [k, id] of Object.entries(map)) if (id === a.id) delete map[k];
  for (const ws of S.config.workspaces || []) if (ws.account === a.id) ws.account = '';
  if (S.config.defaultAccount === a.id) S.config.defaultAccount = 'default';
  S.acct.delete(a.id);
  save();
  renderAll();
  openAccounts();
}

function openAccounts() {
  const rows = h('div.acct-rows');
  const box = h(
    'div.dialog.wide',
    { tabIndex: -1 },
    h('h3', {}, 'Claude accounts'),
    h(
      'p',
      {},
      'Each account is a separate Claude login. Choose one per workspace, project or session, run several at the same time, and move a session to another account when one runs out of usage.',
    ),
    rows,
    h(
      'div.dialog-actions',
      {},
      h('button.btn', { style: 'margin-right:auto', onclick: () => editAccount(null) }, icon('plus'), 'Add account'),
      h('button.btn.primary', { onclick: () => close() }, 'Done'),
    ),
  );
  const paint = () => {
    const def = accountById(S.config.defaultAccount) ? S.config.defaultAccount : 'default';
    const active = S.tabs.get(S.active);
    const front = active && isClaudeTab(active) ? active : null;
    put(
      rows,
      accountList().map((a) => {
        const st = S.acct.get(a.id);
        const inUse = [...S.tabs.values()].filter((t) => t.account === a.id && t.kind !== 'login').length;
        return h(
          'div.acct-row',
          {},
          h('span.acct.big', { style: `--acct:${a.color}` }, a.name.slice(0, 2)),
          h(
            'div.acct-who',
            {},
            h('b', {}, a.name, a.id === def ? h('span.tag', {}, 'default') : null),
            h(
              'span',
              { class: st && !st.loggedIn ? 'warn' : '' },
              accountLine(a.id) + (a.id === 'default' ? '. The Claude Code login already on this PC' : '') + (inUse ? `. ${inUse} open here` : ''),
            ),
          ),
          front && front.account !== a.id && st && st.loggedIn
            ? h(
                'button.btn.small',
                {
                  title: `Restart "${tabTitle(front)}" under this account, at the same point in the conversation`,
                  onclick: () => {
                    closeOverlay();
                    switchAccount(front, a.id);
                  },
                },
                'Use for open session',
              )
            : null,
          h('button.btn.small', { class: st && !st.loggedIn ? 'primary' : '', onclick: () => signIn(a) }, st && st.loggedIn ? 'Sign in again' : 'Sign in'),
          h(
            'button.mini',
            {
              title: 'More',
              onclick: (e) => {
                const r = e.currentTarget.getBoundingClientRect();
                menu(r.left, r.bottom + 4, [
                  a.id === def
                    ? null
                    : {
                        label: 'Use by default',
                        icon: 'pin',
                        run: () => {
                          S.config.defaultAccount = a.id;
                          save();
                          openAccounts();
                        },
                      },
                  { label: 'Rename or recolour', icon: 'pencil', run: () => editAccount(a) },
                  a.id === 'default' ? null : '-',
                  a.id === 'default' ? null : { label: 'Remove account', icon: 'trash', danger: true, run: () => removeAccount(a) },
                ]);
              },
            },
            icon('dots'),
          ),
        );
      }),
    );
  };
  const close = openPanel(box);
  accountsPaint = () => (box.isConnected ? paint() : (accountsPaint = null));
  paint();
  box.focus();
  refreshAccounts();
}
