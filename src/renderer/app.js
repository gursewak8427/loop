/* global deck, voiceField, hearVoice, voiceOn, toggleVoice, openVoice, Terminal, FitAddon, WebLinksAddon, Unicode11Addon, WebglAddon, SerializeAddon */
/* global claudeMissing */
/* global serverById, serverChip, mergeProjects, wireServers, openServers, railServers, startSession, serverShell, farTabClosed, claudeMissing */
/* global PH, wirePhone, openPhone, phoneEcho, phoneSync */
/* global openBoard, openTeamSetup, teamOf, roleOf, roleMenu, roleGroups, wireBoard, syncTeamNames */
/* global layoutPanes, renderTabs, setLayout, slotOf, moveToSlot, adoptTab, wireWindows */
/* global setupChat, touchScroll, openInternet, wireInternet, cloudRow, cloudBringBanner, wireCloud, wireLimits, wireUpdates, wireTools, toolsLabel, projectToolsMenu, renderStatus, renderUsage, runsOnPicker, runsOnLine */
'use strict';

// On a Mac the app's own shortcuts use Cmd, as Mac apps do, and Ctrl is left to
// the terminal (Ctrl+C interrupts, as in Terminal). Ctrl+Tab still moves between
// terminals there, since Cmd+Tab belongs to the system.
const MAC = deck.platform === 'darwin';
const MOD = MAC ? 'Cmd' : 'Ctrl';
const modKey = (e) => (MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey);

const S = {
  config: null,
  projects: [],
  live: new Map(), // sessionId -> live registry entry
  colors: [],
  winBuild: 19045,
  tabs: new Map(),
  order: [],
  active: null,
  query: '',
  showHidden: false,
  trash: [],
  expanded: {},
  composerOpen: false,
  muted: new Set(), // tab ids left out of a broadcast
  held: new Map(), // sessions still running with their terminal closed: session id -> how to put it back
  drawer: { open: false, dir: null, member: null, scope: 'project', query: '', notes: [], stats: null },
  acct: new Map(), // account id -> who is signed in
  local: [], // projects on this PC
  srv: new Map(), // server id -> what it last reported
  winId: 0, // this window, so tab ids stay unique across windows
  child: false, // an extra window: terminals only, no project list
  stats: null,
};
let tabSeq = 0;

// ---------- tiny DOM helpers ----------

const $ = (sel) => document.querySelector(sel);

// replaceChildren that skips empty slots (a bare null would print as text).
const put = (el, ...kids) => el.replaceChildren(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false));

function h(spec, attrs, ...kids) {
  const [tag, ...classes] = spec.split('.');
  const el = document.createElement(tag || 'div');
  if (classes.length) el.className = classes.join(' ');
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style') el.style.cssText = v;
    else if (k === 'class') el.className += ' ' + v;
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const ICONS = {
  clip: 'M10.5 4.5 5.6 9.4a1.4 1.4 0 0 0 2 2l5.2-5.2a2.9 2.9 0 0 0-4.1-4.1L3.4 7.4a4.4 4.4 0 0 0 6.2 6.2l4.6-4.6',
  file: 'M4 1.5h5.2L12.5 4.8v9.7H4zM9 1.5v3.5h3.5',
  import: 'M8 2.5v7.5M5 7l3 3 3-3M3 12.5h10',
  download: 'M8 2v8.5M4.5 7 8 10.5 11.5 7M3 13.5h10',
  export: 'M8 10V2.5M5 5.5l3-3 3 3M3 12.5h10',
  cloud: 'M4.5 12.5a3 3 0 0 1-.4-6 4 4 0 0 1 7.8 1 2.5 2.5 0 0 1-.4 5z',
  memory: 'M4 2.5h6l2.5 2.5v8.5H4zM6 7h4.5M6 9.5h4.5',
  key: 'M10 6.5a3.5 3.5 0 1 1 1.6 2.94L6.5 14.5H5v1.5H3.5v-2.06l4.56-4.56A3.5 3.5 0 0 1 10 6.5zM12.5 5.5h.01',
  spark: 'M8 2.5l1.4 4.1 4.1 1.4-4.1 1.4L8 13.5l-1.4-4.1L2.5 8l4.1-1.4z',
  chevron: 'M6 4l4 4-4 4',
  play: 'M5 3.5v9l7-4.5z',
  plus: 'M8 3.5v9M3.5 8h9',
  terminal: 'M3 4.5L6.5 8 3 11.5M8.5 11.5H13',
  dots: 'M3.5 8h.01M8 8h.01M12.5 8h.01',
  x: 'M4 4l8 8M12 4l-8 8',
  search: 'M7 12A5 5 0 107 2a5 5 0 000 10zM14 14l-3.3-3.3',
  grid: 'M2.5 2.5H7V7H2.5zM9 2.5h4.5V7H9zM2.5 9H7v4.5H2.5zM9 9h4.5v4.5H9z',
  single: 'M2.5 3h11v10h-11z',
  broadcast:
    'M8 9.2a1.2 1.2 0 100-2.4 1.2 1.2 0 000 2.4zM4.6 11.4a4.8 4.8 0 010-6.8M11.4 4.6a4.8 4.8 0 010 6.8M2.6 13.4a7.6 7.6 0 010-10.8M13.4 2.6a7.6 7.6 0 010 10.8',
  // two sliders: reads as settings at this size, where a small cog reads as a sun
  gear: 'M2.5 4.5h6M12 4.5h1.5M2.5 11.5h1.5M7.500 11.500h6M10.250 6.250a1.750 1.750 0 100-3.500 1.750 1.750 0 000 3.500zM5.750 13.250a1.750 1.750 0 100-3.500 1.750 1.750 0 000 3.500z',
  book: 'M3 2.5h7.5a2 2 0 012 2v9H5a2 2 0 01-2-2zM3 11.5a2 2 0 012-2h7.5',
  pin: 'M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.300-.6z',
  person: 'M8 8a2.7 2.7 0 100-5.4A2.7 2.7 0 008 8zM3 13.5c.6-2.3 2.6-3.5 5-3.5s4.4 1.2 5 3.5',
  refresh: 'M13 8a5 5 0 11-1.5-3.5M13 2.5v3h-3',
  folder: 'M2 4.5a1 1 0 011-1h3l1.5 1.500H13a1 1 0 011 1V12a1 1 0 01-1 1H3a1 1 0 01-1-1z',
  eye: 'M1.500 8S4 3.500 8 3.500 14.500 8 14.500 8 12 12.500 8 12.500 1.500 8 1.500 8zM8 9.800a1.800 1.800 0 100-3.600 1.800 1.800 0 000 3.600z',
  pencil: 'M10.500 2.500l3 3L5 14H2v-3z',
  trash: 'M3 4.500h10M6 4.500V3h4v1.500M4.500 4.500l.5 8.500h6l.5-8.500',
  copy: 'M5.500 5.500h7v7h-7zM3.500 10.500v-7h7',
  move: 'M2.500 8h11M9.500 4l4 4-4 4',
  check: 'M3.5 8.5l3 3 6-7',
  team: 'M6 7.4a2.2 2.2 0 100-4.4 2.2 2.2 0 000 4.4zM1.8 13c.4-2 2-3.2 4.2-3.2s3.8 1.2 4.2 3.2M10.8 7.2a2 2 0 100-4M12.2 9.9c1.200.4 2 1.4 2.300 3.100',
  panel: 'M2.5 3h11v10h-11zM6 3v10',
  server: 'M2.5 3h11v4h-11zM2.5 9h11v4h-11zM5 5h.01M5 11h.01',
  board: 'M2.5 3h3v10h-3zM6.5 3h3v6h-3zM10.5 3h3v8h-3z',
  phone: 'M5 1.5h6a1 1 0 011 1v11a1 1 0 01-1 1H5a1 1 0 01-1-1v-11a1 1 0 011-1zM7 12.5h2',
  // a microphone: voice mode, the one button that needs no words
  mic: 'M8 1.8a2 2 0 012 2v4a2 2 0 11-4 0v-4a2 2 0 012-2zM4 7.5a4 4 0 008 0M8 11.5v2.7M5.8 14.2h4.4',
};

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', 'ic');
  if (name === 'dots') svg.style.strokeWidth = '2';
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}

function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  if (s < 86400 * 30) return Math.floor(s / 86400) + 'd';
  return Math.floor(s / (86400 * 30)) + 'mo';
}

function toast(message, isError) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const el = h('div.toast', { class: isError ? 'error' : '' }, message);
  document.body.append(el);
  setTimeout(() => el.remove(), isError ? 6000 : 2600);
}

const save = () => deck.saveConfig(S.config);

// ---------- menus and dialogs ----------

function closeOverlay() {
  $('#overlay').replaceChildren();
}

// A pop-up menu sits on top of whatever is open: a dialog underneath stays where it is.
let subTimer = 0; // a submenu about to open on hover

function closeMenu() {
  clearTimeout(subTimer);
  document.querySelectorAll('#overlay > .menu, #overlay > .menu-scrim, #overlay > .lim-card').forEach((el) => el.remove());
}

function menu(x, y, items) {
  closeMenu();
  const m = h('div.menu', { role: 'menu' });
  for (const it of items.filter(Boolean)) {
    if (it === '-') m.append(h('hr'));
    else if (it.heading) m.append(h('div.menu-label', {}, it.heading));
    else if (it.info) m.append(h('div.menu-info', {}, h('span', {}, it.info[0]), h('b', {}, it.info[1])));
    else {
      // An item with `sub` opens a menu beside it, on hover or click, and this one stays.
      const dropSubs = () => document.querySelectorAll('#overlay > .ro-panel').forEach((el) => el.remove());
      const btn = h(
        'button',
        {
          class: [it.danger ? 'danger' : '', it.hint ? 'tall' : '', it.sub ? 'has-sub' : ''].join(' '),
          role: 'menuitem',
          'aria-haspopup': it.sub ? 'menu' : null,
          onmouseenter: () => {
            clearTimeout(subTimer);
            if (it.sub) subTimer = setTimeout(() => it.sub(btn), 140);
            else subTimer = setTimeout(dropSubs, 140);
          },
          onclick: () => {
            clearTimeout(subTimer);
            if (it.sub) return it.sub(btn);
            closeMenu();
            it.run();
          },
        },
        it.swatch ? h('span.swatch', { style: `background:${it.swatch}` }) : it.icon ? icon(it.icon) : null,
        it.hint ? h('span.menu-two', {}, h('b', {}, it.label), h('small', {}, it.hint)) : it.label,
        it.checked ? h('span.menu-check', {}, icon('check')) : null,
        it.sub ? h('span.menu-sub', {}, icon('chevron')) : null,
      );
      m.append(btn);
    }
  }
  const scrim = h('div.scrim.menu-scrim', {
    onmousedown: (e) => e.target === scrim && closeMenu(),
    oncontextmenu: (e) => {
      e.preventDefault();
      closeMenu();
    },
  });
  $('#overlay').append(scrim, m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(6, Math.min(x, innerWidth - r.width - 6)) + 'px';
  m.style.top = Math.max(6, Math.min(y, innerHeight - r.height - 6)) + 'px';
}

const menuAt = (el, items) => {
  const r = el.getBoundingClientRect();
  menu(r.left, r.bottom + 4, items);
};

// fields: { key, label, type: text|number|checkbox|textarea|colors|folder, value, hint, placeholder, mono }
function formDialog({ title, body, fields = [], confirm = 'Save', cancel = 'Cancel', danger, wide, extra }) {
  return new Promise((resolve) => {
    closeOverlay();
    const values = {};
    const inputs = {};
    const done = (result) => {
      closeOverlay();
      resolve(result);
    };
    const rows = fields.map((f) => {
      values[f.key] = f.value;
      if (f.type === 'checkbox') {
        const box = h('input', { type: 'checkbox', checked: Boolean(f.value), onchange: () => (values[f.key] = box.checked) });
        return h('label.field.inline', {}, box, h('span', {}, f.label));
      }
      if (f.type === 'colors') {
        const wrap = h('div.colors');
        const paint = () =>
          wrap.replaceChildren(
            ...S.colors.map((c) =>
              h('button', {
                type: 'button',
                class: c === values[f.key] ? 'on' : '',
                style: `background:${c}`,
                title: c,
                onclick: () => {
                  values[f.key] = c;
                  paint();
                },
              }),
            ),
          );
        paint();
        return h('div.field', {}, h('span', {}, f.label), wrap);
      }
      const input =
        f.type === 'textarea'
          ? h('textarea', { value: f.value || '', placeholder: f.placeholder || '' })
          : f.type === 'select'
            ? h(
                'select',
                { onchange: (e) => (values[f.key] = e.target.value) },
                f.options.map((o) => h('option', { value: o.value, selected: o.value === f.value }, o.label)),
              )
            : h('input', { type: f.type === 'number' ? 'number' : 'text', value: f.value ?? '', placeholder: f.placeholder || '' });
      input.addEventListener('input', () => (values[f.key] = f.type === 'number' ? Number(input.value) : input.value));
      inputs[f.key] = input;
      const control =
        f.type === 'folder'
          ? h(
              'div.with-button',
              {},
              input,
              h(
                'button.btn',
                {
                  type: 'button',
                  onclick: async () => {
                    const picked = await deck.pickFolder(input.value);
                    if (picked) {
                      input.value = picked;
                      values[f.key] = picked;
                    }
                  },
                },
                'Browse',
              ),
            )
          : input;
      return h('label.field', { class: f.mono ? 'mono' : '' }, h('span', {}, f.label), control, f.hint ? h('small', {}, f.hint) : null);
    });
    const form = h(
      'form.dialog',
      {
        class: wide ? 'wide' : '',
        onsubmit: (e) => {
          e.preventDefault();
          done(values);
        },
      },
      h('h3', {}, title),
      body ? h('p', {}, body) : null,
      rows,
      h(
        'div.dialog-actions',
        {},
        extra ? h('button.btn', { type: 'button', style: 'margin-right:auto', onclick: () => done({ __extra: true }) }, extra) : null,
        h('button.btn', { type: 'button', onclick: () => done(null) }, cancel),
        h('button.btn', { class: danger ? 'danger' : 'primary', type: 'submit' }, confirm),
      ),
    );
    form.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') done(null);
      if (e.key === 'Enter' && modKey(e)) form.requestSubmit();
    });
    const scrim = h('div.scrim.dim', { onmousedown: (e) => e.target === scrim && done(null) }, form);
    $('#overlay').append(scrim);
    const first = form.querySelector('input[type=text], input[type=number], textarea') || form.querySelector('button[type=submit]');
    first.focus();
    if (first.select && first.tagName === 'INPUT') first.select();
  });
}

const confirmBox = (o) => formDialog({ ...o, fields: [] }).then(Boolean);

// ---------- model ----------

const wsById = (id) => (S.config.workspaces || []).find((w) => w.id === id);
const projectByDir = (dir) => S.projects.find((p) => p.dir === dir);

function wsOf(p) {
  const forced = S.config.projectWorkspace[p.dir];
  if (forced && wsById(forced)) return forced;
  if (!p.path) return null;
  const at = p.path.toLowerCase();
  let best = null;
  let bestLen = -1;
  for (const ws of S.config.workspaces || []) {
    for (const root of ws.roots || []) {
      const r = root.toLowerCase().replace(/\\+$/, '');
      if ((at === r || at.startsWith(r + '\\')) && r.length > bestLen) {
        best = ws.id;
        bestLen = r.length;
      }
    }
  }
  return best;
}

const wsColor = (p) => (p && wsById(wsOf(p)) ? wsById(wsOf(p)).color : 'var(--accent)');
const projectTitle = (p) => S.config.projectAlias[p.dir] || p.name;
const sessionTitle = (s) => S.config.sessionAlias[s.id] || s.title;
const isHiddenProject = (p) => S.config.hiddenProjects.includes(p.dir);
const isHiddenSession = (s) => S.config.hiddenSessions.includes(s.id);
const isPinned = (s) => S.config.pinnedSessions.includes(s.id);
const tabFor = (sessionId) => [...S.tabs.values()].find((t) => sessionId && t.sessionId === sessionId);

// Accounts: the main one is the Claude Code login already on this PC; the
// others are extra logins added here.
const accountList = () => [{ id: 'default', ...S.config.mainAccount }, ...S.config.accounts];
const accountById = (id) => accountList().find((a) => a.id === id);
const multiAccount = () => S.config.accounts.length > 0;

// Most specific choice wins: the session, then its project, then its workspace.
function accountFor(dir, sessionId) {
  const p = dir && projectByDir(dir);
  const ws = p && wsById(wsOf(p));
  const id = (sessionId && S.config.sessionAccount[sessionId]) || (dir && S.config.projectAccount[dir]) || (ws && ws.account) || S.config.defaultAccount;
  return accountById(id) ? id : 'default';
}

function accountLine(id) {
  const st = S.acct.get(id);
  if (!st) return 'Checking';
  if (st.error) return 'Could not check the sign-in';
  if (!st.loggedIn) return 'Not signed in';
  return [st.email, st.plan && st.plan[0].toUpperCase() + st.plan.slice(1)].filter(Boolean).join(', ');
}

// A small label naming an account. With `onPick` it is a button that opens the account list.
function accountChip(id, long, onPick) {
  const a = accountById(id) || accountById('default');
  const attrs = { style: `--acct:${a.color}`, title: `Account: ${a.name}\n${accountLine(a.id)}${onPick ? '\nClick to change' : ''}` };
  if (!onPick) return h('span.acct', attrs, long ? a.name : a.name.slice(0, 2));
  return h(
    'button.acct.pick',
    {
      ...attrs,
      onclick: (e) => {
        e.stopPropagation();
        const r = e.currentTarget.getBoundingClientRect();
        onPick(r.left, r.bottom + 4);
      },
    },
    long ? a.name : a.name.slice(0, 2),
  );
}

// The account list for one open session.
const tabAccountMenu = (tab) => (x, y) => accountMenu(x, y, `Run ${tabTitle(tab)} as`, tab.account, null, (pick) => switchAccount(tab, pick));

function tabTitle(tab) {
  if (tab.kind === 'login' || tab.kind === 'install' || tab.kind === 'agent' || tab.kind === 'agentLogin' || tab.kind === 'agentInstall') return tab.name;
  if (tab.kind === 'shell' && tab.server) return tab.name || 'Server';
  if (tab.kind === 'shell') return 'Terminal';
  const p = projectByDir(tab.dir);
  const s = p && p.sessions.find((x) => x.id === tab.sessionId);
  if (s) return sessionTitle(s);
  const lv = S.live.get(tab.sessionId);
  return tab.name || (lv && lv.name) || 'New session';
}

// The name other sessions use to message this one.
function peerName(tab) {
  const lv = S.live.get(tab.sessionId);
  return (lv && lv.name) || tabTitle(tab);
}

function lampFor(sessionId, tab) {
  if (tab && tab.exited) return 'exited';
  const lv = sessionId && S.live.get(sessionId);
  if (!lv) return '';
  return lv.status === 'idle' ? 'idle' : lv.status === 'shell' ? 'shell' : 'busy';
}

const STATUS_WORDS = { idle: 'Idle, waiting for you', busy: 'Working', shell: 'Running a command', exited: 'Closed', '': 'Not running' };

function visibleSessions(p) {
  const q = S.query.toLowerCase();
  return p.sessions
    .filter((s) => (S.showHidden ? isHiddenProject(p) || isHiddenSession(s) || s.empty : (!isHiddenSession(s) && !s.empty) || tabFor(s.id)))
    .filter((s) => !q || projectTitle(p).toLowerCase().includes(q) || sessionTitle(s).toLowerCase().includes(q) || s.lastPrompt.toLowerCase().includes(q))
    .sort((a, b) => isPinned(b) - isPinned(a) || b.mtime - a.mtime);
}

function visibleProjects() {
  const ws = S.config.activeWorkspace;
  return S.projects.filter((p) => {
    // The hidden view lists hidden things only, from every workspace, so they are easy to find and bring back.
    if (S.showHidden) return isHiddenProject(p) || p.sessions.some((s) => isHiddenSession(s) || s.empty);
    if (isHiddenProject(p)) return false;
    if (ws === 'all') return true;
    if (String(ws).startsWith('srv:')) return p.server === ws.slice(4);
    if (ws === 'none') return wsOf(p) === null;
    return wsOf(p) === ws;
  });
}

// ---------- rail ----------

function renderRail() {
  const liveIn = (filter) =>
    S.projects.filter((p) => !isHiddenProject(p) && filter(p)).reduce((n, p) => n + p.sessions.filter((s) => S.live.has(s.id)).length, 0);
  const item = (id, label, title, color, count) =>
    h(
      'button.ws',
      {
        class: S.config.activeWorkspace === id ? 'on' : '',
        style: color ? `--ws-color:${color}` : '',
        title,
        onclick: () => switchWorkspace(id),
        oncontextmenu: (e) => {
          e.preventDefault();
          if (wsById(id)) workspaceMenu(e.clientX, e.clientY, wsById(id));
        },
      },
      label,
      count ? h('span.count', {}, count) : null,
    );
  const initials = (name) => {
    const words = name.trim().split(/\s+/);
    return (words.length > 1 ? words[0][0] + words[1][0] : name.slice(0, 2)).toUpperCase();
  };
  const hasLoose = S.projects.some((p) => !isHiddenProject(p) && wsOf(p) === null);
  put(
    $('#rail'),
    item(
      'all',
      'All',
      'All projects',
      null,
      liveIn(() => true),
    ),
    ...(S.config.workspaces || []).map((w) =>
      item(
        w.id,
        initials(w.name),
        w.name,
        w.color,
        liveIn((p) => wsOf(p) === w.id),
      ),
    ),
    hasLoose
      ? item(
          'none',
          '?',
          'Projects outside every workspace',
          '#647a8c',
          liveIn((p) => wsOf(p) === null),
        )
      : null,
    railServers(item, liveIn),
    h('button.ws.add', { title: 'New workspace', onclick: () => editWorkspace(null) }, icon('plus')),
  );
}

function switchWorkspace(id) {
  S.config.activeWorkspace = id;
  save();
  renderRail();
  renderSidebarHead();
  renderList();
}

async function editWorkspace(ws) {
  const v = await formDialog({
    title: ws ? 'Edit workspace' : 'New workspace',
    body: ws
      ? null
      : 'A workspace groups projects. Give it a folder and every project inside that folder joins automatically; you can also move single projects in by hand.',
    fields: [
      { key: 'name', label: 'Name', value: ws ? ws.name : '', placeholder: 'Freelance' },
      { key: 'root', label: 'Folder (optional)', type: 'folder', value: ws ? (ws.roots || [])[0] || '' : '', placeholder: 'D:\\Freelance', mono: true },
      { key: 'color', label: 'Colour', type: 'colors', value: ws ? ws.color : S.colors[(S.config.workspaces || []).length % S.colors.length] },
      multiAccount()
        ? {
            key: 'account',
            label: 'Claude account for sessions in this workspace',
            type: 'select',
            value: (ws && accountById(ws.account) && ws.account) || '',
            options: [{ value: '', label: 'The default account' }, ...accountList().map((a) => ({ value: a.id, label: a.name }))],
          }
        : null,
    ].filter(Boolean),
    confirm: ws ? 'Save' : 'Create workspace',
  });
  if (!v || !String(v.name).trim()) return;
  const data = {
    name: v.name.trim(),
    color: v.color,
    roots: v.root && v.root.trim() ? [v.root.trim()] : [],
    account: v.account || (ws && !multiAccount() ? ws.account : '') || '',
  };
  if (ws) Object.assign(ws, data);
  else {
    const made = { id: 'ws' + Date.now().toString(36), ...data };
    S.config.workspaces.push(made);
    S.config.activeWorkspace = made.id;
  }
  save();
  renderAll();
}

function workspaceMenu(x, y, ws) {
  menu(x, y, [
    { label: 'Edit workspace', icon: 'pencil', run: () => editWorkspace(ws) },
    { label: 'Open pinned sessions', icon: 'play', run: () => openPinned(S.projects.filter((p) => wsOf(p) === ws.id && !isHiddenProject(p))) },
    '-',
    {
      label: 'Delete workspace',
      icon: 'trash',
      danger: true,
      run: async () => {
        const ok = await confirmBox({
          title: `Delete the workspace "${ws.name}"?`,
          body: 'Only the grouping is removed. Projects, sessions and their history stay exactly as they are.',
          confirm: 'Delete workspace',
          danger: true,
        });
        if (!ok) return;
        S.config.workspaces = S.config.workspaces.filter((w) => w.id !== ws.id);
        for (const [dir, id] of Object.entries(S.config.projectWorkspace)) if (id === ws.id) delete S.config.projectWorkspace[dir];
        if (S.config.activeWorkspace === ws.id) S.config.activeWorkspace = 'all';
        save();
        renderAll();
      },
    },
  ]);
}

// ---------- sidebar ----------

function renderSidebarHead() {
  const id = S.config.activeWorkspace;
  const ws = wsById(id);
  const srv = String(id).startsWith('srv:') ? serverById(id.slice(4)) : null;
  const name = ws ? ws.name : srv ? srv.name : id === 'none' ? 'Unsorted' : 'All projects';
  const search = h('input', {
    type: 'text',
    placeholder: 'Find a project or session',
    value: S.query,
    id: 'search',
    oninput: (e) => {
      S.query = e.target.value;
      renderList();
    },
    onkeydown: (e) => {
      if (e.key === 'Escape') {
        S.query = '';
        e.target.value = '';
        renderList();
        focusActive();
      }
    },
  });
  put(
    $('#sidebar-head'),
    h(
      'div.ws-title',
      {},
      h('h1', { title: ws && ws.roots && ws.roots[0] ? ws.roots[0] : name }, name),
      ws ? h('button.mini', { title: 'Workspace options', onclick: (e) => workspaceMenu(e.clientX, e.clientY, ws) }, icon('dots')) : null,
      h('button.mini', { title: 'Refresh the session list', onclick: () => rescan(true) }, icon('refresh')),
    ),
    h(
      'div.srv-actions',
      {},
      h(
        'button.btn.small.primary',
        { title: S.switches.servers ? 'Start a session in any folder, on this PC or on a server' : 'Start a session in any folder', onclick: () => startSession(srv) },
        icon('plus'),
        'New session',
      ),
      srv ? h('button.btn.small', { title: 'Open a plain terminal on the server', onclick: () => serverShell(srv) }, icon('terminal'), 'Terminal') : null,
    ),
    h('label.search', {}, icon('search'), search),
  );
}

function renderList() {
  phoneSync();
  const list = $('#sidebar-list');
  const keep = list.scrollTop;
  const projects = visibleProjects();
  const nodes = [];
  for (const p of projects) {
    // A Claude session handed to another agent is listed once, as that agent's row.
    const handedOff = new Set(Object.values(S.config.agentSessions || {}).map((r) => r.memberId));
    const sessions = withSubs(visibleSessions(p).filter((s) => !handedOff.has(s.id)));
    if ((S.query || S.showHidden) && !sessions.length && !(S.showHidden && !S.query && isHiddenProject(p))) continue;
    const open = S.query ? true : !S.config.collapsed[p.dir];
    const limit = S.expanded[p.dir] || S.query ? Infinity : 6;
    const liveCount = p.sessions.filter((s) => S.live.has(s.id)).length;
    const head = h(
      'div.project-head',
      {
        title: p.path || 'This folder was moved or deleted',
        onclick: () => {
          S.config.collapsed[p.dir] = open;
          save();
          renderList();
        },
        oncontextmenu: (e) => {
          e.preventDefault();
          projectMenu(e.clientX, e.clientY, p);
        },
      },
      h('span.chev', {}, icon('chevron')),
      h('div.project-name', {}, h('b', {}, projectTitle(p)), p.server ? serverChip(p.server, true) : null, h('span', {}, liveCount ? `${liveCount} running` : `${sessions.length}`)),
      h(
        'div.row-actions',
        { onclick: (e) => e.stopPropagation() },
        S.showHidden && isHiddenProject(p)
          ? h(
              'button.mini.text',
              {
                title: 'Show this project in the normal list again',
                onclick: () => {
                  toggleIn(S.config.hiddenProjects, p.dir);
                  save();
                  renderAll();
                },
              },
              'Unhide',
            )
          : null,
        h('button.mini', { title: 'Open pinned sessions (all of them if none are pinned)', onclick: () => openPinned([p]) }, icon('play')),
        h('button.mini', { title: 'Start a new session here', onclick: () => newSession(p) }, icon('plus')),
        h('button.mini', { title: 'Open a plain terminal here', onclick: () => openShell(p) }, icon('terminal')),
        p.server ? null : h('button.mini', { title: 'Board: the tickets and the team of this project', onclick: () => openBoard(p) }, icon('board')),
        h('button.mini', { title: 'More', onclick: (e) => projectMenu(e.clientX, e.clientY, p) }, icon('dots')),
      ),
    );
    // Sub-sessions sit under the session that started them, whatever its group.
    const inTree = (s) => {
      const sub = subOf(s.id);
      return Boolean(sub && sessions.some((x) => x.id === sub.parent));
    };
    const groups = p.server || S.showHidden ? null : roleGroups(p, sessions.filter((s) => !inTree(s)));
    const rows = groups
      ? groups.map((g) => {
          const id = `${p.dir}|${g.key}`;
          const shut = !S.query && S.config.collapsed[id];
          return h(
            'div.role-group',
            { class: shut ? '' : 'open' },
            h(
              'button.role-head',
              {
                onclick: () => {
                  S.config.collapsed[id] = !shut;
                  save();
                  renderList();
                },
              },
              h('span.chev', {}, icon('chevron')),
              h('b', {}, g.title),
              h('span', {}, String(g.sessions.length)),
            ),
            shut ? null : h('div.sessions', {}, withSubs([...g.sessions, ...sessions.filter((x) => inTree(x) && g.sessions.some((y) => y.id === subOf(x.id).parent))]).map((s) => sessionRow(p, s))),
          );
        })
      : sessions.slice(0, limit).map((s) => sessionRow(p, s));
    if (!groups && sessions.length > limit) {
      rows.push(
        h(
          'button.more-link',
          {
            onclick: () => {
              S.expanded[p.dir] = true;
              renderList();
            },
          },
          `Show ${sessions.length - limit} older`,
        ),
      );
    }
    nodes.push(
      h(
        'div.project',
        { class: [open ? 'open' : '', p.exists ? '' : 'missing', isHiddenProject(p) ? 'hidden-item' : ''].join(' ') },
        head,
        open ? h('div.sessions', {}, rows, p.server ? null : agentRows(p)) : null,
      ),
    );
  }
  if (S.showHidden && nodes.length) nodes.unshift(h('div.side-note', {}, 'Hidden items only. Unhide the ones you want back.'));
  if (!nodes.length) {
    nodes.push(
      h(
        'div.side-empty',
        {},
        S.query
          ? `Nothing matches "${S.query}".`
          : S.showHidden
            ? 'Nothing is hidden.'
            : String(S.config.activeWorkspace).startsWith('srv:')
              ? 'No sessions on this server yet. Choose New session above, pick a folder, and it starts there. Every folder you use shows up here as a project.'
              : S.config.activeWorkspace === 'all'
                ? 'No Claude Code sessions found yet. Choose New session above to start one.'
                : 'Nothing in this workspace yet. Choose New session above, or right-click a project in All and choose Move to workspace.',
      ),
    );
  }
  list.replaceChildren(...nodes);
  list.scrollTop = keep;

  const hiddenCount = S.config.hiddenProjects.length + S.config.hiddenSessions.length;
  put(
    $('#sidebar-foot'),
    h('span', {}, `${projects.length} project${projects.length === 1 ? '' : 's'}`),
    hiddenCount || S.showHidden
      ? h(
          'button.link',
          {
            onclick: () => {
              S.showHidden = !S.showHidden;
              renderList();
            },
          },
          S.showHidden ? 'Back to the normal list' : `Show ${hiddenCount} hidden`,
        )
      : null,
    S.trash.length ? h('button.link', { title: 'Deleted sessions are kept for 30 days', onclick: (e) => trashMenu(e.clientX, e.clientY) }, `${S.trash.length} deleted`) : null,
  );
}

// A model id as people say it: claude-opus-5-5 -> Opus 5.5. Other ids stay as they are.
function modelName(id) {
  const cap = (w) => w[0].toUpperCase() + w.slice(1);
  const m = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(id || '');
  if (m) return `${cap(m[1])} ${m[2]}${m[3] ? '.' + m[3] : ''}`;
  const old = /^claude-(\d+)-(\d+)-(opus|sonnet|haiku)/.exec(id || '');
  if (old) return `${cap(old[3])} ${old[1]}.${old[2]}`;
  return id || '';
}

// What a Claude session runs on: the tool, the model of its last reply, and whose login or key.
function runsOn(p, s) {
  const llm = !p.server && llmFor(p.dir, s.id);
  const acct = accountById(accountFor(p.dir, s.id));
  const model = s.model ? modelName(s.model) : llm ? llmById(llm).model : '';
  const via = llm ? `${llmName(llm)} API key` : !p.server && multiAccount() && acct ? `${acct.name} account` : '';
  return ['Claude Code', model, via].filter(Boolean).join(' · ');
}

function sessionRow(p, s) {
  const tab = tabFor(s.id);
  const lv = S.live.get(s.id);
  const lamp = lampFor(s.id, tab);
  // Loop's own background sessions are here, not in another window: they are
  // working for a phone, or on something a teammate handed them.
  const here = Boolean(lv && (lv.bg || S.held.has(s.id)));
  const elsewhere = lv && !tab && !here;
  // The Claude desktop app has it: running there now, or used there last (/desktop).
  const inAppNow = elsewhere && lv.entrypoint === 'claude-desktop';
  const inApp = !p.server && !tab && (inAppNow || (s.inApp && !lv));
  return h(
    'button.session',
    {
      class: [
        tab ? 'open' : '',
        tab && tab.id === S.active ? 'active' : '',
        s.named || S.config.sessionAlias[s.id] ? 'named' : '',
        isHiddenSession(s) || s.empty ? 'hidden-item' : '',
        subOf(s.id) ? 'sub' : '',
        subOf(s.id) && subOf(s.id).status !== 'working' ? 'done' : '',
      ].join(' '),
      title: `${sessionTitle(s)}\n${runsOn(p, s)}${S.config.sessionRole[s.id] ? '\nRole: ' + S.config.sessionRole[s.id] : ''}\n${STATUS_WORDS[lamp]}${inAppNow ? ' in the Claude app' : elsewhere ? ' in another window' : here ? ' in Loop, with no terminal open. Click to open it here.' : ''}${inApp && !inAppNow ? '\nLast used in the Claude app. Opening it here moves it to Loop.' : ''}${s.lastPrompt ? '\n\nLast prompt: ' + s.lastPrompt : ''}`,
      onclick: () => openSession(p, s),
      oncontextmenu: (e) => {
        e.preventDefault();
        sessionMenu(e.clientX, e.clientY, p, s);
      },
    },
    h('span.lamp', { class: lamp }),
    h('span.title', {}, sessionTitle(s)),
    isPinned(s) ? h('span.pin', { title: 'Pinned' }, icon('pin')) : null,
    // A session on a server runs as the server's own login, whatever this PC's accounts are.
    !p.server && S.config.sessionAccount[s.id] && accountById(S.config.sessionAccount[s.id]) ? accountChip(S.config.sessionAccount[s.id]) : null,
    !p.server && llmFor(p.dir, s.id) ? llmChip(llmFor(p.dir, s.id)) : null,
    S.showHidden && isHiddenSession(s)
      ? h(
          'span.tag.act',
          {
            title: 'Show this session in the normal list again',
            onclick: (e) => {
              e.stopPropagation();
              toggleIn(S.config.hiddenSessions, s.id);
              save();
              renderList();
            },
          },
          'Unhide',
        )
      : inApp
        ? h('span.tag.app', { title: inAppNow ? 'Open in the Claude app right now' : 'Last used in the Claude app' }, inAppNow ? 'in Claude app' : 'Claude app')
        : elsewhere
        ? h('span.tag', {}, p.server ? 'running' : 'elsewhere')
        : here
          ? h('span.tag.mine', { title: 'Running in the background for Loop. Click to open its terminal.' }, 'in Loop')
          : h('span.when', {}, ago(s.mtime)),
  );
}

function toggleIn(list, value) {
  const i = list.indexOf(value);
  if (i === -1) list.push(value);
  else list.splice(i, 1);
}

function moveMenu(x, y, p) {
  menu(x, y, [
    { heading: `Move ${projectTitle(p)} to` },
    ...(S.config.workspaces || []).map((w) => ({
      label: w.name,
      swatch: w.color,
      run: () => {
        S.config.projectWorkspace[p.dir] = w.id;
        save();
        renderAll();
      },
    })),
    '-',
    {
      label: 'Decide by folder',
      icon: 'folder',
      run: () => {
        delete S.config.projectWorkspace[p.dir];
        save();
        renderAll();
      },
    },
  ]);
}

function projectMenu(x, y, p) {
  menu(x, y, [
    { label: 'Open pinned sessions', icon: 'play', run: () => openPinned([p]) },
    { label: 'New session', icon: 'plus', run: () => newSession(p) },
    p.server ? null : { label: 'New session with another AI', icon: 'spark', run: () => agentPickMenu(x, y, p) },
    { label: 'Open terminal here', icon: 'terminal', run: () => openShell(p) },
    p.server ? null : { label: 'Board', icon: 'board', run: () => openBoard(p) },
    p.server ? null : { label: teamOf(p.dir) ? 'Team' : 'Create a team', icon: 'team', run: () => openTeamSetup(p) },
    p.server ? null : { label: 'Project memory', icon: 'book', run: () => openDrawer(p.dir, null) },
    p.server || S.remote ? null : { label: `Tools: ${toolsLabel(p.dir)}`, icon: 'gear', run: () => projectToolsMenu(x, y, p) },
    '-',
    { label: 'Move to workspace', icon: 'move', run: () => moveMenu(x, y, p) },
    p.server ? null : { label: `Model: ${llmName(llmFor(p.dir, null))}`, icon: 'spark', run: () => projectLlmMenu(x, y, p) },
    multiAccount() && !p.server
      ? {
          label: `Account: ${accountById(accountFor(p.dir, null)).name}`,
          icon: 'person',
          run: () =>
            accountMenu(
              x,
              y,
              `Sessions in ${projectTitle(p)} run as`,
              accountFor(p.dir, null),
              S.config.projectAccount[p.dir] ? 'Follow the workspace' : null,
              (id) => {
                if (id) S.config.projectAccount[p.dir] = id;
                else delete S.config.projectAccount[p.dir];
                save();
                renderAll();
                toast('Applies to sessions opened from now on. Open terminals keep their account until you switch them.');
              },
            ),
        }
      : null,
    {
      label: 'Rename',
      icon: 'pencil',
      run: async () => {
        const v = await formDialog({
          title: 'Rename project',
          body: 'This changes the label in Loop only. The folder keeps its name.',
          fields: [{ key: 'name', label: 'Name', value: projectTitle(p), placeholder: p.name }],
        });
        if (!v) return;
        if (v.name.trim() && v.name.trim() !== p.name) S.config.projectAlias[p.dir] = v.name.trim();
        else delete S.config.projectAlias[p.dir];
        save();
        renderAll();
      },
    },
    p.exists && !p.server ? { label: 'Show in Explorer', icon: 'folder', run: () => deck.reveal(p.path) } : null,
    p.exists ? { label: 'Copy path', icon: 'copy', run: () => deck.clipWrite(p.path) } : null,
    '-',
    {
      label: isHiddenProject(p) ? 'Unhide project' : 'Hide project',
      icon: 'eye',
      run: () => {
        toggleIn(S.config.hiddenProjects, p.dir);
        save();
        renderAll();
      },
    },
  ]);
}

// End a session, wherever Loop is running it: a terminal here, one whose window
// you closed, or a background runner working for a phone.
async function stopSession(s, force) {
  const tab = tabFor(s.id);
  if (tab) return closeTab(tab.id, { stop: true, force });
  const kept = S.held.get(s.id);
  if (kept) {
    S.held.delete(s.id);
    deck.kill(kept.id, force);
  }
  const lv = S.live.get(s.id);
  if (lv && lv.bg) await deck.directStop(s.id);
  // Running in another window, or in the Claude desktop app: it is still your
  // session, so it can be ended from here.
  else if (lv && !kept && !(await deck.closeElsewhere(s.id, force))) {
    toast(`Could not stop "${sessionTitle(s)}". It may have finished already, or belong to another program.`, true);
  }
  setTimeout(() => rescan(false), 800);
}

// Where a session that is not ours is running, in words.
function whereItRuns(lv) {
  const how = (lv || {}).entrypoint || '';
  if (how === 'claude-desktop') return 'the Claude desktop app';
  if (how === 'sdk-cli') return 'another program using Claude Code';
  return 'another terminal window';
}

function sessionMenu(x, y, p, s) {
  const tab = tabFor(s.id);
  const running = Boolean(tab) || S.held.has(s.id) || S.live.has(s.id);
  menu(x, y, [
    { label: tab ? 'Go to terminal' : 'Open', icon: 'play', run: () => openSession(p, s) },
    tab ? { label: 'Close, keep it working', icon: 'x', run: () => closeTab(tab.id) } : null,
    // Stopping a session is deliberate, and separate from putting its terminal away.
    running && !p.server
      ? {
          label: 'Stop this session',
          icon: 'x',
          danger: true,
          run: () => stopSession(s),
        }
      : null,
    running && !p.server
      ? {
          label: 'Force stop',
          icon: 'x',
          danger: true,
          run: () => stopSession(s, true),
        }
      : null,
    p.server && S.live.has(s.id)
      ? {
          label: 'Stop it on the server',
          icon: 'x',
          danger: true,
          run: async () => {
            const ok = await confirmBox({
              title: `Stop "${sessionTitle(s)}" on the server?`,
              body: 'It ends the session there. The conversation is saved and can be opened again.',
              confirm: 'Stop session',
              danger: true,
            });
            if (!ok) return;
            if (tabFor(s.id)) await closeTab(tabFor(s.id).id, { stop: true });
            if (!(await deck.serverStop({ server: p.server, sessionId: s.id }))) toast('The server did not confirm. It may have stopped already.', true);
          },
        }
      : null,
    {
      label: isPinned(s) ? 'Unpin' : 'Pin to this project',
      icon: 'pin',
      run: () => {
        toggleIn(S.config.pinnedSessions, s.id);
        save();
        renderList();
      },
    },
    { label: 'Rename', icon: 'pencil', run: () => renameSession(s) },
    p.server ? null : '-',
    p.server ? null : { label: 'Runs on', hint: runsOnLine(p, { id: s.id, name: sessionTitle(s), agent: 'claude' }), icon: 'spark', sub: (el) => runsOnPicker(el, p, { id: s.id, name: sessionTitle(s), agent: 'claude' }) },
    p.server ? null : '-',
    p.server ? null : { label: 'Peek at the last messages', icon: 'eye', run: () => peekSession(p, s) },
    !p.server && !subOf(s.id) ? { label: 'New sub-session…', icon: 'plus', run: () => subDialog(p, s) } : null,
    subOf(s.id) && subOf(s.id).result ? { label: 'What it handed back', icon: 'book', run: () => formDialog({ title: subOf(s.id).name, body: subOf(s.id).result + (subOf(s.id).branch ? `

Branch: ${subOf(s.id).branch}` : ''), confirm: 'Close' }) } : null,
    subOf(s.id) && subOf(s.id).status !== 'closed'
      ? {
          label: 'Delete sub-session',
          icon: 'x',
          run: async () => {
            const r = await closeSub(s.id);
            toast(r.text, !r.ok);
          },
        }
      : null,
    { label: 'More', icon: 'dots', run: () => sessionMoreMenu(x, y, p, s) },
    '-',
    {
      label: isHiddenSession(s) ? 'Unhide session' : 'Hide session',
      icon: 'eye',
      run: () => {
        toggleIn(S.config.hiddenSessions, s.id);
        save();
        renderList();
      },
    },
    p.server ? null : { label: 'Delete session', icon: 'trash', danger: true, run: () => deleteSession(p, s) },
  ]);
}

// The items a session needs now and then, one step away.
function sessionMoreMenu(x, y, p, s) {
  menu(x, y, [
    { heading: sessionTitle(s) },
    p.server ? null : { label: 'Knowledge base', icon: 'book', run: () => openDrawer(p.dir, s.id) },
    !p.server && teamOf(p.dir) ? { label: `Team role${roleOf(p.dir, s.id) ? ': ' + roleOf(p.dir, s.id).title : ''}`, icon: 'team', run: () => roleMenu(x, y, p, s) } : null,
    !p.server && teamOf(p.dir)
      ? null
      : {
          label: S.config.sessionRole[s.id] ? 'Change role' : 'Set role',
          icon: 'person',
          run: async () => {
            const v = await formDialog({
              title: `Role of ${sessionTitle(s)}`,
              body: 'One line on what this session is responsible for. Teammates see it when they look up who to ask, and the session is told it when it starts here.',
              fields: [{ key: 'role', label: 'Role', value: S.config.sessionRole[s.id] || '', placeholder: 'Backend developer: owns the API and database migrations' }],
            });
            if (!v) return;
            if (v.role.trim()) S.config.sessionRole[s.id] = v.role.trim().slice(0, 300);
            else delete S.config.sessionRole[s.id];
            save();
            renderList();
          },
        },
    '-',
    { label: 'Copy session ID', icon: 'copy', run: () => deck.clipWrite(s.id) },
    p.server ? null : { label: 'Copy resume command', icon: 'copy', run: () => deck.clipWrite(`${S.config.settings.claudeCmd} ${S.config.settings.flags} --resume ${s.id}`.replace(/\s+/g, ' ')) },
  ]);
}

async function renameSession(s) {
  const v = await formDialog({
    title: 'Rename session',
    body: 'One name everywhere: here, in the Claude app, in /resume and on Remote Control.',
    fields: [{ key: 'name', label: 'Name', value: sessionTitle(s) }],
  });
  const name = v && v.name.replace(/\s+/g, ' ').trim();
  if (!name || name === sessionTitle(s)) return;
  const tab = tabFor(s.id);
  const { p } = sessionById(s.id);
  // Open here: the session renames itself. Otherwise the name goes into its file.
  if (tab && !tab.exited && isClaudeTab(tab) && !tab.agent) deck.write(tab.id, `/rename ${name}\r`);
  else if (!p || p.server || !(await deck.renameInFile({ dir: p.dir, sessionId: s.id, name }))) return toast('Could not rename this session.', true);
  delete S.config.sessionAlias[s.id];
  s.title = name;
  s.named = s.titled = true;
  if (tab) tab.name = name;
  save();
  renderAll();
}

// Move a session's saved conversation to the Recycle Bin and forget what Loop kept about it.
async function deleteSession(p, s) {
  const ok = await confirmBox({
    title: `Delete "${sessionTitle(s)}"?`,
    body: 'It leaves this list and its team. You can bring it back from "deleted" at the bottom of the list for 30 days; after that it is removed for good. Project memory and the board stay as they are.',
    confirm: 'Delete session',
    danger: true,
  });
  if (!ok) return;
  if (tabFor(s.id)) {
    await closeTab(tabFor(s.id).id, { stop: true });
    await new Promise((r) => setTimeout(r, 1500)); // the session lets go of its file as it exits
  } else if (S.live.has(s.id)) return toast('That session is running outside Loop. Close it there first.', true);
  const title = sessionTitle(s);
  if (!(await deck.sessionTrash({ dir: p.dir, sessionId: s.id, title: `${title} (${projectTitle(p)})` }))) {
    return toast('Could not delete it. If it is still running, close it and try again.', true);
  }
  for (const key of ['sessionAlias', 'sessionRole', 'sessionAccount', 'sessionLlm', 'sessionModel']) if (S.config[key]) delete S.config[key][s.id];
  for (const key of ['pinnedSessions', 'hiddenSessions']) S.config[key] = S.config[key].filter((id) => id !== s.id);
  const t = teamOf(p.dir);
  if (t) delete t.members[s.id];
  save();
  S.trash = await deck.trashList();
  await rescan(true);
  toast(`${title} is deleted. You can bring it back for 30 days.`);
}

// The deleted sessions that can still be brought back.
function trashMenu(x, y) {
  const days = (t) => Math.max(1, Math.ceil((t.until - Date.now()) / 86400000));
  menu(x, y, [
    { heading: 'Deleted sessions: pick one to bring it back' },
    ...S.trash.slice(0, 30).map((t) => ({
      label: t.title,
      hint: `${days(t)} day${days(t) === 1 ? '' : 's'} left`,
      run: async () => {
        const ok = await deck.trashRestore({ dir: t.dir, sessionId: t.id });
        S.trash = await deck.trashList();
        await rescan(true);
        toast(ok ? `${t.title} is back in its project.` : 'Could not bring it back.', !ok);
      },
    })),
  ]);
}

// Pick an account. `reset` adds an entry that hands the choice back to the level above.
function accountMenu(x, y, heading, current, reset, pick) {
  menu(x, y, [
    { heading },
    ...accountList().map((a) => ({ label: a.name, hint: accountLine(a.id), swatch: a.color, checked: a.id === current, run: () => pick(a.id) })),
    reset ? '-' : null,
    reset ? { label: reset, icon: 'refresh', run: () => pick(null) } : null,
    '-',
    { label: 'Add another account', icon: 'plus', run: () => editAccount(null) },
    { label: 'Manage accounts', icon: 'gear', run: openAccounts },
  ]);
}

// ---------- terminals ----------

const TERM_THEME = {
  background: '#0e161d',
  foreground: '#d5dee6',
  cursor: '#f0b24a',
  cursorAccent: '#0e161d',
  selectionBackground: '#2f4a61',
  black: '#1b2731',
  red: '#ee7b6c',
  green: '#57c98a',
  yellow: '#f0b24a',
  blue: '#7cc4f0',
  magenta: '#b79cf2',
  cyan: '#5fd0c5',
  white: '#c9d4dc',
  brightBlack: '#647a8c',
  brightRed: '#f59a8e',
  brightGreen: '#7ddba6',
  brightYellow: '#f6c878',
  brightBlue: '#a3d7f6',
  brightMagenta: '#cdbaf7',
  brightCyan: '#8be0d8',
  brightWhite: '#f2f6f9',
};

// Terminal output is fed to the screen on a per-frame budget. Left alone, every
// terminal that is printing takes its own slice of each frame, and a few busy
// sessions are enough to freeze the whole window.
const OUT = { budget: 48 * 1024, last: 0, raf: 0, timer: 0, turn: 0, spent: false };
const OUT_HOLD = 1024 * 1024; // ask the process to wait once this much is queued for one terminal
const OUT_RELEASE = 128 * 1024;

function doneLoading(tab) {
  if (!tab.loading) return;
  tab.loading.remove();
  tab.loading = null;
}

// A server has no browser, so its sign-in prints a link and waits. Open that
// link here, once, the way Claude Code would have on this PC.
function openSignInLink(tab, data) {
  if (!tab.server || (tab.kind !== 'login' && tab.kind !== 'install')) return;
  tab.seen = ((tab.seen || '') + data).slice(-6000);
  // Done: learn the new state from the server at once, and put the sign-in tab away.
  if (!tab.finished && /Login successful|Installation complete/.test(tab.seen)) {
    tab.finished = true;
    const signedIn = tab.kind === 'login';
    deck.serverProbe(tab.server).then(() => {
      if (!signedIn) return;
      toast(`Claude is signed in on ${serverById(tab.server) ? serverById(tab.server).name : 'the server'}.`);
      setTimeout(() => closeTab(tab.id, { stop: true }), 1200);
    });
  }
  if (tab.linkOpened || tab.kind !== 'login') return;
  // Only a link that has arrived whole: the stream comes in pieces, and half a link is no use.
  const m = /\x1b\]8;[^;\x07\x1b]*;(https:\/\/claude\.(?:com|ai)\/[^\x07\x1b\s]+)(?:\x07|\x1b\\)/.exec(tab.seen);
  if (!m) return;
  tab.linkOpened = true;
  deck.openExternal(m[1]);
  toast('The sign-in page is open in your browser. Approve it there, then paste the code here if the tab asks for one.');
}

function queueOutput(tab, data) {
  doneLoading(tab);
  phoneEcho(tab, data);
  openSignInLink(tab, data);
  tab.pending.push(data);
  tab.pendingSize += data.length;
  if (!tab.held && tab.pendingSize > OUT_HOLD) {
    tab.held = true;
    deck.flow(tab.id, true);
  }
  if (!OUT.raf) {
    OUT.raf = requestAnimationFrame(pumpOutput);
    OUT.timer = setTimeout(pumpOutput, 120); // frames stop while the window is hidden
  }
}

function takeOutput(tab, max) {
  max = Math.max(1, Math.floor(max));
  let out = '';
  while (tab.pending.length && out.length < max) {
    const head = tab.pending[0];
    const room = max - out.length;
    if (head.length <= room) {
      out += head;
      tab.pending.shift();
    } else {
      out += head.slice(0, room);
      tab.pending[0] = head.slice(room);
    }
  }
  tab.pendingSize -= out.length;
  if (tab.held && tab.pendingSize < OUT_RELEASE) {
    tab.held = false;
    deck.flow(tab.id, false);
  }
  return out;
}

function pumpOutput() {
  cancelAnimationFrame(OUT.raf);
  clearTimeout(OUT.timer);
  OUT.raf = 0;
  const now = performance.now();
  const gap = now - OUT.last;
  OUT.last = now;
  // Slow frames mean the screen is behind: feed less. Fast ones, when the whole
  // budget was used, mean there is room for more.
  if (gap < 200) {
    if (gap > 40) OUT.budget = Math.max(12 * 1024, OUT.budget * 0.5);
    else if (gap > 22) OUT.budget = Math.max(12 * 1024, OUT.budget * 0.8);
    else if (gap < 18 && OUT.spent) OUT.budget = Math.min(256 * 1024, OUT.budget * 1.15);
  }
  const waiting = S.order.map((id) => S.tabs.get(id)).filter((t) => t.pendingSize > 0);
  if (!waiting.length) return;
  OUT.spent = waiting.reduce((n, t) => n + t.pendingSize, 0) >= OUT.budget;
  let left = OUT.budget;
  const active = S.tabs.get(S.active);
  if (active && active.pendingSize) {
    const chunk = takeOutput(active, left);
    left -= chunk.length;
    active.term.write(chunk);
  }
  // The terminal in front goes first; the rest share what is left, taking turns.
  const rest = waiting.filter((t) => t !== active);
  const share = Math.max(2048, Math.floor(left / Math.max(1, rest.length)));
  OUT.turn++;
  for (let i = 0; i < rest.length; i++) {
    const t = rest[(i + OUT.turn) % rest.length];
    t.term.write(takeOutput(t, share));
  }
  if (S.order.some((id) => S.tabs.get(id).pendingSize > 0)) {
    OUT.raf = requestAnimationFrame(pumpOutput);
    OUT.timer = setTimeout(pumpOutput, 120);
  }
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(r));
const isClaudeTab = (t) => t.kind === 'resume' || t.kind === 'new';

// Opening several at once: one per frame, so the window keeps responding.
async function createTabs(specs) {
  for (let i = 0; i < specs.length; i++) {
    createTab(specs[i], i === 0);
    await nextFrame();
  }
}

function createTab(o, activateIt = true) {
  const id = o.id || `t${S.winId}_${++tabSeq}`;
  const termEl = h('div.pane-term');
  // A resumed session starts with its name, so it shows the same name in its
  // prompt, its terminal title and on Remote Control as it does here.
  if (o.kind === 'resume' && !o.name && !o.server && !o.adopt) {
    const { s } = sessionById(o.sessionId);
    if (s && (s.titled || S.config.sessionAlias[s.id])) o = { ...o, name: sessionTitle(s) };
  }
  const tab = { id, ...o, exited: false, attention: false, started: false, pending: [], pendingSize: 0, held: false };
  tab.account = o.account || accountFor(o.dir, o.sessionId);
  tab.head = h('div.pane-head');
  // Covers the empty terminal until Claude prints its first screen.
  tab.loadingText = h('span', {}, 'Starting session');
  tab.loading = isClaudeTab(tab) && !o.adopt ? h('div.pane-loading', {}, h('span.spinner'), tab.loadingText) : null;
  tab.exited = Boolean(o.adopt && o.exited);
  tab.pane = h('div.pane', { onmousedown: () => S.active !== id && activate(id) }, tab.head, termEl, tab.loading);

  const term = new Terminal({
    fontFamily: "'Cascadia Mono', 'Cascadia Code', Consolas, monospace",
    fontSize: S.config.settings.fontSize || 13,
    lineHeight: 1.15,
    cursorBlink: true,
    scrollback: 6000,
    allowProposedApi: true,
    theme: TERM_THEME,
    cols: 120,
    rows: 30,
    windowsPty: { backend: 'conpty', buildNumber: S.winBuild },
    // Links a program marks as links (Claude Code does) open in your browser. Without
    // this the terminal asks "do you want to navigate" and then goes nowhere.
    linkHandler: { activate: (_e, uri) => deck.openExternal(uri), allowNonHttpProtocols: false },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  tab.serialize = new SerializeAddon.SerializeAddon(); // lets the screen travel with the tab to another window
  term.loadAddon(tab.serialize);
  term.loadAddon(new WebLinksAddon.WebLinksAddon((_e, uri) => deck.openExternal(uri)));
  term.loadAddon(new Unicode11Addon.Unicode11Addon());
  term.unicode.activeVersion = '11';
  tab.term = term;
  tab.fit = fit;

  // A program in the terminal can put text on the clipboard (OSC 52). Claude Code and
  // tmux copy this way when they run on a server, where they cannot reach this PC's
  // clipboard directly. Writing only: a program is never given what the clipboard holds.
  term.parser.registerOscHandler(52, (data) => {
    const b64 = data.slice(data.indexOf(';') + 1);
    if (!b64 || b64 === '?' || b64.length > 4e6) return true;
    try {
      const text = new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
      if (text) deck.clipWrite(text);
    } catch {
      // not valid text; nothing to copy
    }
    return true;
  });

  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    const ctrl = e.ctrlKey && !e.altKey;
    // On a Mac copy and paste are Cmd, and Ctrl+C is left to interrupt, as in Terminal.
    const clip = deck.platform === 'darwin' ? e.metaKey && !e.altKey && !e.ctrlKey : ctrl;
    if (clip && e.code === 'KeyC' && (e.shiftKey || term.hasSelection())) {
      e.preventDefault();
      deck.clipWrite(term.getSelection());
      term.clearSelection();
      return false;
    }
    if (clip && e.code === 'KeyV') {
      e.preventDefault();
      // No text on the clipboard usually means an image: let Claude fetch it.
      deck.clipRead().then((text) => (text ? term.paste(text) : deck.write(id, '\x16')));
      return false;
    }
    if (e.key === 'Enter' && e.shiftKey && !ctrl) {
      if (isClaudeTab(tab)) deck.write(id, '\x1b\r'); // newline without sending
      return !isClaudeTab(tab);
    }
    return true;
  });
  // Files dragged in from Explorer are typed in as their paths, the way Windows
  // Terminal does it; Claude Code reads a picture's path as the picture. On a
  // server session a picture is copied there first.
  const carriesFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  tab.pane.addEventListener('dragover', (e) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    tab.pane.classList.add('file-over');
  });
  tab.pane.addEventListener('dragleave', (e) => {
    if (!tab.pane.contains(e.relatedTarget)) tab.pane.classList.remove('file-over');
  });
  tab.pane.addEventListener('drop', async (e) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    tab.pane.classList.remove('file-over');
    if (S.active !== id) activate(id);
    const local = [...e.dataTransfer.files].map((f) => deck.dropPath(f)).filter(Boolean);
    if (!local.length) return toast('That could not be dropped here.', true);
    let paths = local;
    if (tab.server) {
      toast(local.length > 1 ? `Sending ${local.length} files to the server…` : 'Sending to the server…');
      paths = (await Promise.all(local.map((f) => deck.dropToServer(tab.server, f)))).filter(Boolean);
      if (paths.length < local.length) toast('Only pictures can be sent to a server session.', true);
      if (!paths.length) return;
    }
    const quote = (p) => (/[s'"()&]/.test(p) ? (tab.server ? `'${p.replace(/'/g, "'\''")}'` : `"${p}"`) : p);
    term.paste(paths.map(quote).join(' ') + ' ');
    term.focus();
  });
  termEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (term.hasSelection()) {
      deck.clipWrite(term.getSelection());
      term.clearSelection();
    } else deck.clipRead().then((text) => text && term.paste(text));
  });

  S.tabs.set(id, tab);
  S.order.push(id);
  $('#panes').append(tab.pane);
  term.open(termEl);
  setupChat(tab, termEl); // the same session as a chat, one switch away
  touchScroll(tab, termEl);
  try {
    const gl = new WebglAddon.WebglAddon();
    gl.onContextLoss(() => gl.dispose()); // back to the DOM renderer
    term.loadAddon(gl);
  } catch {
    // no GPU context to spare; the DOM renderer is fine
  }

  // Every resize makes Claude repaint its whole screen, so wait for the layout to settle.
  let settle = 0;
  new ResizeObserver(() => {
    clearTimeout(settle);
    settle = setTimeout(() => fitTab(tab), 90);
  }).observe(termEl);

  if (activateIt || !S.active) S.active = id;
  tabsChanged();
  requestAnimationFrame(() => (o.adopt ? adoptTab(tab) : startTab(tab)));
  return tab;
}

function fitTab(tab) {
  if (tab.phoneSize) return; // a phone is watching: its screen decides the size
  if (!tab.pane.isConnected || tab.pane.offsetWidth < 40 || tab.pane.offsetHeight < 40) return;
  try {
    tab.fit.fit();
  } catch {
    // renderer not measured yet
  }
}

// Claude Code is heavy while it starts. Launching a whole team in the same
// instant stalls the PC, so starts are spaced out.
let nextLaunch = 0;

async function startTab(tab) {
  if (isClaudeTab(tab)) {
    const wait = Math.max(0, nextLaunch - Date.now());
    nextLaunch = Math.max(Date.now(), nextLaunch) + 450;
    if (wait) {
      tab.loadingText.textContent = 'Waiting for the sessions ahead of it';
      await new Promise((r) => setTimeout(r, wait));
      if (!S.tabs.has(tab.id)) return;
      tab.loadingText.textContent = 'Starting session';
    }
  }
  fitTab(tab);
  const r = await deck.openPty({
    id: tab.id,
    kind: tab.kind,
    cwd: tab.cwd,
    dir: tab.dir,
    sessionId: tab.sessionId,
    name: tab.name,
    title: tabTitle(tab),
    account: tab.account,
    server: tab.server,
    agent: tab.agent,
    agentAccount: tab.agentAccount,
    agentSession: tab.agentSession,
    memberId: tab.memberId,
    native: tab.native,
    cont: tab.cont,
    cols: tab.term.cols,
    rows: tab.term.rows,
  });
  if (!r.ok) {
    doneLoading(tab);
    tab.exited = true;
    tab.term.write(`\x1b[31mCould not start this terminal.\x1b[0m\r\n${r.error}\r\n`);
    renderTabs();
    return;
  }
  tab.started = true;
  tab.term.onData((d) => deck.write(tab.id, d));
  tab.term.onResize(({ cols, rows }) => deck.resize(tab.id, cols, rows));
  deck.resize(tab.id, tab.term.cols, tab.term.rows);
  if (tab.id === S.active) tab.term.focus();
}

function focusActive() {
  const tab = S.tabs.get(S.active);
  if (tab) tab.term.focus();
}

function activate(id) {
  if (!S.tabs.has(id)) return;
  phoneNav(false);
  S.active = id;
  S.tabs.get(id).attention = false;
  renderTabs();
  renderStatus();
  layoutPanes();
  renderList();
  syncDrawerToActive();
  requestAnimationFrame(() => {
    fitTab(S.tabs.get(id));
    focusActive();
  });
}

// Closing a terminal is not stopping the session. The session carries on in
// Loop with no window on it, and opening it again puts it back on screen with
// everything it printed meanwhile. `stop` ends it instead, and `force` is for
// one that will not end.
async function closeTab(id, how) {
  const leaving = S.tabs.get(id);
  if (leaving && leaving.chat) clearInterval(leaving.chat.timer);
  const tab = S.tabs.get(id);
  if (!tab) return;
  const o = how === true ? { stop: true } : how || {};
  const keep = !o.stop && !tab.exited && !tab.server && isClaudeTab(tab) && tab.sessionId;
  if (keep) {
    S.held.set(tab.sessionId, { id, dir: tab.dir, cwd: tab.cwd, sessionId: tab.sessionId, name: tab.name, account: tab.account, kind: 'resume' });
    deck.hold(id);
  } else {
    S.held.delete(tab.sessionId);
    deck.kill(id, o.force);
  }
  tab.term.dispose();
  tab.pane.remove();
  S.tabs.delete(id);
  S.muted.delete(id);
  const i = S.order.indexOf(id);
  S.order.splice(i, 1);
  if (S.active === id) S.active = S.order[Math.min(i, S.order.length - 1)] || null;
  tabsChanged();
  focusActive();
  setTimeout(() => rescan(false), 1200);
}

// Restart a session under another account, in the same place among the tabs.
async function switchAccount(tab, id) {
  if (tab.account === id || !isClaudeTab(tab)) return;
  const a = accountById(id);
  const known = S.acct.get(id);
  if (known && !known.loggedIn && !known.error) {
    const go = await confirmBox({
      title: `${a.name} is not signed in`,
      body: 'Sign in through your browser first, then switch the session to it.',
      confirm: 'Sign in',
    });
    if (go) signIn(a);
    return;
  }
  const lamp = lampFor(tab.sessionId, tab);
  if (lamp === 'busy' || lamp === 'shell') {
    const ok = await confirmBox({
      title: `"${tabTitle(tab)}" is still working`,
      body: `Switching to ${a.name} restarts the session. The conversation is kept, but the step in progress is lost.`,
      confirm: 'Switch account',
      danger: true,
    });
    if (!ok) return;
  }
  S.config.sessionAccount[tab.sessionId] = id;
  await restartTab(tab, id);
  toast(`Now running as ${a.name}.`);
}

// Close a session's terminal and open it again in the same place among the tabs,
// so a changed account or option takes effect.
async function restartTab(tab, account) {
  const slot = slotOf(tab.id);
  const spec = { kind: 'resume', dir: tab.dir, cwd: tab.cwd, sessionId: tab.sessionId, name: tab.name, account: account || tab.account };
  save();
  await closeTab(tab.id, { stop: true });
  for (let i = 0; i < 30 && S.live.has(spec.sessionId); i++) await new Promise((r) => setTimeout(r, 200));
  await rescan(false);
  // A session that never got a first message has nothing saved to resume.
  const p = projectByDir(spec.dir);
  if (!p || !p.sessions.some((x) => x.id === spec.sessionId)) spec.kind = 'new';
  const made = createTab(spec);
  moveToSlot(made.id, slot);
  tabsChanged();
}

const remoteOn = (sessionId) => Boolean(S.config.sessionRemote[sessionId]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// What is on a terminal's screen right now, one string per row.
function screenRows(tab) {
  const b = tab.term.buffer.active;
  const rows = [];
  for (let y = b.baseY; y < b.baseY + tab.term.rows; y++) rows.push(b.getLine(y) ? b.getLine(y).translateToString().trimEnd() : '');
  return rows;
}

async function slash(tab, command) {
  deck.write(tab.id, command);
  await sleep(450);
  deck.write(tab.id, '\r');
}

async function waitFor(check, ms) {
  for (let t = 0; t < ms; t += 250) {
    if (await check()) return true;
    await sleep(250);
  }
  return false;
}

// The switch on a session's tab. It works on the running session, with no
// restart: on connects it to claude.ai and the phone app; off disconnects it
// and deletes its copy from claude.ai, archive included.
// The Remote Control switch, by session rather than by terminal.
//
// Loop can only work this switch on a session it is running itself: a terminal
// here, or one it runs in the background. A session running in the Claude
// desktop app or another terminal window belongs to that program, and the
// switch inside it is the only one that reaches it - so Loop says so plainly
// instead of storing a wish that nothing acts on.
async function setRemote(p, s, want) {
  const sessionId = s.id;
  const title = sessionTitle(s);
  const tab = tabFor(sessionId);
  if (tab && !tab.exited) {
    if (remoteOn(sessionId) === want) return { ok: true, text: `Remote Control is already ${want ? 'on' : 'off'} for ${title}.` };
    const said = await toggleRemote(tab);
    return { ok: true, text: said || (remoteOn(sessionId) ? 'Remote Control is on.' : 'Remote Control is off.') };
  }
  const lv = S.live.get(sessionId);
  // Running where Loop cannot reach the switch.
  if (lv && !lv.bg) {
    return {
      ok: false,
      text: `${title} is running in ${whereItRuns(lv)}, which owns its Remote Control switch. Turn it on there, or open the session here first and then use this switch.`,
    };
  }
  const set = (on) => {
    if (on) S.config.sessionRemote[sessionId] = true;
    else delete S.config.sessionRemote[sessionId];
    save();
    renderList();
    renderTabs();
  };
  // One of ours with no terminal: it carries the switch at start, so it is
  // started again, connected or not, and the conversation carries on.
  if (lv && lv.bg) {
    if (lv.status !== 'idle') return { ok: false, text: `${title} is working. Use the switch when it is idle.` };
    set(want);
    await deck.directStop(sessionId);
    for (let i = 0; i < 30 && S.live.has(sessionId); i++) await sleep(100);
    const why = await deck.directSend({ dir: p.dir, cwd: p.path, sessionId, text: '', warm: true, account: accountFor(p.dir, sessionId) });
    if (why) return { ok: false, text: `${title} could not be started again: ${why}` };
    if (!want) return { ok: true, text: `Remote Control is off for ${title}, and its copy on claude.ai is deleted.` };
    const on = await waitFor(() => deck.remotePointer({ dir: p.dir, sessionId }), 30000);
    if (!on) {
      set(false);
      return { ok: false, text: `${title} did not connect to Remote Control. Open it here and try the switch on its terminal.` };
    }
    return { ok: true, text: `Remote Control is on for ${title}.` };
  }
  // Not running at all: the switch is kept and acted on the moment Loop starts it.
  set(want);
  return { ok: true, text: want ? `${title} connects to Remote Control as soon as Loop starts it.` : `Remote Control is off for ${title}.` };
}

async function toggleRemote(tab) {
  if (tab.remoteBusy) return;
  const ref = { dir: tab.dir, sessionId: tab.sessionId, server: tab.server };
  const title = tabTitle(tab);
  const turnOn = !remoteOn(tab.sessionId);
  const running = !tab.exited && S.live.has(tab.sessionId);
  const set = (on) => {
    if (on) S.config.sessionRemote[tab.sessionId] = true;
    else delete S.config.sessionRemote[tab.sessionId];
    save();
    renderTabs();
  };
  const say = (text, bad) => (toast(text, bad), text);
  if (!running) {
    set(turnOn);
    return say(turnOn ? `${title} will connect to Remote Control when it starts.` : `Remote Control is off for ${title}.`);
  }
  if (S.live.get(tab.sessionId).status !== 'idle') return say(`${title} is working. Use the switch when it is idle.`, true);

  tab.remoteBusy = true;
  try {
    if (turnOn) {
      set(true);
      await slash(tab, '/remote-control');
      // The first time on a machine, Claude Code asks whether to enable Remote Control at all,
      // with "Enable" already selected. Flipping the switch is that answer.
      let agreed = false;
      const ok = await waitFor(async () => {
        if (!agreed && screenRows(tab).some((r) => /^\s*❯\s*1\.\s*Enable Remote Control/.test(r))) {
          agreed = true;
          deck.write(tab.id, '\r');
          await sleep(1500);
        }
        return deck.remotePointer(ref);
      }, 30000);
      if (!ok) {
        set(false);
        return say(`Remote Control did not connect for ${title}. Look at its terminal for the reason.`, true);
      }
      return say(`Remote Control is on for ${title}.`);
    }

    const id = await deck.remotePointer(ref);
    if (id) {
      // Asking again opens Claude Code's own menu; choose "Disconnect this session" in it.
      await slash(tab, '/remote-control');
      let rows = [];
      const shown = await waitFor(() => (rows = screenRows(tab)).some((r) => /Disconnect this session/.test(r)), 6000);
      if (!shown) {
        deck.write(tab.id, '\x1b');
        return say(`Could not reach the Remote Control menu in ${title}. Disconnect it there with /remote-control, then use the switch again.`, true);
      }
      // The menu's rows run from "Disconnect this session" down to the key hints; the marked one is selected.
      const want = rows.findIndex((r) => /Disconnect this session/.test(r));
      const end = rows.findIndex((r, i) => i > want && /Enter to select/.test(r));
      const at = rows.findIndex((r, i) => i >= want && (end < 0 || i < end) && /^\s*❯/.test(r));
      for (let i = 0; i < at - want; i++) {
        deck.write(tab.id, '\x1b[A');
        await sleep(150);
      }
      deck.write(tab.id, '\r');
      if (!(await waitFor(async () => !(await deck.remotePointer(ref)), 10000))) {
        return say(`${title} did not disconnect. Look at its terminal, then use the switch again.`, true);
      }
    }
    set(false);
    if (!id) return say(`Remote Control is off for ${title}.`);
    const r = await deck.remoteDelete({ id, account: tab.account, server: tab.server });
    if (r.ok) return say(`Remote Control is off for ${title}, and its copy on claude.ai is deleted.`);
    const open = await confirmBox({
      title: `Remote Control is off for ${title}`,
      body: `The session is disconnected, but its copy on claude.ai could not be deleted: ${r.reason}. You can delete it on its page.`,
      confirm: 'Open it on claude.ai',
    });
    if (open && r.link) deck.openExternal(r.link);
  } finally {
    tab.remoteBusy = false;
  }
}

function remoteSwitch(tab) {
  const on = remoteOn(tab.sessionId);
  return h(
    'button.rc',
    {
      class: on ? 'on' : '',
      role: 'switch',
      'aria-checked': String(on),
      title: on
        ? 'Remote Control is on: this session is reachable from claude.ai and the phone app. Click to turn it off.'
        : 'Remote Control is off. Click to make this session reachable from claude.ai and the phone app.',
      onclick: (e) => {
        e.stopPropagation();
        toggleRemote(tab);
      },
    },
    h('i'),
  );
}

function tabsChanged() {
  S.config.lastOpen = S.order
    .map((id) => S.tabs.get(id))
    .filter((t) => isClaudeTab(t) || (t.kind === 'agent' && t.agentSession))
    .map((t) => (t.kind === 'agent' ? { agentSession: t.agentSession } : t.server ? { dir: t.dir, sessionId: t.sessionId, server: t.server, cwd: t.cwd } : { dir: t.dir, sessionId: t.sessionId }));
  save();
  renderTabs();
  layoutPanes();
  renderList();
  renderEmpty();
  renderComposer();
  renderStatus();
}

async function openSession(p, s) {
  phoneNav(false); // on a phone, picking a session shows it
  const existing = tabFor(s.id);
  if (existing) return activate(existing.id);
  // A terminal of ours that is running with no window: take it back, with
  // everything it has printed since.
  const kept = S.held.get(s.id);
  if (kept) {
    S.held.delete(s.id);
    return createTab({ ...kept, adopt: true });
  }
  if (await deck.findTab(s.id)) return;
  // On a server the session lives in tmux: opening it again simply attaches to it.
  if (p.server)
    return (await claudeMissing(serverById(p.server))) ? null : createTab({ kind: 'resume', dir: p.dir, cwd: p.path, sessionId: s.id, server: p.server });
  if (!p.exists) return toast(`The folder for ${projectTitle(p)} was moved or deleted, so this session cannot be reopened.`, true);
  const lv = S.live.get(s.id);
  // One of Loop's own background sessions: it is already ours, so it simply
  // moves into a terminal here. Its runner lets go first, and the conversation
  // carries on from where it is.
  if (lv && lv.bg) {
    await deck.directStop(s.id);
    for (let i = 0; i < 20 && S.live.has(s.id); i++) await new Promise((r) => setTimeout(r, 100));
    return createTab({ kind: 'resume', dir: p.dir, cwd: p.path, sessionId: s.id });
  }
  // Open in the Claude desktop app right now: that is someone's window, so ask.
  // Continuing here moves it, as /desktop moves a session the other way.
  if (lv && lv.entrypoint === 'claude-desktop') {
    const ok = await confirmBox({
      title: `"${sessionTitle(s)}" is open in the Claude app`,
      body: 'Continue in Loop moves it into a terminal here: the Claude app stops its copy, and the conversation carries on from where it is. The Claude app will still list it in its sidebar.',
      confirm: 'Continue in Loop',
    });
    if (!ok) return;
  }
  // Running in another terminal is no reason to ask: it is the same
  // conversation on disk and it is yours. The copy there stops and this one
  // carries on from the file, as it does when you open a session from the phone.
  if (lv) {
    const where = whereItRuns(lv);
    if (!(await deck.closeElsewhere(s.id))) {
      return toast(`Could not stop the copy in ${where}. Close it there yourself, then try again.`, true);
    }
    toast(`Moved here from ${where}.`);
  }
  // If it is running in the background for the phone, that stops first.
  await deck.directStop(s.id);
  if (!lv && s.inApp) toast('Moved here from the Claude app.');
  s.inApp = false;
  createTab({ kind: 'resume', dir: p.dir, cwd: p.path, sessionId: s.id });
}

async function newSession(p) {
  if (!p.exists) return toast('That project folder was moved or deleted.', true);
  if (p.server) {
    const r = await formDialog({
      title: `New session in ${projectTitle(p)} on ${serverById(p.server).name}`,
      body: 'It runs on the server and keeps running there when you close the tab.',
      fields: [{ key: 'name', label: 'Session name', value: '', placeholder: 'Backend developer' }],
      confirm: 'Start session',
    });
    if (r) createTab({ kind: 'new', dir: p.dir, cwd: p.path, sessionId: crypto.randomUUID(), name: r.name.trim(), server: p.server });
    return;
  }
  const v = await formDialog({
    title: `New session in ${projectTitle(p)}`,
    body: 'The name is how other sessions address this one when they send it a message.',
    fields: [
      { key: 'name', label: 'Session name', value: '', placeholder: 'Backend developer' },
      multiAccount()
        ? {
            key: 'account',
            label: 'Claude account',
            type: 'select',
            value: accountFor(p.dir, null),
            options: accountList().map((a) => ({ value: a.id, label: a.name })),
          }
        : null,
      installedAgents().length
        ? {
            key: 'agent',
            label: 'Agent',
            type: 'select',
            value: '',
            options: [{ value: '', label: 'Claude Code' }, ...installedAgents().map((a) => ({ value: a.id, label: `${a.name} (${a.tool})` }))],
          }
        : null,
      S.llms.length
        ? {
            key: 'llm',
            label: 'Model',
            type: 'select',
            value: llmFor(p.dir, null),
            options: [{ value: '', label: 'Claude' }, ...S.llms.map((m) => ({ value: m.id, label: m.name }))],
          }
        : null,
    ].filter(Boolean),
    confirm: 'Start session',
  });
  if (!v) return;
  if (v.agent) return newAgentSession(p, v.agent, v.name.trim());
  const sessionId = crypto.randomUUID();
  if (v.account && v.account !== accountFor(p.dir, null)) {
    S.config.sessionAccount[sessionId] = v.account;
    save();
  }
  if (S.llms.length && v.llm !== llmFor(p.dir, null)) {
    // Claude, picked in a project set to another model, is a choice of its own.
    S.config.sessionLlm[sessionId] = v.llm || 'claude';
    save();
  }
  createTab({ kind: 'new', dir: p.dir, cwd: p.path, sessionId, name: v.name.trim() });
}

function openShell(p) {
  if (!p.exists) return toast('That project folder was moved or deleted.', true);
  createTab({ kind: 'shell', dir: p.dir, cwd: p.path, sessionId: null, server: p.server });
}

async function openPinned(projects) {
  const todo = [];
  let skipped = 0;
  for (const p of projects) {
    if (!p.exists) continue;
    const usable = p.sessions.filter((s) => !isHiddenSession(s) && !s.empty);
    const pinned = usable.filter(isPinned);
    // A whole workspace opens pinned sessions only; a single project falls back to everything.
    const pick = pinned.length ? pinned : projects.length === 1 ? usable : [];
    for (const s of pick) {
      if (tabFor(s.id)) continue;
      if (S.live.has(s.id)) skipped++;
      else todo.push([p, s]);
    }
  }
  if (!todo.length) {
    return toast(
      skipped
        ? 'Those sessions are already running in other windows.'
        : 'Nothing to open. Pin sessions first (right-click a session), then use this to open the set.',
    );
  }
  if (todo.length > 8) {
    const ok = await confirmBox({
      title: `Open ${todo.length} sessions?`,
      body: 'Each one starts its own Claude Code process. Pin the sessions you use as a team to open just those next time.',
      confirm: `Open ${todo.length} sessions`,
    });
    if (!ok) return;
  }
  if (todo.length > 1) setLayout('grid');
  await createTabs(todo.map(([p, s]) => ({ kind: 'resume', dir: p.dir, cwd: p.path, sessionId: s.id })));
  if (skipped) toast(`${skipped} session${skipped === 1 ? ' is' : 's are'} already running elsewhere and were left alone.`);
}

function reopenLast(quiet) {
  const specs = [];
  for (const it of S.config.lastOpen.slice()) {
    if (it.agentSession) {
      const rec = S.config.agentSessions[it.agentSession];
      if (rec && !agentTabFor(rec.id)) openAgentSession(rec, false);
      continue;
    }
    if (it.server) continue; // put back once its server has reported, see restoreFar
    const p = projectByDir(it.dir);
    const s = p && p.sessions.find((x) => x.id === it.sessionId);
    if (!p || !s || !p.exists || tabFor(s.id) || S.live.has(s.id)) continue;
    specs.push({ kind: 'resume', dir: p.dir, cwd: p.path, sessionId: s.id });
  }
  if (!specs.length) {
    if (quiet !== true) toast('Those sessions are already running or no longer exist.');
    return;
  }
  if (S.order.length + specs.length > 1) setLayout('grid');
  createTabs(specs);
}

// ---------- tabs, panes, layout ----------

function setFontSize(size) {
  S.config.settings.fontSize = Math.min(28, Math.max(8, size));
  save();
  for (const tab of S.tabs.values()) {
    tab.term.options.fontSize = S.config.settings.fontSize;
    fitTab(tab);
  }
}

// A phone-sized window: the project list and the session take turns.
const narrow = () => matchMedia('(max-width: 760px)').matches;
function phoneNav(on) {
  document.body.classList.toggle('phone-nav', Boolean(on) && narrow());
}

function toggleSidebar() {
  if (narrow()) return phoneNav(!document.body.classList.contains('phone-nav'));
  S.config.sidebarHidden = !S.config.sidebarHidden;
  save();
  document.body.classList.toggle('no-sidebar', S.config.sidebarHidden);
  renderTools();
}

function renderEmpty() {
  const empty = $('#empty');
  empty.hidden = S.order.length > 0;
  // Nothing open: on a phone, show the list (once, as it empties).
  if (!empty.hidden && !renderEmpty.shown) phoneNav(true);
  renderEmpty.shown = !empty.hidden;
  if (empty.hidden) return;
  const last = S.config.lastOpen.length;
  put(
    empty,
    h(
      'div.empty-card',
      {},
      h('h2', {}, 'Pick a session to open it here'),
      h(
        'p',
        {},
        'Every session opens as a real terminal at its project folder, already resumed. Open several and they can message each other while you watch them side by side.',
      ),
      last ? h('button.btn.primary', { onclick: reopenLast }, icon('play'), `Reopen last ${last === 1 ? 'session' : last + ' sessions'}`) : null,
      h(
        'div.keys',
        {},
        h('span', {}, h('kbd', {}, 'Ctrl'), ' ', h('kbd', {}, 'Tab')),
        h('span', {}, 'Next terminal'),
        h('span', {}, h('kbd', {}, MOD), ' ', h('kbd', {}, 'Shift'), ' ', h('kbd', {}, 'G')),
        h('span', {}, 'Switch between one terminal and the grid'),
        h('span', {}, h('kbd', {}, MOD), ' ', h('kbd', {}, 'Shift'), ' ', h('kbd', {}, 'B')),
        h('span', {}, 'Send one prompt to several sessions'),
        h('span', {}, h('kbd', {}, MOD), ' ', h('kbd', {}, 'Shift'), ' ', h('kbd', {}, 'M')),
        h('span', {}, 'Project memory and knowledge bases'),
        h('span', {}, 'Right-click'),
        h('span', {}, 'Pin, rename, hide or move anything in the list'),
      ),
    ),
  );
}

// The top bar: where things are on the left, finding things in the middle,
// what you can do to the open sessions on the right.
function renderTools() {
  const mode = S.config.layout;
  const tool = (name, glyph, on, run) => h('button.tool', { class: on ? 'on' : '', 'data-tip': name, 'aria-label': name, onclick: run }, icon(glyph));
  const acct = accountById(accountFor(null, null)) || accountById('default');
  const open = S.order.length;
  put(
    $('#titlebar-tools'),
    h(
      'div.bar-side',
      {},
      tool(
        S.config.sidebarHidden ? `Show the project list  ${MOD}+Shift+E` : `Hide the project list  ${MOD}+Shift+E`,
        'panel',
        !S.config.sidebarHidden,
        toggleSidebar,
      ),
      h(
        'div.seg',
        { role: 'group', 'aria-label': 'Arrangement' },
        h('button', { class: mode === 'focus' ? 'on' : '', 'data-tip': `One at a time  ${MOD}+Shift+G`, onclick: () => setLayout('focus') }, icon('single')),
        h('button', { class: mode === 'grid' ? 'on' : '', 'data-tip': `All side by side  ${MOD}+Shift+G`, onclick: () => setLayout('grid') }, icon('grid')),
      ),
    ),
    h(
      'button.jump',
      { onclick: openPalette, 'aria-label': 'Jump to a session, project or action' },
      icon('search'),
      h('span', {}, open ? `Jump to a session, project or action` : 'Find a session to open'),
      h('kbd', {}, `${MOD} K`),
    ),
    h(
      'div.bar-side.end',
      {},
      h(
        'div.tool-group',
        {},
        tool('Teams: sets of sessions that open together', 'team', false, (e) => teamsMenu(e.currentTarget)),
        tool(`Talk to the session in front: it listens and answers out loud  ${MOD}+Shift+V`, 'mic', voiceOn(), toggleVoice),
        tool(`Broadcast one prompt to several sessions  ${MOD}+Shift+B`, 'broadcast', S.composerOpen, toggleComposer),
        tool(`Memory and tasks  ${MOD}+Shift+M`, 'book', S.drawer.open, toggleDrawer),
        S.switches.servers ? tool('Servers: run sessions on another machine', 'server', false, openServers) : null,
        S.switches.phone ? tool('Your phone: work on these sessions from the Loop app', 'phone', PH.info.phones > 0, openPhone) : null,
      ),
      h(
        'button.me',
        { style: `--acct:${acct.color}`, 'data-tip': `Accounts. New sessions use ${acct.name}`, 'aria-label': 'Claude accounts', onclick: openAccounts },
        h('i', {}, acct.name.slice(0, 2)),
        multiAccount() ? h('span', {}, acct.name) : null,
      ),
      tool('Settings', 'gear', false, openSettings),
    ),
  );
}

// ---------- broadcast ----------

// Only sessions Claude reports as running: if Claude has exited, the tab is a bare
// command prompt and a prompt typed into it would run as a command.
const claudeTabs = () => S.order.map((id) => S.tabs.get(id)).filter((t) => isClaudeTab(t) && !t.exited && S.live.has(t.sessionId));

function sendPrompt(tab, text) {
  // Bracketed paste keeps a multi-line prompt in one piece; Enter follows separately.
  deck.write(tab.id, '\x1b[200~' + text.replace(/\r?\n/g, '\r') + '\x1b[201~');
  setTimeout(() => deck.write(tab.id, '\r'), 220);
}

function toggleComposer() {
  S.composerOpen = !S.composerOpen;
  renderTools();
  renderComposer();
  if (S.composerOpen) $('#composer textarea').focus();
  else focusActive();
}

function renderChips() {
  const chips = $('#composer .chips');
  if (!chips) return;
  const tabs = claudeTabs();
  chips.replaceChildren(
    ...(tabs.length
      ? tabs.map((t) =>
          h(
            'button.chip',
            {
              class: S.muted.has(t.id) ? '' : 'on',
              onclick: () => {
                if (S.muted.has(t.id)) S.muted.delete(t.id);
                else S.muted.add(t.id);
                renderChips();
              },
            },
            h('span.lamp', { class: lampFor(t.sessionId, t) }),
            tabTitle(t),
          ),
        )
      : [h('span', {}, 'No running sessions are open here yet. Open some and they appear as recipients.')]),
  );
}

function renderComposer() {
  const box = $('#composer');
  box.hidden = !S.composerOpen;
  if (!S.composerOpen) return;
  if (!box.firstChild) {
    const area = h('textarea', {
      placeholder: `Write a prompt for the selected sessions. ${MOD}+Enter sends it.`,
      onkeydown: (e) => {
        if (e.key === 'Enter' && modKey(e)) broadcast(false);
        if (e.key === 'Escape') toggleComposer();
      },
    });
    box.append(
      h('div.composer-top', {}, h('span', {}, 'Send to'), h('div.chips')),
      h(
        'div.composer-row',
        {},
        area,
        h(
          'div.composer-actions',
          {},
          h('button.btn.primary', { onclick: () => broadcast(false) }, 'Send'),
          h(
            'button.btn.small',
            {
              title: 'Tells each selected session who the others are and how to message them. Anything you typed is added as the shared goal.',
              onclick: () => broadcast(true),
            },
            'Introduce them',
          ),
          h('button.btn.small', { title: 'Presses Esc in each selected session to stop what it is doing', onclick: interruptSelected }, 'Stop them'),
          h('button.btn.small', { title: 'Prompts you send often', onclick: (e) => savedPromptsMenu(e.currentTarget) }, 'Saved'),
        ),
      ),
    );
  }
  renderChips();
}

function broadcast(introduce) {
  const area = $('#composer textarea');
  const text = area.value.trim();
  const targets = claudeTabs().filter((t) => !S.muted.has(t.id));
  if (!targets.length) return toast('Select at least one open session to send to.', true);
  if (!introduce && !text) return toast('Write a prompt first.', true);
  if (introduce && targets.length < 2) return toast('Select two or more sessions to introduce them to each other.', true);
  for (const t of targets) {
    if (!introduce) {
      sendPrompt(t, text);
      continue;
    }
    const peers = targets
      .filter((o) => o !== t)
      .map((o) => {
        const p = projectByDir(o.dir);
        const role = S.config.sessionRole[o.sessionId];
        return `- "${peerName(o)}"${role ? ` (${role})` : ''} works in ${p ? p.path : o.cwd}`;
      });
    sendPrompt(
      t,
      [
        `You are "${peerName(t)}", one member of a team of Claude Code sessions running on this machine. Your teammates:`,
        ...peers,
        "Use the SendMessage tool with a teammate's name to ask them a question, hand work over, or report back. Coordinate directly instead of waiting for me to relay messages.",
        text ? `Shared goal: ${text}` : 'Acknowledge briefly and wait for the first task.',
      ].join('\n'),
    );
  }
  area.value = '';
  toast(`Sent to ${targets.length} session${targets.length === 1 ? '' : 's'}.`);
}

function savedPromptsMenu(anchor) {
  const area = $('#composer textarea');
  const saved = S.config.savedPrompts || [];
  menuAt(anchor, [
    saved.length ? { heading: 'Insert a saved prompt' } : { heading: 'No saved prompts yet' },
    ...saved.map((p) => ({
      label: p.name,
      run: () => {
        area.value = p.text;
        area.focus();
      },
    })),
    '-',
    {
      label: 'Save what I typed',
      icon: 'plus',
      run: async () => {
        const text = area.value.trim();
        if (!text) return toast('Type the prompt first, then save it.');
        const v = await formDialog({
          title: 'Save this prompt',
          fields: [{ key: 'name', label: 'Name', value: '', placeholder: 'Daily standup' }],
          confirm: 'Save prompt',
        });
        if (!v || !v.name.trim()) return;
        S.config.savedPrompts = saved.filter((p) => p.name.toLowerCase() !== v.name.trim().toLowerCase()).concat({ name: v.name.trim().slice(0, 60), text });
        save();
        toast(`Saved as ${v.name.trim()}.`);
      },
    },
    saved.length
      ? {
          label: 'Delete a saved prompt',
          icon: 'trash',
          run: () =>
            menuAt(anchor, [
              { heading: 'Delete which prompt?' },
              ...saved.map((p) => ({
                label: p.name,
                danger: true,
                run: () => {
                  S.config.savedPrompts = S.config.savedPrompts.filter((x) => x !== p);
                  save();
                },
              })),
            ]),
        }
      : null,
  ]);
}

function interruptSelected() {
  const targets = claudeTabs().filter((t) => !S.muted.has(t.id));
  if (!targets.length) return toast('Select at least one running session.', true);
  for (const t of targets) deck.write(t.id, '\x1b');
  toast(`Sent Esc to ${targets.length} session${targets.length === 1 ? '' : 's'}.`);
}

// ---------- status bar ----------

const waitingTabs = () => S.order.filter((id) => S.tabs.get(id).attention);

function nextWaiting() {
  const ids = waitingTabs();
  if (ids.length) activate(ids[0]);
}

const gb = (bytes) => (bytes / 1073741824).toFixed(1);

// ---------- settings ----------

async function openSettings() {
  const s = S.config.settings;
  const v = await formDialog({
    title: 'Settings',
    wide: true,
    fields: [
      {
        key: 'claudeCmd',
        label: 'Claude command',
        value: s.claudeCmd,
        mono: true,
        hint: 'The program that starts Claude Code. Use a full path if claude is not on your PATH.',
      },
      {
        key: 'flags',
        label: 'Options added to every session',
        value: s.flags,
        mono: true,
        hint: 'Applied when a session is opened or created here. Open terminals keep the options they started with.',
      },
      { key: 'fontSize', label: 'Terminal text size', type: 'number', value: s.fontSize },
      { key: 'memoryEnabled', label: 'Give sessions opened here access to project memory', type: 'checkbox', value: s.memoryEnabled !== false },

      {
        key: 'memoryDir',
        label: 'Memory folder',
        type: 'folder',
        value: S.memoryRoot,
        mono: true,
        hint: 'Notes are plain files in this folder. Pick another place and they move there; pick a folder that already holds Loop memory and it is used as it is.',
      },
      { key: 'notify', label: 'Notify me when a session finishes while I am in another window', type: 'checkbox', value: s.notify !== false },
      { key: 'restoreOnStart', label: 'Reopen the sessions from last time when Loop starts', type: 'checkbox', value: Boolean(s.restoreOnStart) },
      { key: 'autoUpdate', label: 'Download Loop updates by themselves (you choose when to restart)', type: 'checkbox', value: s.autoUpdate !== false },
      { key: 'fastGpu', label: 'Draw on the high-performance graphics card (applies after a restart)', type: 'checkbox', value: s.fastGpu !== false },
      {
        key: 'viewDesktop',
        label: 'Open sessions on this PC as',
        type: 'select',
        value: s.viewDesktop || 'terminal',
        options: [
          { value: 'terminal', label: 'A terminal' },
          { value: 'chat', label: 'A chat' },
        ],
      },
      {
        key: 'viewRemote',
        label: 'Open sessions in a browser or on a phone as',
        type: 'select',
        value: s.viewRemote || 'chat',
        options: [
          { value: 'chat', label: 'A chat' },
          { value: 'terminal', label: 'A terminal' },
        ],
      },
      ...(await voiceField()),
    ],
    extra: 'Accessible on the internet…',
  });
  if (v && v.__extra) return openInternet();
  if (!v) return;
  S.config.settings = {
    ...s,
    ...v,
    claudeCmd: String(v.claudeCmd).trim() || 'claude',
    flags: String(v.flags).trim(),
    fontSize: Math.min(28, Math.max(8, Number(v.fontSize) || 13)),
    memoryDir: s.memoryDir,
  };
  save();
  deck.updateAuto(S.config.settings.autoUpdate);
  // A voice is chosen by ear: say one line in the new one straight away.
  if (v.voiceName && v.voiceName !== s.voiceName) hearVoice(v.voiceName);
  const wanted = String(v.memoryDir || '').trim();
  if (wanted && wanted.toLowerCase() !== S.memoryRoot.toLowerCase()) {
    const r = await deck.memSetRoot(wanted);
    toast(r.message, !r.ok);
    S.memoryRoot = r.root;
    if (r.ok) S.config.settings.memoryDir = r.root;
    loadNotes();
  }
  for (const tab of S.tabs.values()) {
    tab.term.options.fontSize = S.config.settings.fontSize;
    fitTab(tab);
  }
  renderStatus();
  renderDrawer();
}

// ---------- memory drawer ----------

function memberLabel(sessionId) {
  const tab = tabFor(sessionId);
  if (tab) return tabTitle(tab);
  for (const p of S.projects) {
    const s = p.sessions.find((x) => x.id === sessionId);
    if (s) return sessionTitle(s);
  }
  return 'Session';
}

function openDrawer(dir, member) {
  S.drawer = { ...S.drawer, open: true, dir, member, scope: member ? member : 'project', query: '' };
  renderTools();
  loadNotes();
}

function toggleDrawer() {
  if (S.drawer.open) {
    S.drawer.open = false;
    renderTools();
    renderDrawer();
    focusActive();
    return;
  }
  const tab = S.tabs.get(S.active);
  const dir = tab ? tab.dir : S.drawer.dir || (visibleProjects()[0] || {}).dir;
  if (!dir) return toast("Open a session first, or choose Project memory from a project's menu.");
  openDrawer(dir, tab && tab.sessionId ? tab.sessionId : null);
}

function syncDrawerToActive() {
  const tab = S.tabs.get(S.active);
  if (!S.drawer.open || !tab) return;
  if (tab.dir === S.drawer.dir && (tab.sessionId || null) === S.drawer.member) return;
  S.drawer.dir = tab.dir;
  S.drawer.member = tab.sessionId || null;
  if (S.drawer.scope !== 'project') S.drawer.scope = S.drawer.member || 'project';
  loadNotes();
}

async function loadNotes() {
  const d = S.drawer;
  if (!d.open || !d.dir) return renderDrawer();
  const ticket = (loadNotes.seq = (loadNotes.seq || 0) + 1);
  if (d.scope === 'bg') {
    const tab = S.tabs.get(S.active);
    const p = projectByDir(d.dir);
    d.bg = d.member ? await deck.bgList({ dir: d.dir, sessionId: d.member, server: (p && p.server) || (tab && tab.server) || '' }) : [];
    if (ticket !== loadNotes.seq) return;
    return renderDrawer();
  }
  if (d.scope === 'tasks') {
    const all = await deck.taskList(d.dir);
    const counts = (await deck.memList({ dir: d.dir, scope: 'project' })).counts;
    if (ticket !== loadNotes.seq) return;
    d.counts = counts;
    const q = d.query.trim().toLowerCase();
    d.tasks = q ? all.filter((t) => `${t.id} ${t.title} ${t.details} ${t.assignee}`.toLowerCase().includes(q)) : all;
    d.taskStats = { open: all.filter((t) => t.status !== 'done').length, done: all.filter((t) => t.status === 'done').length };
    return renderDrawer();
  }
  const r = d.query.trim() ? await deck.memSearch({ dir: d.dir, scope: d.scope, query: d.query }) : await deck.memList({ dir: d.dir, scope: d.scope });
  if (ticket !== loadNotes.seq) return; // a newer request is on its way
  d.notes = r.notes;
  d.stats = r.stats;
  d.counts = r.counts;
  renderDrawer();
}

function renderDrawer() {
  const box = $('#drawer');
  const d = S.drawer;
  box.hidden = !d.open;
  if (!d.open) return;
  if (d.scope !== 'project' && d.scope !== d.member) {
    d.scope = d.member || 'project';
    return loadNotes();
  }
  const p = projectByDir(d.dir);
  const search = h('input', {
    type: 'text',
    placeholder: d.scope === 'tasks' ? 'Filter tasks' : 'Search memory',
    value: d.query,
    oninput: (e) => {
      d.query = e.target.value;
      clearTimeout(renderDrawer.timer);
      renderDrawer.timer = setTimeout(loadNotes, 160);
    },
  });
  const hadFocus = document.activeElement && document.activeElement.closest('#drawer .search');
  const st = d.stats || { notes: 0, tokens: 0 };
  const notesScope = !['tasks', 'bg'].includes(d.scope);
  const tab = d.member ? [...S.tabs.values()].find((t) => t.sessionId === d.member || t.memberId === d.member) : null;
  put(
    box,
    h(
      'div.mem-head',
      {},
      h(
        'div.mem-title',
        {},
        h('span.mem-mark', {}, icon('memory')),
        h('div.grow', {}, h('h2', {}, 'Memory'), h('small', {}, p ? projectTitle(p) : 'Memory', d.member ? ` · ${memberLabel(d.member)}` : '')),
        h('button.mini', { title: 'Close', 'aria-label': 'Close memory', onclick: toggleDrawer }, icon('x')),
      ),
      memTabs(d),
      notesScope
        ? h(
            'div.mem-tools',
            {},
            h('label.search', {}, icon('search'), search),
            h('button.btn.small.primary', { onclick: () => editNote(null) }, icon('plus'), 'Note'),
          )
        : d.scope === 'tasks'
          ? h('div.mem-tools', {}, h('label.search', {}, icon('search'), search), h('button.btn.small.primary', { onclick: () => editTask(null) }, icon('plus'), 'Task'))
          : h('div.mem-tools', {}, h('span.grow.mem-hint', {}, 'What this session left running'), h('button.btn.small', { onclick: loadNotes }, icon('refresh'), 'Refresh')),
      notesScope ? h('p.mem-about', {}, scopeAbout(d)) : null,
    ),
    h(
      'div.drawer-body',
      {},
      d.scope === 'bg'
        ? bgNodes(d)
        : d.scope === 'tasks'
          ? taskNodes(d)
          : d.notes.length
            ? d.notes.map((n) =>
                h(
                  'button.mem-note',
                  { onclick: () => (n.readOnly ? viewNote(n) : editNote(n)) },
                  h('div.mem-note-top', {}, h('b', {}, n.title), h('em', {}, ago(n.updated))),
                  h('p', {}, n.snippet || n.body),
                  (n.tags || []).length ? h('div.mem-tags', {}, n.tags.slice(0, 4).map((t) => h('span', {}, t))) : null,
                ),
              )
            : h(
                'div.mem-empty',
                {},
                h('span.mem-mark.big', {}, icon('memory')),
                h('b', {}, d.query ? 'No matching notes' : 'No notes yet'),
                h(
                  'p',
                  {},
                  d.query
                    ? `Nothing here matches "${d.query}".`
                    : d.scope === 'project'
                      ? 'Sessions in this project save decisions and facts here as they work. Add one yourself, or import what your agents already know.'
                      : d.scope === 'company'
                        ? 'Notes every project can read: policies, brand, how you work.'
                        : 'This session saves what it learns here, whichever agent is working in it.',
                ),
                !d.query && p && !p.server ? h('button.btn.small', { onclick: () => openImport(p) }, icon('import'), 'Import memories') : null,
              ),
    ),
    notesScope ? memStorage(d, p, st) : null,
  );
  if (hadFocus) {
    search.focus();
    search.setSelectionRange(search.value.length, search.value.length);
  }
}

const TASK_WORDS = { todo: 'To do', doing: 'In progress', review: 'Review', blocked: 'Blocked', done: 'Done' };

// What this session left running, as the phone shows it: what is still going
// first, then what has finished, with how long each one took.
function bgNodes(d) {
  const all = d.bg || [];
  if (!all.length) {
    return h('div.side-empty', {}, 'Nothing running in the background. Long commands and agents this session starts show up here.');
  }
  const live = all.filter((t) => t.status === 'running');
  const over = all.filter((t) => t.status !== 'running');
  const said = { done: 'Completed', failed: 'Failed', stopped: 'Stopped' };
  const row = (t) =>
    h(
      'div.bg-task' + (t.status === 'running' ? '.live' : ''),
      { onclick: () => bgOutput(d, t) },
      h('h4', {}, t.name || 'A command'),
      h(
        'div.meta',
        {},
        h('span', {}, t.kind === 'Agent' ? 'Agent' : 'Bash'),
        h('span', { class: t.status === 'failed' ? 'bad' : t.status === 'running' ? 'live' : '' }, said[t.status] || 'Running'),
        h('span.age', {}, bgAge(t)),
      ),
    );
  return [
    live.length ? h('div.side-label', {}, 'Running') : null,
    ...live.map(row),
    over.length ? h('div.side-label', {}, `Finished ${over.length}`) : null,
    ...over.map(row),
  ].filter(Boolean);
}

function bgAge(t) {
  if (!t.started) return '';
  const secs = Math.round(((t.ended || Date.now()) - t.started) / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  return mins < 60 ? `${mins}m ${String(secs % 60).padStart(2, '0')}s` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

// What one of them has printed so far.
async function bgOutput(d, t) {
  const p = projectByDir(d.dir);
  const pre = h('pre.bg-out', {}, 'Reading…');
  const box = h(
    'div.dialog.wide',
    {},
    h('h3', {}, t.name || 'A command'),
    t.note ? h('p.muted', {}, t.note) : null,
    pre,
    h('div.dialog-actions', {}, h('button.btn', { onclick: closeOverlay }, 'Close')),
  );
  closeOverlay();
  const scrim = h('div.scrim.dim', { onmousedown: (e) => e.target === scrim && closeOverlay() }, box);
  document.querySelector('#overlay').append(scrim);
  const out = await deck.bgOut({ dir: d.dir, sessionId: d.member, server: (p && p.server) || '', task: t.id });
  pre.textContent = ((out && out.text) || '').trim() || 'Nothing printed yet.';
  pre.scrollTop = pre.scrollHeight;
}

function taskNodes(d) {
  const tasks = d.tasks || [];
  if (!tasks.length) {
    return h(
      'div.side-empty',
      {},
      d.query ? `No task matches "${d.query}".` : 'The board is empty. Add a task, or ask a session to plan the work and put it on the board.',
    );
  }
  return tasks.map((t) => {
    const last = t.notes[t.notes.length - 1];
    return h(
      'div.note.task',
      { class: t.status, onclick: () => editTask(t) },
      h('h4', {}, h('span', {}, `${t.id}  ${t.title}`), h('em', {}, ago(t.updated))),
      t.details ? h('p', {}, t.details) : null,
      last ? h('p', {}, `${last.by || 'Note'}: ${last.text}`) : null,
      h('div.meta', {}, h('b.status', {}, TASK_WORDS[t.status]), h('span', {}, t.assignee ? `assigned to ${t.assignee}` : 'unassigned')),
    );
  });
}

async function editTask(task) {
  const d = S.drawer;
  const v = await formDialog({
    title: task ? `Task ${task.id}` : 'New task',
    wide: true,
    fields: [
      { key: 'title', label: 'Task', value: task ? task.title : '', placeholder: 'Add rate limiting to the public API' },
      { key: 'assignee', label: 'Assigned to (a session name, or leave empty)', value: task ? task.assignee : '', placeholder: 'Backend developer' },
      {
        key: 'status',
        label: 'Status',
        type: 'select',
        value: task ? task.status : 'todo',
        options: Object.entries(TASK_WORDS).map(([value, label]) => ({ value, label })),
      },
      { key: 'details', label: 'Details', type: 'textarea', value: task ? task.details : '' },
    ],
    confirm: task ? 'Save task' : 'Add task',
    extra: task ? 'Delete task' : null,
  });
  if (!v) return;
  if (v.__extra) await deck.taskRemove(d.dir, task.id);
  else if (task) await deck.taskUpdate(d.dir, task.id, { title: v.title, assignee: v.assignee, status: v.status, details: v.details });
  else if (String(v.title).trim()) {
    const made = await deck.taskAdd(d.dir, { title: v.title, assignee: v.assignee, details: v.details });
    if (v.status !== 'todo') await deck.taskUpdate(d.dir, made.id, { status: v.status });
  }
  loadNotes();
}

async function editNote(note) {
  const d = S.drawer;
  const v = await formDialog({
    title: note ? 'Edit note' : d.scope === 'project' ? 'New project note' : d.scope === 'company' ? 'New company note' : `New note for ${memberLabel(d.member)}`,
    wide: true,
    fields: [
      { key: 'title', label: 'Title', value: note ? note.title : '', placeholder: 'Deploy goes through the staging box first' },
      { key: 'tags', label: 'Tags, separated by commas', value: note ? (note.tags || []).join(', ') : '', placeholder: 'deploy, staging' },
      { key: 'body', label: 'Note', type: 'textarea', value: note ? note.body : '' },
    ],
    confirm: 'Save note',
    extra: note ? 'Delete note' : null,
  });
  if (!v) return;
  const scope = note ? note.scope : d.scope === 'claude' ? 'project' : d.scope;
  if (v.__extra) await deck.memDelete({ dir: d.dir, id: note.id });
  else if (String(v.title).trim() || String(v.body).trim()) {
    await deck.memSave({
      dir: d.dir,
      scope,
      id: note ? note.id : undefined,
      title: String(v.title).trim() || 'Untitled note',
      body: v.body || '',
      tags: String(v.tags || '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
      author: 'you',
    });
  }
  loadNotes();
}

async function viewNote(note) {
  const v = await formDialog({
    title: note.title,
    body: 'Claude Code saved this on its own, so it stays read-only here. Copy it into project memory to edit it or share it with every session.',
    wide: true,
    fields: [{ key: 'body', label: 'Note', type: 'textarea', value: note.body }],
    confirm: 'Copy to project memory',
  });
  if (!v) return;
  await deck.memSave({ dir: S.drawer.dir, scope: 'project', title: note.title, body: v.body, tags: note.tags || [], author: 'you' });
  S.drawer.scope = 'project';
  loadNotes();
}

// ---------- wiring ----------

function renderAll() {
  renderTools();
  renderRail();
  renderSidebarHead();
  renderList();
  renderTabs();
  layoutPanes();
  renderEmpty();
  renderComposer();
  renderStatus();
  renderDrawer();
}

async function rescan(announce) {
  S.local = await deck.scan();
  const dirs = S.local.filter((p) => !p.server && p.exists).map((p) => p.dir);
  if (S.knownDirs) {
    const fresh = dirs.find((d) => !S.knownDirs.has(d));
    if (fresh && S.cloud && S.cloud.signedIn) setTimeout(() => cloudBringOffer(true, fresh).catch(() => {}), 1200);
  } else if (S.cloud && S.cloud.signedIn) setTimeout(() => cloudBringOffer(true).catch(() => {}), 4000); // once at start
  S.knownDirs = new Set(dirs);
  mergeProjects();
  renderRail();
  renderList();
  renderTabs();
  if (announce) toast('Session list refreshed.');
}

function onLive(list) {
  const before = S.live;
  S.live = new Map(list.map((l) => [l.sessionId, l]));
  for (const tab of S.tabs.values()) {
    if (!tab.sessionId) continue;
    const was = before.get(tab.sessionId);
    const now = S.live.get(tab.sessionId);
    if (was && was.status !== 'idle' && now && now.status === 'idle' && (tab.id !== S.active || !document.hasFocus())) {
      tab.attention = true;
      notifyDone(tab);
    }
  }
  renderRail();
  renderList();
  renderTabs();
  renderChips();
  renderStatus();
  // An open chat on the phone hears the change now, not at its next look.
  phoneLookSoon();
}

window.addEventListener(
  'keydown',
  (e) => {
    if (e.altKey && !e.ctrlKey && /^Digit[1-9]$/.test(e.code) && S.order[Number(e.code.slice(5)) - 1]) {
      e.preventDefault();
      e.stopPropagation();
      activate(S.order[Number(e.code.slice(5)) - 1]);
      return;
    }
    if (e.altKey) return;
    let handled = true;
    if (e.key === 'Tab' && e.ctrlKey && S.order.length) {
      const i = S.order.indexOf(S.active);
      activate(S.order[(i + (e.shiftKey ? -1 : 1) + S.order.length) % S.order.length]);
    } else if (!modKey(e)) return;
    else if (e.shiftKey && e.code === 'KeyG') setLayout(S.config.layout === 'grid' ? 'focus' : 'grid');
    else if (e.shiftKey && e.code === 'KeyV') toggleVoice();
    else if (e.shiftKey && e.code === 'KeyB') toggleComposer();
    else if (e.shiftKey && e.code === 'KeyM') toggleDrawer();
    else if (e.shiftKey && e.code === 'KeyW' && S.active) closeTab(S.active);
    else if (e.shiftKey && e.code === 'KeyF') $('#search').focus();
    else if (!e.shiftKey && e.code === 'KeyK') openPalette();
    else if (e.shiftKey && e.code === 'KeyE') toggleSidebar();
    else if (e.shiftKey && e.code === 'KeyN') nextWaiting();
    else if (!e.shiftKey && (e.code === 'Equal' || e.code === 'NumpadAdd')) setFontSize(S.config.settings.fontSize + 1);
    else if (!e.shiftKey && (e.code === 'Minus' || e.code === 'NumpadSubtract')) setFontSize(S.config.settings.fontSize - 1);
    else if (!e.shiftKey && e.code === 'Digit0') setFontSize(13);
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  },
  true,
);

window.addEventListener('focus', () => {
  const tab = S.tabs.get(S.active);
  if (tab && tab.attention) {
    tab.attention = false;
    renderTabs();
    renderStatus();
  }
});

(async function init() {
  const loading = deck.load();

  // What follows calls into layout.js, servers.js and the files after them, which
  // load after this one. A fast answer above (an extra window gets one) used to beat them.
  if (document.readyState === 'loading') await new Promise((r) => document.addEventListener('DOMContentLoaded', r, { once: true }));

  const state = await loading;
  S.config = state.config;
  S.switches = state.switches || {};
  S.local = state.projects;
  S.projects = state.projects;
  S.colors = state.colors;
  S.winBuild = state.winBuild;
  S.winId = state.winId;
  S.child = state.child;
  S.remote = Boolean(state.remote); // this window is a browser elsewhere
  document.body.classList.toggle('remote', S.remote);
  document.body.classList.toggle('child', S.child);
  document.body.classList.toggle('mac', deck.platform === 'darwin');
  if (S.child) S.config.layout = 'focus';
  S.memoryRoot = state.memoryRoot;
  S.live = new Map(state.live.map((l) => [l.sessionId, l]));
  S.config.sessionRole = S.config.sessionRole || {};
  S.config.teams = S.config.teams || [];
  S.config.accounts = S.config.accounts || [];
  S.config.mainAccount = S.config.mainAccount || { name: 'Main', color: S.colors[0] };
  S.config.projectAccount = S.config.projectAccount || {};
  S.config.sessionAccount = S.config.sessionAccount || {};
  S.config.sessionLlm = S.config.sessionLlm || {};
  S.config.projectLlm = S.config.projectLlm || {};
  S.llms = await deck.llmList();
  S.config.agentSessions = S.config.agentSessions || {};
  S.agents = [];
  refreshAgents();
  setTimeout(() => memoryMoveOffer().catch(() => {}), 4000);
  S.config.sessionRemote = S.config.sessionRemote || {};
  S.config.servers = S.config.servers || [];
  S.config.projectTeam = S.config.projectTeam || {};
  S.config.roles = S.config.roles || [];
  const aw = String(S.config.activeWorkspace);
  if (aw !== 'all' && aw !== 'none' && !wsById(aw) && !(aw.startsWith('srv:') && serverById(aw.slice(4)))) S.config.activeWorkspace = 'all';

  deck.onData((id, data) => {
    const tab = S.tabs.get(id);
    if (tab) queueOutput(tab, data);
  });
  deck.onExit((id) => {
    const tab = S.tabs.get(id);
    if (!tab) return;
    tab.exited = true;
    const shut = () => {
      if (!S.tabs.has(id) || !tab.exited) return;
      queueOutput(tab, '\r\n\x1b[90mThis terminal has closed.\x1b[0m\r\n');
      renderTabs();
      renderChips();
    };
    // A session on a server may only have lost its connection: try to put it back first.
    if (tab.server) farTabClosed(tab).then((back) => back || shut(), shut);
    else shut();
    renderTabs();
  });
  deck.onLive(onLive);
  // Another window changed a setting, an account or a switch: take it, but keep what is this window's own.
  deck.onConfig((next) => {
    const mine = ['lastOpen', 'layout', 'activeWorkspace', 'collapsed', 'sidebarHidden'];
    S.config = { ...next, ...Object.fromEntries(mine.map((k) => [k, S.config[k]])) };
    renderAll();
  });
  wireWindows();
  wireServers();
  wireCloud();
  wireInternet();
  wireLimits();
  if (!S.remote) wireUpdates();
  if (!S.remote) wireTools();
  wireBoard();
  wirePhone();
  deck.trashList().then((t) => {
    S.trash = t;
    if (t.length) renderList();
  });
  deck.onStats((u) => {
    S.stats = u;
    renderUsage();
  });
  refreshAccounts();

  document.body.classList.toggle('no-sidebar', Boolean(S.config.sidebarHidden));
  renderAll();
  if (state.memoryWarning) toast(state.memoryWarning, true);
  for (const spec of state.adopt || []) createTab({ ...spec, adopt: true });
  // After an update Loop opens what was open, whatever the setting says.
  const updated = Boolean(S.config.reopenAfterUpdate);
  if (updated) {
    S.config.reopenAfterUpdate = false;
    save();
  }
  if (!S.child && !S.remote && (S.config.settings.restoreOnStart || updated) && S.config.lastOpen.length) {
    S.bootOpen = S.config.lastOpen.filter((it) => it.server);
    reopenLast(true);
  }
  setInterval(() => document.hidden || rescan(false), 30000); // nobody is looking while it is hidden
})();


// ---------- the memory sidebar's parts ----------

function memTabs(d) {
  const c = (d.counts && d.counts.byScope) || {};
  const tabs = [
    d.member ? { key: d.member, label: 'Session', n: c[d.member], tip: `${memberLabel(d.member)}'s own memory. Every agent working in this session uses it.` } : null,
    { key: 'project', label: 'Project', n: c.project, tip: 'Shared by every session in this project' },
  ].filter(Boolean);
  return h(
    'div.mem-tabs',
    { role: 'tablist' },
    tabs.map((t) =>
      h(
        'button.mem-tab',
        {
          class: d.scope === t.key ? 'on' : '',
          role: 'tab',
          'aria-selected': String(d.scope === t.key),
          title: t.tip,
          onclick: () => {
            d.scope = t.key;
            d.query = '';
            loadNotes();
          },
        },
        t.label,
        t.n ? h('span.mem-n', {}, String(t.n)) : null,
      ),
    ),
  );
}

function scopeAbout(d) {
  if (d.scope === 'project') return 'Shared by every session in this project.';
  return `Only this session's, whichever agent works in it: Claude, ChatGPT, Gemini or another.`;
}

const shortPath = (p) => {
  const parts = String(p || '').split(/[\\/]/).filter(Boolean);
  return parts.length > 4 ? `${parts[0]}\\…\\${parts.slice(-3).join('\\')}` : String(p || '');
};

// Where this memory is kept, and what can be done with it.
function memStorage(d, p, st) {
  const folder = h('small.mono', { title: d.folder || S.memoryRoot }, shortPath(d.folder || S.memoryRoot));
  if (!d.folder || d.folderFor !== `${d.dir}|${d.scope}`) {
    d.folderFor = `${d.dir}|${d.scope}`;
    deck.memFolder({ dir: d.dir, scope: d.scope }).then((f) => {
      if (d.folderFor !== `${d.dir}|${d.scope}`) return;
      d.folder = f;
      folder.textContent = shortPath(f);
      folder.title = f;
    });
  }
  const what = d.scope === 'project' ? projectTitle(p || { name: 'project' }) : memberLabel(d.member);
  return h(
    'div.mem-store',
    {},
    h('div.mem-store-label', {}, h('span', {}, 'Storage'), h('span', {}, `${st.notes} note${st.notes === 1 ? '' : 's'} · ~${st.tokens} tokens`)),
    h(
      'div.mem-store-row',
      {},
      h('span.mem-store-ic', {}, icon('folder')),
      h('div.grow', {}, h('b', {}, 'On this PC'), folder),
      h('button.btn.small', { title: 'Open this folder', onclick: () => deck.memOpen({ dir: d.dir, scope: d.scope }) }, 'Open'),
    ),
    cloudRow(d, p),
    cloudBringBanner(d, p),
    h(
      'div.mem-store-actions',
      {},
      h(
        'button.btn.small',
        {
          onclick: (e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const go = async (scope, name) => {
              const res = await deck.memExport({ dir: d.dir, scope, name });
              if (res.ok) toast(`Exported to ${res.file}`);
              else if (!res.canceled) toast(res.text, true);
            };
            menu(r.left, r.top - 8, [
              { heading: 'Export as a zip' },
              d.member ? { label: `This session: ${memberLabel(d.member)}`, icon: 'person', run: () => go(d.member, memberLabel(d.member)) } : null,
              p ? { label: `This project: ${projectTitle(p)}`, icon: 'folder', run: () => go('project', projectTitle(p)) } : null,
              { label: 'All memory', icon: 'memory', run: () => go('all', 'all') },
            ]);
          },
        },
        icon('export'),
        'Export',
      ),
      p && !p.server ? h('button.btn.small', { onclick: () => openImport(p) }, icon('import'), 'Import') : null,
      h('span.grow'),
      h('span.mem-scope-note', {}, what),
    ),
  );
}
