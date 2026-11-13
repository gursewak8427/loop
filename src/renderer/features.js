/* global deck, MOD, S, h, icon, put, menu, menuAt, closeOverlay, formDialog, confirmBox, toast, save, ago */
/* global projectByDir, projectTitle, sessionTitle, tabTitle, tabFor, lampFor, wsById, wsOf, isHiddenProject, isHiddenSession */
/* global openServers, serverShell, openPhone */
/* global renderStatus, switchAccount, tabTitle, editAccount, */
/* global restartTab, llmFor, activate, formDialog, projectByDir, accountList, accountById, accountLine, multiAccount, isClaudeTab, closeTab, renderAll, renderTabs, renderList */
/* global openSession, newSession, openShell, createTab, createTabs, activate, setLayout, toggleComposer, toggleDrawer, openSettings, focusActive, toggleVoice */
/* global renderDrawer */
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
    { label: 'Accounts', hint: 'Claude, ChatGPT, Grok, Gemini, Kimi, custom', glyph: 'person', rank: 2.5, run: openAccounts },
    { label: 'Custom models', hint: 'Your own API key: Grok, Gemini, OpenRouter …', glyph: 'gear', rank: 2.45, run: openAccounts },
    // Servers and the phone are switched off while they are redone (src/main/switches.js).
    ...(S.switches.servers
      ? [
          { label: 'Servers', hint: 'Run sessions on another machine', glyph: 'server', rank: 2.4, run: openServers },
          ...(S.config.servers || []).map((s) => ({ label: `Terminal on ${s.name}`, hint: s.host, glyph: 'terminal', rank: 2.3, run: () => serverShell(s) })),
        ]
      : []),
    ...(S.switches.phone ? [{ label: 'Your phone', hint: 'Work on these sessions from the Loop app', glyph: 'phone', rank: 2.35, run: openPhone }] : []),
    { label: 'Accessible on the internet', hint: 'Open this PC from loop.prismaple.com and the phone app', glyph: 'cloud', rank: 2.3, run: openInternet },
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

let accountsTab = 'claude'; // the provider Accounts opens on: the one used last
let accountsShow = null; // repaints the open Accounts dialog, when there is one

// The providers, in the order the dialog lists them. `key` is also the logo.
const PROVIDERS = [
  { key: 'claude', name: 'Claude', tool: 'Claude Code' },
  { key: 'codex', name: 'ChatGPT', tool: 'Codex' },
  { key: 'grok', name: 'Grok', tool: 'Grok Build' },
  { key: 'antigravity', name: 'Gemini', tool: 'Antigravity' },
  { key: 'kimi', name: 'Kimi', tool: 'Kimi Code' },
  { key: 'custom', name: 'Custom', tool: 'API key' },
];

function providerCount(key) {
  if (key === 'claude') return accountList().length;
  if (key === 'custom') return (S.llms || []).length;
  const a = agentInfo(key);
  return a.installed ? (a.accounts || []).length : 0;
}

const moreButton = (items) =>
  h(
    'button.mini',
    {
      title: 'More',
      onclick: (e) => {
        const r = e.currentTarget.getBoundingClientRect();
        menu(r.left, r.bottom + 4, items);
      },
    },
    icon('dots'),
  );

const pvAvatar = (name, color) => h('span.pv-av', color ? { style: `--acct:${color}` } : {}, String(name).slice(0, 2));
const signedMark = (word) => h('span.signed-in', {}, icon('check'), word || 'Signed in');

function pvRow(mark, name, isDefault, line, warn, status, more) {
  return h('div.pv-row', {}, mark, h('div.pv-who', {}, h('div', {}, name, isDefault ? h('span.pv-def', {}, 'Default') : null), h('small', { class: warn ? 'warn' : '' }, line)), status, more);
}

function claudePanel() {
  const def = accountById(S.config.defaultAccount) ? S.config.defaultAccount : 'default';
  const active = S.tabs.get(S.active);
  const front = active && isClaudeTab(active) ? active : null;
  const rows = accountList().map((a) => {
    const st = S.acct.get(a.id);
    const ok = st && st.loggedIn;
    return pvRow(
      pvAvatar(a.name, a.color),
      a.name,
      a.id === def,
      accountLine(a.id),
      st && !st.loggedIn,
      ok ? signedMark() : h('button.btn.small.primary', { onclick: () => signIn(a) }, 'Sign in'),
      moreButton([
        front && front.account !== a.id && ok
          ? {
              label: `Use for "${tabTitle(front)}"`,
              icon: 'refresh',
              run: () => {
                closeOverlay();
                switchAccount(front, a.id);
              },
            }
          : null,
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
        ok ? { label: 'Sign in again', icon: 'person', run: () => signIn(a) } : null,
        { label: 'Rename or recolour', icon: 'pencil', run: () => editAccount(a) },
        a.id === 'default' ? null : '-',
        a.id === 'default' ? null : { label: 'Remove', icon: 'trash', danger: true, run: () => removeAccount(a) },
      ]),
    );
  });
  return [h('div.pv-list', {}, rows), h('button.pv-add', { onclick: () => editAccount(null) }, icon('plus'), 'Add account')];
}

const agentAccountMeta = (agent, id) => (id === 'default' ? { id, name: 'Main' } : (S.config.agentAccounts || []).find((x) => x.agent === agent && x.id === id) || { id, name: id });

function agentPanel(key) {
  const a = agentInfo(key);
  if (!a.installed) {
    return h(
      'div.pv-empty',
      {},
      a.canInstall ? h('button.btn', { onclick: () => agentInstall(a) }, icon('plus'), `Install ${a.tool}`) : h('span', {}, `Install ${a.tool} from its website, then reopen Accounts.`),
    );
  }
  const def = (S.config.agentDefault || {})[key] || 'default';
  const rows = (a.accounts || []).map((acc) => {
    const meta = agentAccountMeta(key, acc.id);
    const good = acc.signedIn && !acc.apiKey;
    const line = acc.signedIn === null ? 'Signs in when a session first starts' : !acc.signedIn ? 'Not signed in' : acc.apiKey ? 'Signed in with an API key, not your plan' : `Your ${acc.how || a.plan}`;
    return pvRow(
      pvAvatar(meta.name, meta.color),
      meta.name,
      acc.id === def,
      line,
      acc.signedIn === false || acc.apiKey,
      good ? signedMark() : acc.signedIn === null ? null : h('button.btn.small.primary', { onclick: () => agentSignIn(a, acc.id) }, acc.apiKey ? 'Use your plan' : 'Sign in'),
      moreButton([
        acc.id === def
          ? null
          : {
              label: 'Use by default',
              icon: 'pin',
              run: () => {
                S.config.agentDefault = { ...(S.config.agentDefault || {}), [key]: acc.id };
                save();
                openAccounts();
              },
            },
        { label: good ? 'Sign in again' : 'Sign in', icon: 'person', run: () => agentSignIn(a, acc.id) },
        acc.id === 'default' ? null : { label: 'Rename', icon: 'pencil', run: () => renameAgentAccount(a, meta) },
        acc.id === 'default' ? null : '-',
        acc.id === 'default' ? null : { label: 'Remove', icon: 'trash', danger: true, run: () => removeAgentAccount(a, meta) },
      ]),
    );
  });
  return [h('div.pv-list', {}, rows), a.multi ? h('button.pv-add', { onclick: () => addAgentAccount(a) }, icon('plus'), 'Add account') : null];
}

function customPanel() {
  const inUse = (m) => [...S.tabs.values()].filter((t) => isClaudeTab(t) && llmFor(t.dir, t.sessionId) === m.id).length;
  const rows = (S.llms || []).map((m) =>
    pvRow(
      h('span.pv-av.logo', {}, brandIcon(presetBrand(m.preset))),
      m.name,
      false,
      `${m.model}${m.hasKey ? '' : ', no key'}${inUse(m) ? `, ${inUse(m)} open` : ''}`,
      false,
      signedMark('Ready'),
      moreButton([{ label: 'Edit', icon: 'pencil', run: () => editLlm(m) }, '-', { label: 'Remove', icon: 'trash', danger: true, run: () => removeLlm(m) }]),
    ),
  );
  return [rows.length ? h('div.pv-list', {}, rows) : null, h('button.pv-add', { onclick: () => editLlm(null) }, icon('plus'), 'Add model')];
}

function openAccounts(tab) {
  if (typeof tab === 'string') accountsTab = tab;
  const nav = h('div.pv-nav', { role: 'tablist' });
  const pane = h('div.pv-pane');
  const box = h(
    'div.dialog.wide.pv-dialog',
    { tabIndex: -1 },
    h('h3', {}, 'Accounts'),
    h('div.pv-grid', {}, nav, pane),
    h('div.dialog-actions', {}, h('button.btn.primary', { onclick: () => close() }, 'Done')),
  );
  const paint = () => {
    if (!PROVIDERS.some((p) => p.key === accountsTab)) accountsTab = 'claude';
    put(
      nav,
      PROVIDERS.map((p) => {
        const n = providerCount(p.key);
        const on = p.key === accountsTab;
        return h(
          'button.pv-tab',
          {
            class: `pv-${p.key}${on ? ' on' : ''}`,
            role: 'tab',
            'aria-selected': String(on),
            onclick: () => {
              accountsTab = p.key;
              paint();
            },
          },
          h('span.pv-logo', {}, brandIcon(p.key)),
          h('span.pv-name', {}, p.name, h('small', {}, p.tool)),
          n ? h('span.pv-n', {}, String(n)) : null,
        );
      }),
    );
    const p = PROVIDERS.find((x) => x.key === accountsTab);
    const a = p.key === 'claude' || p.key === 'custom' ? null : agentInfo(p.key);
    pane.className = `pv-pane pv-${p.key}`;
    put(
      pane,
      h('div.pv-head', {}, h('span.pv-logo.big', {}, brandIcon(p.key)), h('span.pv-title', {}, h('b', {}, p.name), ` · ${p.tool}`), a && !a.installed ? h('span.pv-note', {}, 'Not installed') : null),
      p.key === 'claude' ? claudePanel() : p.key === 'custom' ? customPanel() : agentPanel(p.key),
    );
  };
  const close = openPanel(box);
  accountsPaint = () => (box.isConnected ? paint() : (accountsPaint = null));
  accountsShow = accountsPaint;
  paint();
  box.focus();
  refreshAccounts();
}

async function addAgentAccount(a) {
  const v = await formDialog({ title: `Add a ${a.name} account`, fields: [{ key: 'name', label: 'Name', value: '', placeholder: 'Work' }], confirm: 'Add and sign in' });
  if (!v || !String(v.name).trim()) return openAccounts();
  const made = { id: 'x' + Date.now().toString(36), agent: a.id, name: v.name.trim().slice(0, 30) };
  S.config.agentAccounts = [...(S.config.agentAccounts || []), made];
  save();
  agentSignIn(a, made.id);
}

async function renameAgentAccount(a, meta) {
  const v = await formDialog({ title: 'Rename account', fields: [{ key: 'name', label: 'Name', value: meta.name }] });
  if (v && String(v.name).trim()) {
    const x = (S.config.agentAccounts || []).find((y) => y.agent === a.id && y.id === meta.id);
    if (x) x.name = v.name.trim().slice(0, 30);
    save();
  }
  openAccounts();
}

async function removeAgentAccount(a, meta) {
  const ok = await confirmBox({ title: `Remove "${meta.name}"?`, body: `It is signed out of ${a.name} and its login is deleted from this PC. Conversations stay.`, confirm: 'Remove', danger: true });
  if (!ok) return openAccounts();
  const r = await deck.agentRemoveAccount(a.id, meta.id);
  if (!r.ok) {
    toast(r.error, true);
    return openAccounts();
  }
  S.config.agentAccounts = (S.config.agentAccounts || []).filter((x) => !(x.agent === a.id && x.id === meta.id));
  if ((S.config.agentDefault || {})[a.id] === meta.id) delete S.config.agentDefault[a.id];
  for (const rec of Object.values(S.config.agentSessions || {})) if (rec.agent === a.id && rec.account === meta.id) rec.account = 'default';
  save();
  await refreshAgents();
  openAccounts();
}

// ---------- models other than Claude: Grok, Gemini, or any API ----------

const llmById = (id) => (S.llms || []).find((m) => m.id === id);

// Most specific choice wins: the session, then its project. Empty means Claude.
function llmFor(dir, sessionId) {
  const id = (sessionId && S.config.sessionLlm[sessionId]) || (dir && S.config.projectLlm[dir]) || '';
  return id !== 'claude' && llmById(id) ? id : '';
}

const llmName = (id) => (llmById(id) ? llmById(id).name : 'Claude');

function llmChip(id) {
  const m = llmById(id);
  return h('span.acct.llm', { style: '--acct:#b79cf2', title: `Runs on ${m.name}\n${m.model}` }, m.name.split(' ')[0].slice(0, 10));
}

function llmMenu(x, y, heading, current, reset, pick) {
  menu(x, y, [
    { heading },
    { label: 'Claude', hint: 'Your Claude account', checked: !current, run: () => pick('claude') },
    ...(S.llms || []).map((m) => ({ label: m.name, hint: m.model, checked: m.id === current, run: () => pick(m.id) })),
    reset ? '-' : null,
    reset ? { label: reset, icon: 'refresh', run: () => pick(null) } : null,
    '-',
    { label: 'Add a model', icon: 'plus', run: () => editLlm(null) },
    { label: 'Accounts and models', icon: 'gear', run: openAccounts },
  ]);
}

// A session already running has to restart to change model. The conversation is kept.
async function setSessionLlm(p, s, id) {
  const before = llmFor(p.dir, s.id);
  const after = id === null ? llmFor(p.dir, null) : id === 'claude' ? '' : id;
  const tab = tabFor(s.id);
  if (before !== after && tab) {
    const lamp = lampFor(s.id, tab);
    if (lamp === 'busy' || lamp === 'shell') {
      const ok = await confirmBox({
        title: `"${tabTitle(tab)}" is still working`,
        body: `Moving it to ${llmName(after)} restarts the session. The conversation is kept, but the step in progress is lost.`,
        confirm: 'Change model',
        danger: true,
      });
      if (!ok) return;
    }
  }
  if (id) S.config.sessionLlm[s.id] = id;
  else delete S.config.sessionLlm[s.id];
  save();
  if (before === after) return renderAll();
  if (tab) await restartTab(tab);
  else await deck.directStop(s.id);
  renderAll();
  toast(`${sessionTitle(s)} now runs on ${llmName(after)}.`);
}

const sessionLlmMenu = (x, y, p, s) => llmMenu(x, y, `Run ${sessionTitle(s)} on`, llmFor(p.dir, s.id), S.config.sessionLlm[s.id] ? 'Follow the project' : null, (id) => setSessionLlm(p, s, id));

function projectLlmMenu(x, y, p) {
  llmMenu(x, y, `Sessions in ${projectTitle(p)} run on`, llmFor(p.dir, null), null, (id) => {
    if (id === 'claude') delete S.config.projectLlm[p.dir];
    else S.config.projectLlm[p.dir] = id;
    save();
    renderAll();
    toast('Applies to sessions opened from now on. Open terminals keep their model until you change them.');
  });
}

async function refreshLlms() {
  S.llms = await deck.llmList();
  renderAll();
}

async function editLlm(m) {
  const presets = await deck.llmPresets();
  const presetOf = (id) => presets.find((p) => p.id === id) || presets[presets.length - 1];
  const field = (label, control, hint) => h('label.field', {}, h('span', {}, label), control, hint || null);
  const provider = h('select', {}, presets.map((p) => h('option', { value: p.id }, p.name)));
  const name = h('input', { type: 'text', placeholder: 'Grok for reviews' });
  const baseUrl = h('input', { type: 'text', placeholder: 'https://api.example.com/v1' });
  const protocol = h('select', {}, h('option', { value: 'openai' }, 'OpenAI compatible'), h('option', { value: 'anthropic' }, 'Anthropic compatible'));
  const key = h('input', { type: 'password', autocomplete: 'off', placeholder: m && m.hasKey ? 'Saved. Leave empty to keep it.' : 'Paste your API key' });
  const keyHint = h('small');
  const choices = h('datalist', { id: 'llm-models' });
  const model = h('input', { type: 'text', list: 'llm-models', placeholder: 'Press "List models", or type a name' });
  const status = h('p.llm-status');

  const say = (text, bad) => {
    status.textContent = text;
    status.classList.toggle('bad', Boolean(bad));
  };
  const details = () => ({ id: m && m.id, name: name.value, preset: provider.value, protocol: protocol.value, baseUrl: baseUrl.value, model: model.value, key: key.value });
  const applyPreset = (fill) => {
    const p = presetOf(provider.value);
    if (fill) {
      name.value = p.id === 'custom' ? '' : p.name;
      baseUrl.value = p.baseUrl;
      protocol.value = p.protocol;
      model.value = '';
      choices.replaceChildren();
    }
    keyHint.textContent = p.noKey ? 'Not needed for a model on this PC.' : p.keys ? `Get one at ${p.keys}. It is stored encrypted on this PC.` : 'It is stored encrypted on this PC.';
  };
  provider.addEventListener('change', () => applyPreset(true));
  if (m) {
    provider.value = m.preset;
    name.value = m.name;
    baseUrl.value = m.baseUrl;
    protocol.value = m.protocol;
    model.value = m.model;
    applyPreset(false);
  } else applyPreset(true);

  const listModels = async () => {
    say('Asking the provider for its models…');
    const r = await deck.llmModels(details());
    if (!r.ok) return say(r.error, true);
    choices.replaceChildren(...r.models.map((id) => h('option', { value: id })));
    say(r.models.length ? `${r.models.length} models found. Click the Model box to pick one.` : 'The provider listed no models. Type the name instead.');
    model.focus();
  };
  const check = async () => {
    say('Sending one short test message…');
    const r = await deck.llmCheck(details());
    say(r.ok ? 'It works. The model answered.' : r.error, !r.ok);
  };
  const box = h(
    'form.dialog.wide',
    {
      onsubmit: async (e) => {
        e.preventDefault();
        const r = await deck.llmSave(details());
        if (!r.ok) return say(r.error, true);
        await refreshLlms();
        openLlms();
      },
    },
    h('h3', {}, m ? `Edit ${m.name}` : 'Add a model'),
    field('Provider', provider),
    field('Name', name),
    field('Address', baseUrl),
    field('API format', protocol),
    field('API key', key, keyHint),
    field('Model', model),
    choices,
    status,
    h(
      'div.dialog-actions',
      {},
      h('button.btn', { type: 'button', onclick: listModels }, 'List models'),
      h('button.btn', { type: 'button', style: 'margin-right:auto', onclick: check }, 'Check it works'),
      h('button.btn', { type: 'button', onclick: openLlms }, 'Cancel'),
      h('button.btn.primary', { type: 'submit' }, 'Save'),
    ),
  );
  openPanel(box);
  name.focus();
}

async function removeLlm(m) {
  const open = [...S.tabs.values()].filter((t) => isClaudeTab(t) && llmFor(t.dir, t.sessionId) === m.id);
  if (open.length) {
    toast(`Close the ${open.length === 1 ? 'session' : `${open.length} sessions`} running on ${m.name} first.`, true);
    return openLlms();
  }
  const ok = await confirmBox({ title: `Remove ${m.name}?`, body: 'Its API key is deleted from this PC. Sessions that used it go back to Claude, with their conversations kept.', confirm: 'Remove', danger: true });
  if (ok) {
    for (const map of [S.config.sessionLlm, S.config.projectLlm]) for (const [k, id] of Object.entries(map)) if (id === m.id) delete map[k];
    save();
    await deck.llmRemove(m.id);
    await refreshLlms();
  }
  openLlms();
}

// Every way to open the models list now leads to Accounts, where it is one group.
function openLlms() {
  openAccounts('custom');
}

// ---------- other agents, each signed in with its own plan ----------
// ChatGPT through Codex, Grok through Grok Build, Gemini through Antigravity,
// Kimi through Kimi Code. Each runs its own program in a terminal, billed to
// its own subscription. Loop keeps a list of these sessions per project.

// A custom model's preset, as the mark to show for it.
const presetBrand = (preset) => ({ grok: 'grok', gemini: 'antigravity', openai: 'codex', kimi: 'kimi' })[preset] || preset || 'custom';

const LOGOS = {
  claude: [
    ['M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z', '#D97757'],
  ],
  codex: [
    ['M21.55 10.004a5.416 5.416 0 00-.478-4.501c-1.217-2.09-3.662-3.166-6.05-2.66A5.59 5.59 0 0010.831 1C8.39.995 6.224 2.546 5.473 4.838A5.553 5.553 0 001.76 7.496a5.487 5.487 0 00.691 6.5 5.416 5.416 0 00.477 4.502c1.217 2.09 3.662 3.165 6.05 2.66A5.586 5.586 0 0013.168 23c2.443.006 4.61-1.546 5.361-3.84a5.553 5.553 0 003.715-2.66 5.488 5.488 0 00-.693-6.497v.001zm-8.381 11.558a4.199 4.199 0 01-2.675-.954c.034-.018.093-.05.132-.074l4.44-2.53a.71.71 0 00.364-.623v-6.176l1.877 1.069c.02.01.033.029.036.05v5.115c-.003 2.274-1.87 4.118-4.174 4.123zM4.192 17.78a4.059 4.059 0 01-.498-2.763c.032.02.09.055.131.078l4.44 2.53c.225.13.504.13.73 0l5.42-3.088v2.138a.068.068 0 01-.027.057L9.9 19.288c-1.999 1.136-4.552.46-5.707-1.51h-.001zM3.023 8.216A4.15 4.15 0 015.198 6.41l-.002.151v5.06a.711.711 0 00.364.624l5.42 3.087-1.876 1.07a.067.067 0 01-.063.005l-4.489-2.559c-1.995-1.14-2.679-3.658-1.53-5.63h.001zm15.417 3.54l-5.42-3.088L14.896 7.6a.067.067 0 01.063-.006l4.489 2.557c1.998 1.14 2.683 3.662 1.529 5.633a4.163 4.163 0 01-2.174 1.807V12.38a.71.71 0 00-.363-.623zm1.867-2.773a6.04 6.04 0 00-.132-.078l-4.44-2.53a.731.731 0 00-.729 0l-5.42 3.088V7.325a.068.068 0 01.027-.057L14.1 4.713c2-1.137 4.555-.46 5.707 1.513.487.833.664 1.809.499 2.757h.001zm-11.741 3.81l-1.877-1.068a.065.065 0 01-.036-.051V6.559c.001-2.277 1.873-4.122 4.181-4.12.976 0 1.92.338 2.671.954-.034.018-.092.05-.131.073l-4.44 2.53a.71.71 0 00-.365.623l-.003 6.173v.002zm1.02-2.168L12 9.25l2.414 1.375v2.75L12 14.75l-2.415-1.375v-2.75z', 'currentColor'],
  ],
  grok: [
    ['M9.27 15.29l7.978-5.897c.391-.29.95-.177 1.137.272.98 2.369.542 5.215-1.41 7.169-1.951 1.954-4.667 2.382-7.149 1.406l-2.711 1.257c3.889 2.661 8.611 2.003 11.562-.953 2.341-2.344 3.066-5.539 2.388-8.42l.006.007c-.983-4.232.242-5.924 2.75-9.383.06-.082.12-.164.179-.248l-3.301 3.305v-.01L9.267 15.292M7.623 16.723c-2.792-2.67-2.31-6.801.071-9.184 1.761-1.763 4.647-2.483 7.166-1.425l2.705-1.25a7.808 7.808 0 00-1.829-1A8.975 8.975 0 005.984 5.83c-2.533 2.536-3.33 6.436-1.962 9.764 1.022 2.487-.653 4.246-2.34 6.022-.599.63-1.199 1.259-1.682 1.925l7.62-6.815', 'currentColor'],
  ],
  antigravity: [
    ['M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z', '#3186FF'],
  ],
  kimi: [
    ['M19.738 5.776c.163-.209.306-.4.457-.585.07-.087.064-.153-.004-.244-.655-.861-.717-1.817-.34-2.787.283-.73.909-1.072 1.674-1.145.477-.045.945.004 1.379.236.57.305.902.77 1.01 1.412.086.512.07 1.012-.075 1.508-.257.878-.888 1.333-1.753 1.448-.718.096-1.446.108-2.17.157-.056.004-.113 0-.178 0z', '#027AFF'],
    ['M17.962 1.844h-4.326l-3.425 7.81H5.369V1.878H1.5V22h3.87v-8.477h6.824a3.025 3.025 0 002.743-1.75V22h3.87v-8.477a3.87 3.87 0 00-3.588-3.86v-.01h-2.125a3.94 3.94 0 002.323-2.12l2.545-5.689z', 'currentColor'],
  ],
};

// Custom models without a logo of their own: a letter in a colour.
const LETTERS = {
  openrouter: ['O', '#8b8ff7'],
  groq: ['G', '#f55036'],
  mistral: ['M', '#fa7a3c'],
  deepseek: ['D', '#6f86ff'],
  glm: ['Z', '#5aa2f7'],
  ollama: ['O', '#e8edf2'],
};

// The provider's logo, so a glance tells which plan a session runs on.
function brandIcon(id) {
  if (id === 'custom') return icon('key');
  const paths = LOGOS[id];
  if (!paths) {
    const [letter, color] = LETTERS[id] || ['?', '#93a6b5'];
    return h('span.brand-ic.letter', { style: `--brand:${color}` }, letter);
  }
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'brand-ic');
  for (const [d, fill] of paths) {
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', fill);
    svg.append(path);
  }
  return svg;
}

const agentInfo = (id) => (S.agents || []).find((a) => a.id === id) || { id, name: id, tool: id, installed: false };
const installedAgents = () => (S.agents || []).filter((a) => a.installed);
const agentTabFor = (recId) => [...S.tabs.values()].find((t) => t.kind === 'agent' && t.agentSession === recId);
const agentRecords = (dir) =>
  Object.values(S.config.agentSessions || {})
    .filter((r) => r.dir === dir)
    .sort((a, b) => b.created - a.created);

async function refreshAgents() {
  try {
    S.agents = await deck.agentList();
  } catch {
    S.agents = [];
  }
  renderAll();
  if (accountsShow) accountsShow();
}

// The provider writes down a new conversation only once it has started one, so
// Loop looks for its id for a while and keeps it, to reopen that conversation.
function watchNative(rec) {
  let tries = 0;
  const look = async () => {
    if (rec.native || tries++ > 60 || !S.config.agentSessions[rec.id]) return;
    const id = await deck.agentFind({ agent: rec.agent, cwd: rec.cwd, since: rec.created });
    if (id) {
      rec.native = id;
      save();
      return;
    }
    setTimeout(look, 10000);
  };
  setTimeout(look, 5000);
}

function openAgentSession(rec, activateIt = true) {
  const open = agentTabFor(rec.id);
  if (open) return activate(open.id);
  const p = projectByDir(rec.dir);
  if (p && !p.exists) return toast('That project folder was moved or deleted.', true);
  if (!rec.memberId) {
    rec.memberId = crypto.randomUUID();
    save();
  }
  createTab({ kind: 'agent', agent: rec.agent, memberId: rec.memberId, agentAccount: rec.account || 'default', agentSession: rec.id, dir: rec.dir, cwd: rec.cwd, sessionId: null, name: rec.name, native: rec.native || '', cont: Boolean(rec.started && !rec.native) }, activateIt);
  if (!rec.started) {
    rec.started = Date.now();
    save();
  }
  if (!rec.native && ['codex', 'kimi'].includes(rec.agent)) watchNative(rec);
  renderList();
}

function newAgentSession(p, agentId, name) {
  const a = agentInfo(agentId);
  if (!a.installed) {
    toast(`${a.tool} is not installed. Set it up in Accounts.`, true);
    return openAccounts(a.id);
  }
  const account = (S.config.agentDefault || {})[agentId] || 'default';
  const login = (a.accounts || []).find((x) => x.id === account) || a;
  if (login.signedIn === false) {
    toast(`Sign in to ${a.name} first. A session starts once that is done.`);
    return agentSignIn(a, account);
  }
  const id = 'ag' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const rec = { id, agent: agentId, account, memberId: crypto.randomUUID(), dir: p.dir, cwd: p.path, name: name || `${a.name} session`, created: Date.now(), started: 0, native: '' };
  S.config.agentSessions[id] = rec;
  save();
  openAgentSession(rec);
}

function agentPickMenu(x, y, p) {
  menu(x, y, [
    { heading: `New session in ${projectTitle(p)} with` },
    ...(S.agents || []).map((a) =>
      a.installed
        ? { label: a.name, hint: a.signedIn === false ? `${a.tool}, not signed in yet` : a.tool, run: () => newAgentSession(p, a.id, '') }
        : { label: a.name, hint: `${a.tool} is not installed`, run: () => openAccounts(a.id) },
    ),
    '-',
    { label: 'Accounts', icon: 'gear', run: () => openAccounts('codex') },
  ]);
}

// An agent with more than one login gets a chip naming which one a session uses,
// like Claude's accounts. The main login is first in the colours.
const AGENT_ACCT_COLORS = ['#8fb8de', '#f2b77c', '#9bd99b', '#f29cc4', '#c9b3f5', '#e8d47a'];
function agentAccountOf(rec) {
  const extra = (S.config.agentAccounts || []).filter((x) => x.agent === rec.agent);
  const id = rec.account || 'default';
  const meta = agentAccountMeta(rec.agent, id);
  const at = id === 'default' ? 0 : extra.findIndex((x) => x.id === id) + 1;
  const st = (agentInfo(rec.agent).accounts || []).find((x) => x.id === id) || {};
  return { multi: extra.length > 0, name: meta.name, email: st.email || '', color: AGENT_ACCT_COLORS[Math.max(0, at) % AGENT_ACCT_COLORS.length] };
}

function agentRowTitle(rec, a, model) {
  const acct = agentAccountOf(rec);
  const line = [a.tool, model, acct.multi ? `${acct.name} account` : ''].filter(Boolean).join(' · ');
  return `${rec.name}\n${line}\nWith your ${a.name} plan`;
}

function agentRows(p) {
  return agentRecords(p.dir).map((rec) => {
    const tab = agentTabFor(rec.id);
    const a = agentInfo(rec.agent);
    return h(
      'button.session.agent-session',
      {
        class: [tab ? 'open' : '', tab && tab.id === S.active ? 'active' : ''].join(' '),
        title: agentRowTitle(rec, a, ''),
        // The model is read from the agent's own file when the row is pointed at.
        onmouseenter: (e) => {
          const el = e.currentTarget;
          if (!rec.native) return;
          deck
            .agentModel({ agent: rec.agent, native: rec.native })
            .then((m) => {
              if (m) el.title = agentRowTitle(rec, a, m);
            })
            .catch(() => {});
        },
        onclick: () => openAgentSession(rec),
        oncontextmenu: (e) => {
          e.preventDefault();
          menu(e.clientX, e.clientY, [
            { heading: rec.name },
            {
              label: 'Rename',
              icon: 'pencil',
              run: async () => {
                const v = await formDialog({ title: 'Rename session', fields: [{ key: 'name', label: 'Name', value: rec.name }] });
                if (v && v.name.trim()) {
                  rec.name = v.name.trim();
                  save();
                  renderAll();
                }
              },
            },
            { label: 'Runs on', hint: runsOnLine(p, { id: rec.memberId, name: rec.name, agent: rec.agent, rec }), icon: 'spark', sub: (el) => runsOnPicker(el, p, { id: rec.memberId, name: rec.name, agent: rec.agent, rec }) },
            {
              label: 'Remove from Loop',
              icon: 'trash',
              danger: true,
              run: () => {
                if (agentTabFor(rec.id)) return toast('Close its terminal first.', true);
                delete S.config.agentSessions[rec.id];
                save();
                renderList();
                toast(`Removed from the list. The conversation is still kept by ${a.tool}.`);
              },
            },
          ]);
        },
      },
      brandIcon(rec.agent),
      h('span.title', {}, rec.name),
      (() => {
        const acct = agentAccountOf(rec);
        return acct.multi ? h('span.acct', { style: `--acct:${acct.color}`, title: `Account: ${acct.name}${acct.email ? '\n' + acct.email : ''}` }, acct.name.slice(0, 2)) : null;
      })(),
      h('span.tag', {}, a.name),
    );
  });
}

function agentSignIn(a, account = 'default') {
  closeOverlay();
  const meta = agentAccountMeta(a.id, account);
  const before = JSON.stringify(((agentInfo(a.id).accounts || []).find((x) => x.id === account)) || {});
  const tab = createTab({ kind: 'agentLogin', agent: a.id, agentAccount: account, name: `Sign in: ${a.name}${account === 'default' ? '' : ` (${meta.name})`}`, dir: null, cwd: null, sessionId: null });
  let tries = 0;
  const check = async () => {
    await refreshAgents();
    const now = (agentInfo(a.id).accounts || []).find((x) => x.id === account) || {};
    if (now.signedIn && !now.apiKey && JSON.stringify(now) !== before) {
      if (S.tabs.has(tab.id)) closeTab(tab.id, true);
      toast(`${a.name} (${meta.name}) is signed in.`);
      return;
    }
    if (S.tabs.has(tab.id) && tries++ < 60) setTimeout(check, 5000);
  };
  setTimeout(check, 5000);
}

async function agentInstall(a) {
  const ok = await confirmBox({
    title: `Install ${a.tool}?`,
    body: `Loop runs ${a.name}'s official installer for ${a.tool} in a terminal, so you can watch it. Then sign in with your ${a.plan} plan.`,
    confirm: 'Install',
  });
  if (!ok) return openAccounts();
  closeOverlay();
  const tab = createTab({ kind: 'agentInstall', agent: a.id, name: `Install ${a.tool}`, dir: null, cwd: null, sessionId: null });
  const wait = () => (S.tabs.has(tab.id) && !S.tabs.get(tab.id).exited ? setTimeout(wait, 4000) : refreshAgents());
  setTimeout(wait, 8000);
  setTimeout(refreshAgents, 45000);
}


// ---------- bringing each agent's own memory into Loop's ----------

let importTab = 'claude';

function openImport(p) {
  const nav = h('div.pv-nav', { role: 'tablist' });
  const pane = h('div.pv-pane');
  const foot = h('div.dialog-actions.import-foot');
  const picked = new Set();
  let items = [];
  let asking = null; // the ids waiting for a yes, while the footer asks

  const box = h('div.dialog.wide.pv-dialog.import-dialog', { tabIndex: -1 }, h('h3', {}, `Import memories into ${projectTitle(p)}`), h('div.pv-grid', {}, nav, pane), foot);
  const waiting = () => items.filter((x) => x.agent === importTab && !x.imported);
  const pickedHere = () => waiting().filter((x) => picked.has(x.id));
  const providerName = () => (PROVIDERS.find((x) => x.key === importTab) || { name: '' }).name;
  const word = (n) => `${n} ${n === 1 ? 'memory' : 'memories'}`;

  const ask = (ids) => {
    if (!ids.length) return toast(picked.size ? 'Those are in Loop already.' : 'Choose at least one memory to import.', true);
    asking = ids;
    paintFoot();
  };
  const run = async () => {
    const ids = asking;
    asking = null;
    paintFoot(true);
    const n = await deck.memImport({ dir: p.dir, path: p.path, ids });
    toast(n ? `${word(n)} now in Loop. The originals were left as they are.` : 'Those are in Loop already.');
    picked.clear();
    await load();
    if (S.drawer && S.drawer.open) loadNotes();
  };

  // The buttons stay at the bottom; importing always asks first, right there.
  function paintFoot(busy) {
    if (busy) return put(foot, h('span.import-ask', {}, 'Importing…'));
    if (asking) {
      return put(
        foot,
        h('span.import-ask', {}, h('b', {}, `Import ${word(asking.length)} into ${projectTitle(p)}?`), h('small', {}, 'Loop keeps a copy. Your original files and sessions are only read: nothing is changed or deleted.')),
        h(
          'button.btn',
          {
            onclick: () => {
              asking = null;
              paintFoot();
            },
          },
          'Back',
        ),
        h('button.btn.primary', { onclick: run }, 'Import'),
      );
    }
    const all = waiting().length;
    const sel = pickedHere().length;
    put(
      foot,
      h('button.btn', { style: 'margin-right:auto', onclick: () => close() }, 'Cancel'),
      h('button.btn', { onclick: () => ask(waiting().map((x) => x.id)) }, all ? `Import all from ${providerName()} (${all})` : 'Import all'),
      h('button.btn.primary', { onclick: () => ask(pickedHere().map((x) => x.id)) }, sel ? `Import selected (${sel})` : 'Import selected'),
    );
  }

  const paint = () => {
    const tabs = PROVIDERS.filter((x) => x.key !== 'custom');
    put(
      nav,
      tabs.map((x) => {
        const n = items.filter((i) => i.agent === x.key && !i.imported).length;
        const on = x.key === importTab;
        return h(
          'button.pv-tab',
          {
            class: `pv-${x.key}${on ? ' on' : ''}`,
            role: 'tab',
            'aria-selected': String(on),
            onclick: () => {
              importTab = x.key;
              asking = null;
              paint();
            },
          },
          h('span.pv-logo', {}, brandIcon(x.key)),
          h('span.pv-name', {}, x.name, h('small', {}, x.tool)),
          n ? h('span.pv-n', {}, String(n)) : null,
        );
      }),
    );
    const prov = PROVIDERS.find((x) => x.key === importTab);
    const mine = items.filter((i) => i.agent === importTab);
    const open = waiting();
    const allOn = open.length > 0 && open.every((x) => picked.has(x.id));
    pane.className = `pv-pane pv-${importTab}`;
    const selectAll = h('input', {
      type: 'checkbox',
      checked: allOn,
      onchange: (e) => {
        for (const x of open) e.target.checked ? picked.add(x.id) : picked.delete(x.id);
        paint();
      },
    });
    put(
      pane,
      h(
        'div.pv-head.import-head',
        {},
        h('span.pv-logo.big', {}, brandIcon(importTab)),
        h('span.pv-title', {}, h('b', {}, prov.name), ` · ${prov.tool}`),
        open.length ? h('label.import-all', {}, selectAll, `Select all (${open.length})`) : null,
      ),
      mine.length
        ? h(
            'div.pv-list',
            {},
            mine.map((i) => {
              const tick = h('input', {
                type: 'checkbox',
                checked: picked.has(i.id),
                disabled: i.imported,
                onchange: (e) => {
                  e.target.checked ? picked.add(i.id) : picked.delete(i.id);
                  paint();
                },
              });
              return h(
                'label.pv-row.pick',
                { title: i.file, class: i.imported ? 'done' : '' },
                tick,
                h('div.pv-who', {}, h('div', {}, i.title), h('small', {}, i.file)),
                h('span.pv-def', {}, i.scope === 'company' ? 'All projects' : 'This project'),
                i.imported ? h('span.signed-in', {}, icon('check'), 'In Loop') : null,
              );
            }),
          )
        : h('div.pv-empty', {}, `No ${prov.name} memories for this project.`),
    );
    paintFoot();
  };
  const load = async () => {
    items = await deck.memImportList({ dir: p.dir, path: p.path });
    paint();
  };
  const close = openPanel(box);
  paint();
  load();
  box.focus();
}

// ---------- one session, any agent ----------
// A session's memory is the session's: switching agent keeps the session, its
// name, its role and its memory, and hands over where the last agent left off.

function switchAgentMenu(x, y, p, from) {
  const choices = [{ id: 'claude', name: 'Claude', tool: 'Claude Code', installed: true }, ...(S.agents || [])];
  menu(x, y, [
    { heading: `Run ${from.name} with` },
    ...choices.map((a) => ({
      label: a.name,
      hint: a.id === from.agent ? 'Working on it now' : a.installed ? a.tool : `${a.tool} is not installed`,
      checked: a.id === from.agent,
      run: () => (a.id === from.agent ? null : a.installed ? switchAgent(p, from, a.id) : openAccounts(a.id)),
    })),
  ]);
}

// What the last agent said and was asked, saved to the session's memory so the
// next one starts from there. Only the session's own words; nothing is sent anywhere.
async function handOver(p, from) {
  let turns = [];
  if (from.agent === 'claude') turns = await deck.peek({ dir: p.dir, sessionId: from.id }).catch(() => []);
  else if (from.rec && from.rec.native) turns = await deck.agentTurns({ agent: from.agent, native: from.rec.native }).catch(() => []);
  const tail = (turns || []).slice(-6).map((t) => `**${t.role === 'user' ? 'You' : 'Agent'}:** ${String(t.text || '').slice(0, 800)}`);
  const who = from.agent === 'claude' ? 'Claude' : agentInfo(from.agent).name;
  const body = [`${who} worked in this session until ${new Date().toLocaleString()}.`, tail.length ? '\n## The last exchange\n\n' + tail.join('\n\n') : '', '\nRead the rest of this session’s memory before you go on.'].join('\n');
  await deck.memSave({ dir: p.dir, scope: from.id, title: `Handover from ${who}`, body, tags: ['handover'], author: 'Loop' });
}

async function switchAgent(p, from, to, opts = {}) {
  const open = from.agent === 'claude' ? tabFor(from.id) : from.rec && agentTabFor(from.rec.id);
  if (open) {
    const ok = await confirmBox({ title: `Switch ${from.name}?`, body: 'Its terminal closes and the new agent opens in its place. The session keeps its name, role and memory.', confirm: 'Switch agent' });
    if (!ok) return;
  }
  await handOver(p, from).catch(() => {});
  if (open) await closeTab(open.id, { stop: true });
  if (to === 'claude') {
    // Claude Code takes the session's own id, so its memory is the same folder.
    // The other agent's record goes, so the session is listed once.
    if (from.rec) {
      delete S.config.agentSessions[from.rec.id];
      save();
    }
    const known = p.sessions.some((x) => x.id === from.id);
    createTab({ kind: known ? 'resume' : 'new', dir: p.dir, cwd: p.path, sessionId: from.id, name: from.name });
  } else {
    const a = agentInfo(to);
    const id = 'ag' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const rec = { id, agent: to, account: opts.account || (S.config.agentDefault || {})[to] || 'default', model: opts.model || '', memberId: from.id, dir: p.dir, cwd: p.path, name: from.name, created: Date.now(), started: 0, native: '' };
    S.config.agentSessions[id] = rec;
    if (from.rec) delete S.config.agentSessions[from.rec.id];
    save();
    openAgentSession(rec);
    toast(`${from.name} now runs on ${a.name}. Its memory came with it.`);
  }
  renderAll();
}

// ---------- the one-time move of the agents' own memories into Loop's ----------

async function memoryMoveOffer() {
  // Asked once: "Not now" is remembered, and Import stays in the memory panel.
  if (S.config.memoryMoved || S.config.memoryOfferSeen || S.child) return;
  const projects = (S.local || []).filter((p) => p.exists && !p.server);
  const found = [];
  const seen = new Set(); // a file every project lists (your CLAUDE.md, AGENTS.md) counts once
  for (const p of projects) {
    const items = await deck.memImportList({ dir: p.dir, path: p.path }).catch(() => []);
    for (const i of items) {
      if (i.imported) continue;
      found.push({ p, i });
      seen.add(i.scope === 'company' ? i.id : `${p.dir}|${i.id}`);
    }
  }
  const done = (how) => {
    S.config.memoryMoved = Date.now();
    save();
    if (how) toast(how);
  };
  if (!found.length) return done('');
  const agents = [...new Set(found.map((f) => f.i.agent))].map((a) => (PROVIDERS.find((x) => x.key === a) || { name: a }).name);
  const go = await confirmBox({
    title: 'Loop now keeps your memory',
    body: `Every agent in a session now shares that session's memory, kept by Loop. Your agents' own memories are turned off in Loop. Bring in what they already know first: ${seen.size} ${seen.size === 1 ? 'memory' : 'memories'} from ${agents.join(', ')}, across ${new Set(found.map((f) => f.p.dir)).size} projects. The originals stay where they are. Not now leaves everything as it is; you can import any time from the memory panel.`,
    confirm: 'Import all',
    cancel: 'Not now',
  });
  if (!go) {
    S.config.memoryOfferSeen = Date.now();
    save();
    return;
  }
  let n = 0;
  for (const p of projects) {
    const ids = found.filter((f) => f.p.dir === p.dir).map((f) => f.i.id);
    if (ids.length) n += await deck.memImport({ dir: p.dir, path: p.path, ids }).catch(() => 0);
  }
  done(`${n} ${n === 1 ? 'memory' : 'memories'} now in Loop.`);
}

// ---------- Loop Cloud: sign in, and back up or sync the memory ----------
// Lives in the memory panel, under Storage. The token stays in the main process;
// the window only sees who is signed in and how the copy is doing.

// Each project's memory, one of three ways.
const PROJECT_MODES = [
  ['local', 'This PC only', 'Stays on this PC. Nothing goes to the cloud.'],
  ['backup', 'Backed up', 'A copy goes to Loop Cloud a few seconds after every change. Nothing comes down by itself.'],
  ['linked', 'Linked', 'The same on every machine linked to it, within seconds.'],
];
const MODE_WORDS = Object.fromEntries(PROJECT_MODES.map(([m, label]) => [m, label]));
const cloudModeOf = (dir) => {
  const c = S.cloud || {};
  return (c.projects && c.projects[dir]) || c.defaultMode || 'backup';
};
// The project's memory folder name, which is the cloud project's name once linked.
const memFolderName = (folder) => {
  const parts = String(folder || '').split(/[\\/]+/);
  const i = parts.lastIndexOf('projects');
  return i >= 0 ? parts[i + 1] || '' : '';
};

function wireCloud() {
  const take = (s) => {
    S.cloud = s;
    if (S.drawer && S.drawer.open) renderDrawer();
    renderStatus(); // the status bar's Loop Cloud item
  };
  deck.onCloud(take);
  deck.cloudState().then(take);
}

const cloudBytes = (n) => (n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(1)} GB`);

async function cloudSignIn(email = '') {
  const v = await formDialog({
    title: 'Sign in to Loop Cloud',
    body: 'Loop emails you a 6-digit code; there is no password. Your memory is kept at loop.prismaple.com, 5 GB free, and only you can read it.',
    fields: [{ key: 'email', label: 'Email', value: email, placeholder: 'you@example.com' }],
    confirm: 'Email me a code',
  });
  const address = v && String(v.email || '').trim();
  if (!address) return;
  const sent = await deck.cloudCode(address);
  if (!sent.ok) {
    toast(sent.text, true);
    return cloudSignIn(address);
  }
  return cloudCodeStep(address);
}

async function cloudCodeStep(email) {
  const v = await formDialog({
    title: 'Check your email',
    body: `Enter the code sent to ${email}. It works once, for 10 minutes.`,
    fields: [{ key: 'code', label: 'Code', placeholder: '123456', mono: true }],
    confirm: 'Sign in',
  });
  if (!v) return;
  const r = await deck.cloudVerify(email, String(v.code || '').replace(/\D/g, ''));
  if (!r.ok) {
    toast(r.text, true);
    return cloudCodeStep(email);
  }
  toast(`Signed in as ${r.email}. Backing up your memory now.`);
  // A machine the cloud already knows more than: offer its memory right away.
  setTimeout(() => cloudBringOffer(true).catch(() => {}), 1500);
}

async function cloudNow() {
  const r = await deck.cloudBackup();
  if (!r.ok) return toast(r.text, true);
  toast(r.pulled || r.pushed ? `Up to date: ${r.pushed} sent, ${r.pulled} brought in. A restorable copy was saved too.` : 'Up to date. A restorable copy was saved too.');
}

async function cloudRestoreMenu(x, y) {
  const r = await deck.cloudBackups();
  if (!r.ok) return toast(r.text, true);
  if (!r.list.length) return toast('No backups yet. Press Back up now first.');
  menu(x, y, [
    { heading: 'Put a backup back' },
    ...r.list.slice(0, 15).map((b) => ({
      label: new Date(b.created).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }),
      hint: `${b.files} files${b.device ? ` · ${b.device}` : ''}`,
      icon: 'cloud',
      run: async () => {
        const ok = await confirmBox({
          title: 'Restore this backup?',
          body: 'Its notes are written back into your memory folder. Any note it changes is copied first to a .backup-before-restore folder inside the memory folder, and notes that are not in the backup stay as they are.',
          confirm: 'Restore',
        });
        if (!ok) return;
        const out = await deck.cloudRestore(b.id);
        if (!out.ok) return toast(out.text, true);
        toast(out.restored ? `Restored ${out.restored} files` : 'Nothing to restore: your memory already matches it');
        renderDrawer();
      },
    })),
  ]);
}


// ---------- bringing memory down from the cloud ----------
// A new machine signs in and the cloud already holds memory. Projects found on
// this machine are ticked (matched by git remote, folder key, or name); the
// rest stays in the cloud, or is linked to a local project by hand.

const HOW_WORDS = { linked: 'Linked before', remote: 'Same git repo', dir: 'Same folder key', name: 'Same name' };
const cloudTitle = (folder) => folder.replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase());

// Unasked (after signing in, at start, when a project appears), the window
// only opens for cloud memory not yet linked here and not yet turned down.
async function cloudBringOffer(auto, focusDir) {
  if (!S.cloud || !S.cloud.signedIn) return;
  const r = await deck.cloudProjects(true);
  if (!r.ok) {
    if (!auto) toast(r.text, true);
    return;
  }
  S.cloudProjects = r;
  S.cloudProjectsAt = Date.now();
  // This machine's own memory (its folder is here) is not news, linked or not.
  const own = (c) => c.linked || (c.match && c.match.how === 'linked');
  const open = r.projects.filter((c) => c.notes > 0 && !own(c));
  if (!open.length) {
    if (!auto) toast(r.projects.length ? 'Everything in Loop Cloud is already linked to a project here.' : 'Loop Cloud holds no memory yet.');
    return;
  }
  if (auto) {
    const asked = S.config.cloudAsked || {};
    const due = focusDir ? open.filter((c) => c.match && c.match.dir === focusDir && !asked[`${c.folder}|${focusDir}`]) : open.filter((c) => !asked[c.folder]);
    if (!due.length) return;
  }
  cloudBringDialog(r, focusDir);
}

const agoWords = (t) => (t ? (ago(t) === 'now' ? 'changed just now' : `changed ${ago(t)} ago`) : '');

// "You have memories in Loop Cloud": tick what this machine should have, and
// which project here each one is. Linked by default, so both machines stay the same.
function cloudBringDialog(r, focusDir) {
  closeOverlay();
  // Memory that is not on this machine yet: this machine's own folders are left out.
  const shown = r.projects.filter((c) => c.notes > 0 && !c.linked && !(c.match && c.match.how === 'linked'));
  const usedHere = new Set(r.locals.filter((l) => l.mode === 'linked').map((l) => l.dir));
  const picks = new Map(); // folder -> { on, dir }
  for (const c of shown) {
    const dir = c.match ? c.match.dir : '';
    picks.set(c.folder, { on: !c.linked && Boolean(dir) && (!focusDir || dir === focusDir), dir });
  }
  let keep = true;
  const btn = h('button.btn.primary', { type: 'submit' });
  const chosen = () => {
    const seen = new Set();
    return [...picks.entries()].filter(([, x]) => x.on && x.dir && !seen.has(x.dir) && seen.add(x.dir));
  };
  const word = () => {
    const n = chosen().length;
    btn.textContent = n ? `${keep ? 'Link' : 'Copy'} ${n === 1 ? '1 project' : `${n} projects`}` : keep ? 'Link' : 'Copy';
    btn.disabled = !n;
  };
  const ui = new Map(); // folder -> { box, sel }, so a project picked twice moves to the newer row
  const sorted = [...shown].sort((a, b) => Number(Boolean(b.match)) - Number(Boolean(a.match)) || (b.updated || 0) - (a.updated || 0));
  const rows = sorted.map((c) => {
    const p = picks.get(c.folder);
    const box = h('input', {
      type: 'checkbox',
      checked: p.on,
      disabled: c.linked || !p.dir,
      onchange: () => {
        p.on = box.checked;
        word();
      },
    });
    const right = c.linked
      ? h('span.pill', { title: `Already linked to ${c.match.name} on this machine` }, `Linked to ${c.match.name}`)
      : h(
          'select.bring-into',
          {
            title: 'Which project on this machine this memory belongs to',
            onchange: (e) => {
              p.dir = e.target.value;
              p.on = Boolean(p.dir);
              box.checked = p.on;
              box.disabled = !p.dir;
              // One project here takes one memory: another row that had it lets go.
              for (const [other, x] of picks) {
                if (other === c.folder || !p.dir || x.dir !== p.dir) continue;
                x.dir = '';
                x.on = false;
                const o = ui.get(other);
                if (o && o.sel) o.sel.value = '';
                if (o) (o.box.checked = false), (o.box.disabled = true);
              }
              word();
            },
          },
          h('option', { value: '' }, 'Not on this machine yet'),
          r.locals.map((l) =>
            h('option', { value: l.dir, selected: l.dir === p.dir, disabled: usedHere.has(l.dir) && l.dir !== p.dir }, `${l.dir === (c.match && c.match.dir) ? '★ ' : ''}${l.name}${usedHere.has(l.dir) ? ' (linked to other memory)' : ''}`),
          ),
        );
    ui.set(c.folder, { box, sel: c.linked ? null : right });
    return h(
      'label.bring-row',
      { class: c.linked ? 'muted' : '' },
      box,
      h(
        'span.ro-two',
        {},
        h('b', {}, cloudTitle(c.folder)),
        h('small', {}, [`${c.notes} note${c.notes === 1 ? '' : 's'}`, agoWords(c.updated), c.match && !c.linked ? `looks like ${c.match.name} (${(HOW_WORDS[c.match.how] || c.match.how).toLowerCase()})` : ''].filter(Boolean).join(' · ')),
      ),
      right,
    );
  });
  const keepBox = h('input', {
    type: 'checkbox',
    checked: keep,
    onchange: () => {
      keep = keepBox.checked;
      word();
    },
  });
  word();
  const form = h(
    'form.dialog.wide.bring',
    {
      onsubmit: async (e) => {
        e.preventDefault();
        const items = chosen().map(([folder, x]) => ({ folder, dir: x.dir }));
        btn.disabled = true;
        btn.textContent = keep ? 'Linking…' : 'Copying…';
        let added = 0;
        let besides = 0;
        let failed = '';
        if (keep) {
          for (const it of items) {
            const out = await deck.cloudLink(it.dir, it.folder);
            if (!out.ok) failed = out.text;
            else {
              added += out.added || 0;
              besides += out.besides || 0;
            }
          }
        } else {
          const out = await deck.cloudBring({ items, company: r.companyNotes > 0 });
          if (!out.ok) failed = out.text;
          else ({ added, besides } = out);
        }
        closeOverlay();
        if (failed) return toast(failed, true);
        const what = keep ? `Linked ${items.length === 1 ? '1 project' : `${items.length} projects`}` : 'Copied';
        toast(`${what}: ${added} note${added === 1 ? '' : 's'} came down${besides ? `, ${besides} kept beside yours` : ''}.`);
        S.cloudProjectsAt = 0;
        renderAll();
      },
    },
    h('h3', {}, 'You have memories in Loop Cloud'),
    h('p', {}, 'Tick what this machine should have, and which project here each one is. The names do not have to match. Nothing here is replaced: a note that differs keeps both copies.'),
    h('div.bring-list', {}, rows),
    h(
      'label.bring-keep',
      {},
      keepBox,
      h('span.ro-two', {}, h('b', {}, 'Keep them in step on every machine'), h('small', {}, 'Linked: a change on any machine reaches the others within seconds. Untick to copy them once.')),
    ),
    shown.some((c) => !c.match && !c.linked) ? h('p.bring-hint', {}, 'Not on this machine yet? Add the project in Loop first (an empty folder is fine, before you clone), then link it here or from its memory panel.') : null,
    h(
      'div.dialog-actions',
      {},
      h(
        'button.btn',
        {
          type: 'button',
          onclick: () => {
            // Not asked again about these, unless asked for.
            S.config.cloudAsked = S.config.cloudAsked || {};
            for (const c of shown) S.config.cloudAsked[focusDir ? `${c.folder}|${focusDir}` : c.folder] = true;
            save();
            closeOverlay();
          },
        },
        'Not now',
      ),
      btn,
    ),
  );
  const scrim = h('div.scrim.dim', { onmousedown: (e) => e.target === scrim && closeOverlay() }, form);
  $('#overlay').append(scrim);
}

// Which cloud memory this project uses from now on: one of the cloud's, or its
// own put in the cloud. Names may differ between machines.
async function cloudLinkDialog(p) {
  if (!p || p.server) return;
  if (!S.cloud || !S.cloud.signedIn) return cloudSignIn();
  const r = await deck.cloudProjects(false); // the list from the last two minutes is fine here
  if (!r.ok) return toast(r.text, true);
  S.cloudProjects = r;
  S.cloudProjectsAt = Date.now();
  const mine = r.locals.find((l) => l.dir === p.dir) || {};
  // A project with no memory yet starts in the cloud under its own name.
  const taken = new Set(r.projects.map((c) => c.folder));
  let fresh = projectTitle(p).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project';
  for (let n = 2; taken.has(fresh); n++) fresh = fresh.replace(/-\d+$/, '') + '-' + n;
  const own = mine.folder || '';
  // Not the memory of another project on this machine.
  const usable = r.projects.filter((c) => !(c.match && c.match.dir !== p.dir && (c.linked || c.match.how === 'linked')));
  const options = [];
  if (!usable.some((c) => c.folder === own)) options.push({ value: own ? '' : fresh, title: `Keep this project's own memory`, sub: own ? `It goes up as “${cloudTitle(own)}”, and other machines can link to it` : `It starts in the cloud as “${cloudTitle(fresh)}”, and other machines can link to it`, own: true });
  for (const c of usable.sort((a, b) => Number(Boolean(b.match && b.match.dir === p.dir)) - Number(Boolean(a.match && a.match.dir === p.dir)) || (b.updated || 0) - (a.updated || 0))) {
    options.push({
      value: c.folder,
      title: cloudTitle(c.folder),
      sub: [`${c.notes} note${c.notes === 1 ? '' : 's'}`, agoWords(c.updated), c.remote].filter(Boolean).join(' · '),
      tag: c.linked ? 'Linked now' : c.match && c.match.dir === p.dir ? (c.match.how === 'linked' ? 'This project' : 'Suggested') : '',
    });
  }
  if (!own && !r.projects.length) return toast('Loop Cloud has no memory yet, and this project has none to send. Write a note first.');
  let pick = (options.find((o) => o.tag === 'Linked now' || o.tag === 'Suggested' || o.tag === 'This project') || options[0]).value;
  const btn = h('button.btn.primary', { type: 'submit' }, 'Link');
  const rows = options.map((o) =>
    h(
      'label.bring-row',
      {},
      h('input', { type: 'radio', name: 'cloud-link', checked: o.value === pick, onchange: () => (pick = o.value) }),
      h('span.ro-two', {}, h('b', {}, o.title), h('small', {}, o.sub)),
      o.tag ? h('span.pill', {}, o.tag) : null,
    ),
  );
  closeOverlay();
  const form = h(
    'form.dialog.wide.bring',
    {
      onsubmit: async (e) => {
        e.preventDefault();
        btn.disabled = true;
        btn.textContent = 'Linking…';
        const out = await deck.cloudLink(p.dir, pick);
        closeOverlay();
        if (!out.ok) return toast(out.text, true);
        toast(`${projectTitle(p)} is linked to “${cloudTitle(out.folder)}”${out.added ? `: ${out.added} note${out.added === 1 ? '' : 's'} came down` : ''}${out.besides ? `, ${out.besides} kept beside yours` : ''}.`);
        S.cloudProjectsAt = 0;
        renderAll();
      },
    },
    h('h3', {}, `Use memory from Loop Cloud for ${projectTitle(p)}`),
    h('p', {}, 'Pick the memory this project should use. From now on it stays the same on every machine linked to it, within seconds, even if the project is called something else there. What is here already is kept: a note that differs keeps both copies.'),
    h('div.bring-list', {}, rows),
    h('div.dialog-actions', {}, h('button.btn', { type: 'button', onclick: () => closeOverlay() }, 'Cancel'), btn),
  );
  const scrim = h('div.scrim.dim', { onmousedown: (e) => e.target === scrim && closeOverlay() }, form);
  $('#overlay').append(scrim);
}

// In a project's memory panel: the cloud has memory that looks like this
// project's, and this project is not linked yet.
function cloudBringBanner(d, p) {
  const c = S.cloud;
  if (!c || !c.signedIn || !p || p.server || !d || cloudModeOf(p.dir) === 'linked') return null;
  if (!S.cloudProjectsAt || Date.now() - S.cloudProjectsAt > 300e3) {
    if (!S.cloudProjectsBusy) {
      S.cloudProjectsBusy = true;
      deck
        .cloudProjects(false)
        .then((r) => {
          S.cloudProjectsBusy = false;
          if (r && r.ok) {
            S.cloudProjects = r;
            S.cloudProjectsAt = Date.now();
            if (S.drawer && S.drawer.open) renderDrawer();
          }
        })
        .catch(() => (S.cloudProjectsBusy = false));
    }
    return null;
  }
  const hit = ((S.cloudProjects || {}).projects || []).find((x) => x.match && x.match.dir === p.dir && x.match.how !== 'linked' && x.notes > 0 && !x.linked);
  if (!hit) return null;
  return h(
    'div.mem-store-row.cloud-bring',
    {},
    h('span.mem-store-ic', {}, icon('cloud')),
    h('div.grow', {}, h('b', {}, `Loop Cloud has memory that looks like this project`), h('small', {}, `“${cloudTitle(hit.folder)}” · ${hit.notes} note${hit.notes === 1 ? '' : 's'} · ${(HOW_WORDS[hit.match.how] || '').toLowerCase()}`)),
    h('button.btn.small.primary', { onclick: () => cloudLinkDialog(p) }, 'Link'),
  );
}


// ---------- choosing which cloud notes to import, project by project ----------
// For a project already in Loop here, whatever it is named locally: its cloud
// notes are listed to pick from, or imported in one go. A project the matching
// cannot place is linked by hand first.

const sessionWords = (folder) => cloudTitle(folder.replace(/--[0-9a-f]{6}$/i, ''));

async function cloudFreshen() {
  const r = await deck.cloudProjects(false);
  if (r && r.ok) {
    S.cloudProjects = r;
    S.cloudProjectsAt = Date.now();
  }
  return r;
}

// The cloud project a local project is: matched, or chosen by hand.
async function cloudNotesPicker(p, folderOverride) {
  if (!p) return;
  if (!S.cloud || !S.cloud.signedIn) return toast('Sign in to Loop Cloud first.', true);
  const r = S.cloudProjectsAt && Date.now() - S.cloudProjectsAt < 120e3 ? S.cloudProjects : await cloudFreshen();
  if (!r || !r.ok) return toast((r && r.text) || 'Could not reach Loop Cloud.', true);
  const withNotes = r.projects.filter((c) => c.notes > 0);
  if (!withNotes.length) return toast('Loop Cloud holds no project notes yet. Back up first.');
  const hit = folderOverride ? withNotes.find((c) => c.folder === folderOverride) : withNotes.find((c) => c.match && c.match.dir === p.dir);
  if (!hit) {
    // Nothing points at this project: the user says which cloud project it is.
    return menu(innerWidth / 2 - 130, 120, [
      { heading: `Which cloud project is ${projectTitle(p)}?` },
      ...withNotes.map((c) => ({
        label: cloudTitle(c.folder),
        hint: `${c.notes} note${c.notes === 1 ? '' : 's'}${c.remote ? ` · ${c.remote}` : ''}${c.match ? ` · matched to ${c.match.name}` : ''}`,
        icon: 'cloud',
        run: () => cloudNotesPicker(p, c.folder),
      })),
    ]);
  }
  const got = await deck.cloudNotes({ folder: hit.folder, dir: p.dir });
  if (!got.ok) return toast(got.text, true);
  if (!got.rows.length) return toast('That cloud project has no notes.');
  cloudNotesDialog(p, hit.folder, got.rows);
}

function cloudNotesDialog(p, folder, rows) {
  closeOverlay();
  const picks = new Map(rows.map((n) => [n.rel, n.state === 'new']));
  const boxes = new Map();
  const btn = h('button.btn.primary', { type: 'submit' });
  const word = () => {
    const n = [...picks.values()].filter(Boolean).length;
    btn.textContent = n ? `Import ${n} note${n === 1 ? '' : 's'}` : 'Import';
    btn.disabled = !n;
  };
  const all = h('input', {
    type: 'checkbox',
    checked: rows.some((n) => n.state !== 'same'),
    onchange: () => {
      for (const n of rows) {
        if (n.state === 'same') continue;
        picks.set(n.rel, all.checked);
        const b = boxes.get(n.rel);
        if (b) b.checked = all.checked;
      }
      word();
    },
  });
  const groups = [...new Set(rows.map((n) => n.group))];
  const body = groups.map((g) =>
    h(
      'div.bring-group',
      {},
      h('div.bring-group-title', {}, g === 'shared' ? 'Shared by every session' : sessionWords(g)),
      rows
        .filter((n) => n.group === g)
        .map((n) => {
          const box = h('input', {
            type: 'checkbox',
            checked: picks.get(n.rel),
            disabled: n.state === 'same',
            onchange: () => {
              picks.set(n.rel, box.checked);
              word();
            },
          });
          boxes.set(n.rel, box);
          return h(
            'label.bring-row',
            { class: n.state === 'same' ? 'muted' : '' },
            box,
            h('span.ro-two', {}, h('b', {}, n.title), n.sub ? h('small', {}, n.sub) : null),
            n.state === 'same' ? h('span.pill.grey', {}, 'Here already') : n.state === 'differs' ? h('span.pill.warm', { title: "This note exists here and says something else. The cloud's copy is kept beside yours." }, 'Differs') : null,
          );
        }),
    ),
  );
  word();
  const form = h(
    'form.dialog.wide.bring',
    {
      onsubmit: async (e) => {
        e.preventDefault();
        const rels = [...picks.entries()].filter(([, on]) => on).map(([rel]) => rel);
        btn.disabled = true;
        const out = await deck.cloudBringNotes({ folder, dir: p.dir, rels });
        closeOverlay();
        if (!out.ok) return toast(out.text, true);
        toast(out.added || out.besides ? `${out.added} note${out.added === 1 ? '' : 's'} imported${out.besides ? `, ${out.besides} kept beside yours` : ''}.` : 'Those notes were here already.');
        S.cloudProjectsAt = 0;
        renderAll();
      },
    },
    h('h3', {}, `Cloud notes for ${projectTitle(p)}`),
    h('p', {}, 'Tick the memories this machine should have. Nothing here is replaced.'),
    h('label.bring-row.bring-all', {}, all, h('span.ro-two', {}, h('b', {}, 'All of them'), h('small', {}, `${rows.length} note${rows.length === 1 ? '' : 's'} in the cloud`))),
    h('div.bring-list', {}, body),
    h('div.dialog-actions', {}, h('button.btn', { type: 'button', onclick: () => closeOverlay() }, 'Cancel'), btn),
  );
  const scrim = h('div.scrim.dim', { onmousedown: (e) => e.target === scrim && closeOverlay() }, form);
  $('#overlay').append(scrim);
}

function cloudRow(d, p) {
  const c = S.cloud;
  const ic = h('span.mem-store-ic', {}, icon('cloud'));
  if (!c || !c.signedIn) {
    return h(
      'div.mem-store-row.cloud',
      {},
      ic,
      h('div.grow', {}, h('b', {}, 'Loop Cloud'), h('small', { class: c && c.error ? 'err' : '', title: (c && c.error) || '' }, (c && c.error) || 'Keep this memory safe, or the same on every machine. 5 GB free.')),
      h('button.btn.small.primary', { onclick: () => cloudSignIn((c && c.email) || '') }, 'Sign in'),
    );
  }
  const working = { sync: '', backup: 'Saving a copy…', restore: 'Restoring…', bring: 'Bringing memory in…', link: 'Linking…' }[c.busy];
  const since = (t) => (!t ? '' : ago(t) === 'now' ? 'just now' : `${ago(t)} ago`);
  const space = c.quota ? `${cloudBytes(c.used)} of ${cloudBytes(c.quota)}` : '';
  const dir = p && !p.server ? p.dir : '';
  const mode = dir ? cloudModeOf(dir) : '';
  const known = ((S.cloudProjects || {}).locals || []).find((l) => l.dir === dir);
  const name = (d && d.folder && memFolderName(d.folder)) || (known && known.folder) || '';
  const say = {
    local: 'Stays on this PC. Nothing goes to the cloud.',
    backup: [c.lastSync ? `Copied ${since(c.lastSync)}` : 'A copy goes up after every change', space].filter(Boolean).join(' · '),
    linked: [name ? `Linked to “${cloudTitle(name)}”` : 'Linked', c.lastSync ? `in step ${since(c.lastSync)}` : 'in step', space].filter(Boolean).join(' · '),
  };
  const line = working || c.error || (dir ? say[mode] : [`New projects: ${MODE_WORDS[c.defaultMode] || 'Backed up'}`, space].filter(Boolean).join(' · '));
  const setMode = async (m) => {
    if (m === mode && m !== 'linked') return;
    if (m === 'linked') return cloudLinkDialog(p);
    const r = await deck.cloudProjectMode(dir, m);
    if (!r.ok) return toast(r.text, true);
    toast(m === 'local' ? `${projectTitle(p)}: memory stays on this PC.` : `${projectTitle(p)}: backed up after every change.`);
  };
  return h(
    'div.mem-store-row.cloud.signed',
    {},
    ic,
    h(
      'div.grow',
      {},
      h('b', {}, 'Loop Cloud ', h('span.cloud-email', { title: c.email }, c.email)),
      h('small', { class: c.error && !working ? 'err' : '', title: line }, line),
      dir
        ? h(
            'div.cloud-modes',
            { role: 'radiogroup', 'aria-label': `Where ${projectTitle(p)}'s memory is kept` },
            PROJECT_MODES.map(([m, label, hint]) =>
              h('button', { type: 'button', role: 'radio', 'aria-checked': String(mode === m), class: mode === m ? 'on' : '', title: m === 'linked' && mode === 'linked' ? 'Linked. Click to link it to other cloud memory.' : hint, onclick: () => setMode(m) }, label),
            ),
          )
        : null,
    ),
    h(
      'div.cloud-acts',
      {},
      h(
        'button.mini',
        {
          title: 'More',
          onclick: (e) => {
            const at = e.currentTarget.getBoundingClientRect();
            menu(at.left, at.bottom + 4, [
              { heading: c.email },
              dir ? { label: 'Use memory from cloud…', hint: 'Link this project', icon: 'cloud', run: () => cloudLinkDialog(p) } : null,
              dir ? { label: 'Copy notes from cloud once…', hint: 'Pick which', icon: 'import', run: () => cloudNotesPicker(p) } : null,
              { label: 'Memories for other projects…', icon: 'import', run: () => cloudBringOffer(false) },
              '-',
              { heading: 'New projects start as' },
              ...PROJECT_MODES.map(([m, label, hint]) => ({
                label: (c.defaultMode === m ? '✓  ' : '    ') + label,
                hint,
                run: async () => {
                  const r = await deck.cloudDefaultMode(m);
                  if (!r.ok) toast(r.text, true);
                },
              })),
              '-',
              { label: 'Save a restorable copy now', icon: 'cloud', run: () => cloudNow() },
              { label: 'Restore a copy…', icon: 'import', run: () => cloudRestoreMenu(at.left, at.bottom + 4) },
              { label: 'Read it at loop.prismaple.com', icon: 'book', run: () => deck.cloudSite() },
              { label: 'How memory and Loop Cloud work', icon: 'book', run: () => deck.openExternal('https://loop.prismaple.com/docs/#memory') },
              '-',
              {
                label: 'Sign out of Loop Cloud',
                icon: 'person',
                run: async () => {
                  const ok = await confirmBox({ title: 'Sign out of Loop Cloud?', body: 'Nothing goes up or comes down on this machine any more. What is in the cloud stays there, and your memory here stays as it is.', confirm: 'Sign out' });
                  if (!ok) return;
                  const out = await deck.cloudSignOut();
                  if (!out.ok) toast(out.text, true);
                },
              },
            ]);
          },
        },
        icon('dots'),
      ),
    ),
  );
}

// ---------- Runs on: agent, then account, then model ----------
// One place to choose what runs a session. Three columns: the agent (Claude
// Code, Codex, Kimi …), the account it runs as (a plan login, or for Claude
// Code an API key), and the model. Choosing a model applies all three; a
// session that is open restarts with the conversation kept.

const CLAUDE_MODELS = [
  ['', 'Account default'],
  ['claude-opus-5-5', 'Opus 5.5'],
  ['claude-sonnet-5-5', 'Sonnet 5.5'],
  ['claude-haiku-5-5', 'Haiku 5.5'],
  ['claude-fable-5-2', 'Fable 5.2'],
];
const AGENT_MODELS = {
  codex: [
    ['', 'Codex default'],
    ['gpt-5.6-terra', 'gpt-5.6-terra'],
    ['gpt-5.6-luna', 'gpt-5.6-luna'],
  ],
};

const modelLabel = (agent, account, model) => {
  if (agent === 'claude' && String(account).startsWith('llm:')) {
    const m = (S.llms || []).find((x) => `llm:${x.id}` === account);
    return m ? m.model : '';
  }
  const list = agent === 'claude' ? CLAUDE_MODELS : AGENT_MODELS[agent] || [];
  const hit = list.find(([id]) => id === (model || ''));
  return model && hit ? hit[1] : '';
};

const runsOnAgents = () => [{ id: 'claude', name: 'Claude', tool: 'Claude Code', installed: true }, ...(S.agents || [])];

// The accounts one agent can run as: { key, name, sub, apiKey }.
function runsOnAccounts(agent) {
  if (agent === 'claude') {
    return [
      ...accountList().map((a) => ({ key: a.id, name: a.name, sub: accountLine(a.id) })),
      ...(S.llms || []).map((m) => ({ key: `llm:${m.id}`, name: m.name, sub: `API key · ${m.model}`, apiKey: true })),
    ];
  }
  const info = agentInfo(agent);
  const ids = ['default', ...(S.config.agentAccounts || []).filter((x) => x.agent === agent).map((x) => x.id)];
  return ids.map((id) => {
    const st = (info.accounts || []).find((x) => x.id === id) || {};
    return { key: id, name: agentAccountMeta(agent, id).name, sub: st.signedIn ? st.email || st.how || 'Signed in' : 'Not signed in' };
  });
}

function runsOnModels(agent, account) {
  if (agent === 'claude' && String(account).startsWith('llm:')) {
    const m = (S.llms || []).find((x) => `llm:${x.id}` === account);
    return [['', m ? m.model : 'Its model']];
  }
  return agent === 'claude' ? CLAUDE_MODELS : AGENT_MODELS[agent] || [['', `${agentInfo(agent).tool} default`]];
}

// What a session runs on now. `from` is { id, name, agent, rec? }.
function runsOnNow(p, from) {
  if (from.agent !== 'claude') return { agent: from.agent, account: (from.rec && from.rec.account) || 'default', model: (from.rec && from.rec.model) || '' };
  const llm = llmFor(p.dir, from.id);
  const tab = tabFor(from.id);
  return { agent: 'claude', account: llm ? `llm:${llm}` : tab ? tab.account : accountFor(p.dir, from.id), model: (S.config.sessionModel || {})[from.id] || '' };
}

function runsOnLine(p, from) {
  const now = runsOnNow(p, from);
  const agent = runsOnAgents().find((a) => a.id === now.agent) || { name: now.agent };
  const acct = runsOnAccounts(now.agent).find((a) => a.key === now.account);
  return [agent.name, acct ? acct.name : '', modelLabel(now.agent, now.account, now.model)].filter(Boolean).join(' · ');
}

// Runs on, as menus that open to the right like stairs: agents beside the
// menu row, an agent's accounts beside the agent, an account's models beside
// the account. The path in use is open from the start. Choosing a model applies
// all three and closes everything.
function runsOnPicker(anchor, p, from) {
  document.querySelectorAll('#overlay > .ro-panel').forEach((el) => el.remove());
  const now = runsOnNow(p, from);
  const sel = { ...now };
  const limitsOf = new Map(); // 'agent|account' -> text, filled in as it is read
  const opened = performance.now();
  let hoverTimer = 0;

  // A panel beside a row: to its right, or to its left when there is no room.
  const panel = (level, rows, rowEl) => {
    document.querySelectorAll('#overlay > .ro-panel').forEach((el) => Number(el.dataset.level) >= level && el.remove());
    const box = h('div.menu.ro-panel', { role: 'menu', 'data-level': String(level) }, ...rows);
    // The click that opened a panel can land on whatever row now sits under the pointer.
    box.addEventListener(
      'click',
      (e) => {
        if (performance.now() - opened < 300) {
          e.stopPropagation();
          e.preventDefault();
        }
      },
      true,
    );
    $('#overlay').append(box);
    const a = rowEl.getBoundingClientRect();
    const r = box.getBoundingClientRect();
    const left = a.right + r.width + 4 <= innerWidth ? a.right + 2 : Math.max(6, a.left - r.width - 2);
    box.style.left = `${left}px`;
    box.style.top = `${Math.max(6, Math.min(a.top - 6, innerHeight - r.height - 6))}px`;
    return box;
  };
  const mark = (rowEl) => {
    rowEl.parentNode.querySelectorAll('.ro-row').forEach((x) => x.classList.toggle('on', x === rowEl));
  };
  // Open the next level on hover after a moment, so a pointer passing over rows
  // on its way across does not open each one; a click opens it at once.
  const onHover = (rowEl, open) => ({
    onmouseenter: () => {
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => open(rowEl), 140);
    },
    onclick: () => {
      clearTimeout(hoverTimer);
      open(rowEl);
    },
  });

  const showModels = (rowEl) => {
    const models = runsOnModels(sel.agent, sel.account);
    const current = (id) => sel.agent === now.agent && sel.account === now.account && id === (now.model || '');
    panel(
      3,
      [
        h('div.menu-label', {}, 'Model'),
        ...models.map(([id, label]) =>
          h(
            'button.ro-row',
            {
              class: current(id) ? 'on' : '',
              onclick: () => {
                closeMenu();
                applyRunsOn(p, from, now, { agent: sel.agent, account: sel.account, model: id });
              },
            },
            h('span.ro-two', {}, h('b', {}, label)),
            current(id) ? icon('check') : null,
          ),
        ),
      ],
      rowEl,
    );
  };

  const showAccounts = (rowEl) => {
    const accounts = runsOnAccounts(sel.agent);
    const rows = accounts.map((c) => {
      const lk = `${sel.agent}|${c.key}`;
      const row = h(
        'button.ro-row',
        {
          class: c.key === sel.account ? 'on' : '',
          ...onHover(null, () => {
            sel.account = c.key;
            mark(row);
            showModels(row);
          }),
        },
        icon(c.apiKey ? 'key' : 'person'),
        h('span.ro-two', {}, h('b', {}, c.name), h('small', { 'data-limits': lk }, limitsOf.get(lk) || c.sub)),
        icon('chevron'),
      );
      return row;
    });
    const box = panel(
      2,
      [
        h('div.menu-label', {}, 'Account'),
        ...rows,
        h('hr'),
        h('button.ro-row.add', { onclick: () => (closeMenu(), openAccountsWindow(sel.agent)) }, icon('plus'), h('span', {}, sel.agent === 'claude' ? 'Add an account or API key' : 'Add an account')),
      ],
      rowEl,
    );
    const at = accounts.findIndex((c) => c.key === sel.account);
    if (at >= 0) showModels(rows[at]);
    // Plan limits beside each plan account, as they come in.
    for (const c of accounts) {
      const lk = `${sel.agent}|${c.key}`;
      if (c.apiKey || limitsOf.has(lk) || !['claude', 'codex'].includes(sel.agent)) continue;
      limitsOf.set(lk, c.sub);
      deck
        .limits({ agent: sel.agent, account: c.key })
        .then((d) => {
          if (!d || !d.windows || !d.windows.length) return;
          const text = d.windows
            .filter((w) => !/ week$/.test(w.label) || w.label === 'week')
            .slice(0, 2)
            .map((w) => `${w.label} ${w.used}%`)
            .join(' · ');
          limitsOf.set(lk, `${d.plan ? d.plan[0].toUpperCase() + d.plan.slice(1) + ' · ' : ''}${text}`);
          const el = box.querySelector(`[data-limits="${CSS.escape(lk)}"]`);
          if (el) el.textContent = limitsOf.get(lk);
        })
        .catch(() => {});
    }
  };

  const agentRows = runsOnAgents().map((a) => {
    const row = h(
      'button.ro-row',
      {
        class: [a.id === sel.agent ? 'on' : '', a.installed ? '' : 'off'].join(' '),
        ...(a.installed
          ? onHover(null, () => {
              if (a.id !== sel.agent) {
                sel.agent = a.id;
                sel.account = a.id === now.agent ? now.account : (runsOnAccounts(a.id)[0] || {}).key || 'default';
              }
              mark(row);
              showAccounts(row);
            })
          : {
              onmouseenter: () => {
                clearTimeout(hoverTimer);
                document.querySelectorAll('#overlay > .ro-panel').forEach((el) => Number(el.dataset.level) >= 2 && el.remove());
              },
              onclick: () => (closeMenu(), openAccountsWindow(a.id)),
            }),
      },
      brandIcon(a.id),
      h('span.ro-two', {}, h('b', {}, a.name), h('small', {}, a.installed ? a.tool : 'Set up')),
      a.installed ? icon('chevron') : null,
    );
    return row;
  });
  panel(1, [h('div.menu-label', {}, 'Agent'), ...agentRows], anchor);
  const at = runsOnAgents().findIndex((a) => a.id === sel.agent);
  if (at >= 0) showAccounts(agentRows[at]);
}

// The Accounts window, by the name it has outside the picker (the picker has its own openAccounts).
const openAccountsWindow = (id) => openAccounts(id);

// Puts a choice into effect: another agent hands over as Switch agent does;
// the same agent with another account or model restarts once.
async function applyRunsOn(p, from, now, to) {
  if (to.agent === now.agent && to.account === now.account && (to.model || '') === (now.model || '')) return;
  if (!S.config.sessionModel) S.config.sessionModel = {};
  const setClaude = () => {
    const id = from.id;
    if (String(to.account).startsWith('llm:')) S.config.sessionLlm[id] = to.account.slice(4);
    else {
      if (llmFor(p.dir, null)) S.config.sessionLlm[id] = 'claude';
      else delete S.config.sessionLlm[id];
      S.config.sessionAccount[id] = to.account;
    }
    if (to.model && !String(to.account).startsWith('llm:')) S.config.sessionModel[id] = to.model;
    else delete S.config.sessionModel[id];
  };
  if (to.agent !== now.agent) {
    if (to.agent === 'claude') setClaude();
    return switchAgent(p, from, to.agent, { account: to.account, model: to.model });
  }
  if (to.agent === 'claude') {
    const tab = tabFor(from.id);
    if (tab && !(await okToRestart(tab))) return;
    setClaude();
    save();
    if (tab) await restartTab(tab, String(to.account).startsWith('llm:') ? tab.account : to.account);
    else if (S.live.has(from.id)) await deck.directStop(from.id).catch(() => {});
    renderAll();
    return toast(`${from.name} now runs on ${runsOnLine(p, from)}.`);
  }
  const rec = from.rec;
  if (!rec) return;
  const tab = agentTabFor(rec.id);
  if (tab && !(await okToRestart(tab))) return;
  rec.account = to.account;
  rec.model = to.model || '';
  save();
  if (tab) {
    await closeTab(tab.id, { stop: true });
    openAgentSession(rec);
  }
  renderAll();
  toast(`${from.name} now runs on ${runsOnLine(p, from)}.`);
}

async function okToRestart(tab) {
  const lamp = lampFor(tab.sessionId, tab);
  if (lamp !== 'busy' && lamp !== 'shell') return true;
  return confirmBox({
    title: `"${tabTitle(tab)}" is still working`,
    body: 'Changing what it runs on restarts the session. The conversation is kept, but the step in progress is lost.',
    confirm: 'Restart it',
    danger: true,
  });
}

// ---------- Accessible on the internet ----------
// One switch. Turning it on walks through what this machine needs: Loop Cloud
// sign-in, Tailscale installed and signed in, Funnel pointed at Loop, the PC
// kept awake, and the machine listed on the account. Each step is checked
// first; a step that needs you has its own button.

function wireInternet() {
  const take = (s) => {
    S.internet = s;
    if (document.querySelector('.dialog.internet')) paintInternet();
    renderStatus();
  };
  deck.onInternet(take);
  deck.internetState().then(take);
}

async function openInternet() {
  closeOverlay();
  const box = h('form.dialog.wide.internet', { onsubmit: (e) => e.preventDefault() });
  const scrim = h('div.scrim.dim', { onmousedown: (e) => e.target === scrim && closeOverlay() }, box);
  $('#overlay').append(scrim);
  box.addEventListener('keydown', (e) => e.key === 'Escape' && closeOverlay());
  paintInternet();
  S.internet = await deck.internetState();
  paintInternet();
}

function paintInternet() {
  const box = document.querySelector('.dialog.internet');
  if (!box) return;
  const s = S.internet || { on: false, steps: [] };
  const sw = h('input', {
    type: 'checkbox',
    role: 'switch',
    checked: s.on,
    onchange: async () => {
      sw.disabled = true;
      const r = await deck.internetSet(sw.checked);
      if (!r.ok) toast(r.text, true);
    },
  });
  const step = (st, i) =>
    h(
      'div.net-step',
      { class: st.ok ? 'ok' : '' },
      h('span.net-n', {}, st.ok ? icon('check') : String(i + 1)),
      h('div.grow', {}, h('b', {}, st.label), h('small', {}, st.detail || '')),
      st.action && s.on
        ? h(
            'button.btn.small',
            {
              type: 'button',
              class: st.key === firstTodo(s) ? 'primary' : '',
              disabled: Boolean(s.busy),
              onclick: () => (st.key === 'cloud' ? (closeOverlay(), cloudSignIn('')) : deck.internetAct(st.key)),
            },
            s.busy === st.key ? 'Working…' : st.action,
          )
        : null,
    );
  put(
    box,
    h('h3', {}, 'Accessible on the internet'),
    h(
      'label.net-switch',
      {},
      h('span.grow', {}, h('b', {}, s.on ? 'On' : 'Off'), h('small', {}, "Use this PC's Loop from loop.prismaple.com and the phone app, signed in with your email. Nobody gets in by knowing the address.")),
      sw,
    ),
    s.on
      ? h(
          'div.net-steps',
          {},
          s.steps.map(step),
          s.note ? h('p.net-note', {}, s.note) : null,
          h(
            'div.net-test',
            {},
            h(
              'button.btn.small',
              { type: 'button', disabled: !s.ready || Boolean(s.busy), onclick: () => deck.internetTest() },
              s.busy === 'test' ? 'Testing…' : 'Test from outside',
            ),
            s.test ? h('small', { class: s.test.ok ? 'good' : 'bad' }, s.test.ok ? `Loop Cloud reached this PC at ${s.url}` : s.test.why || `It did not answer (${s.test.status || 'no reply'})`) : h('small', {}, s.ready ? 'Loop Cloud opens this PC the way your phone will' : 'Available once the steps above are done'),
            h('span.grow'),
            h('button.btn.small', { type: 'button', disabled: Boolean(s.busy), onclick: async () => (S.internet = await deck.internetState(), paintInternet()) }, 'Check again'),
          ),
        )
      : null,
    h('div.dialog-actions', {}, h('button.btn', { type: 'button', onclick: () => closeOverlay() }, 'Close')),
  );
}

const firstTodo = (s) => ((s.steps || []).find((x) => !x.ok && x.action) || {}).key;
