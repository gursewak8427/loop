/* global deck, S, h, $, put, icon, menu, closeMenu, ago, save, toast, gb */
/* global accountById, accountFor, accountLine, accountList, openAccounts, tabAccountMenu, isClaudeTab, tabFor, sessionTitle, waitingTabs, nextWaiting */
/* global llmFor, llmName, brandIcon, PROVIDERS, toggleDrawer, openInternet, confirmBox */
// The status bar: a row of items that can be dragged into any order, on the
// left or the right, hidden or shown again, and right-clicked for more.
//
// Plan limits sit here too: a ring for the session limit and one for the week
// (one, when a plan has only a monthly limit), each with its percentage beside
// it. A dot on the ring marks where an even pace would be by now. Hover for a
// line, click for the details.

// ---------- the items ----------

const BAR_DEFAULT = {
  left: ['account', 'working', 'idle', 'elsewhere', 'ready'],
  right: ['update', 'limits', 'cloud', 'cpu', 'ram', 'gpu'],
  hidden: [],
};

function liveCounts() {
  const all = [...S.live.values()];
  const working = all.filter((l) => l.status !== 'idle');
  const idle = all.filter((l) => l.status === 'idle');
  const elsewhere = all.filter((l) => !tabFor(l.sessionId) && !l.bg);
  return { all, working, idle, elsewhere };
}

// A session's name from its id, for the lists behind a right-click.
function nameOfSession(id) {
  for (const p of S.projects || []) {
    const s = (p.sessions || []).find((x) => x.id === id);
    if (s) return sessionTitle(s);
  }
  return 'A session in another window';
}
const listOf = (lives) => {
  const names = lives.map((l) => nameOfSession(l.sessionId));
  return names.length ? names.slice(0, 8).map((n) => ({ info: ['', n] })).concat(names.length > 8 ? [{ info: ['', `and ${names.length - 8} more`] }] : []) : [{ info: ['', 'None'] }];
};

const frontAccount = () => {
  const front = S.tabs.get(S.active);
  return accountById(front && front.kind !== 'login' ? front.account : accountFor(null, null)) || accountById('default');
};

const meterTone = (pct) => (pct >= 90 ? 'hot' : pct >= 75 ? 'warm' : '');

const BAR_ITEMS = {
  account: {
    name: 'Account',
    render() {
      const front = S.tabs.get(S.active);
      const a = frontAccount();
      return h(
        'button.sb-btn.sb-who',
        {
          style: `--acct:${a.color}`,
          title: front && isClaudeTab(front) ? 'The account this session runs as. Click to switch it.' : 'The account new sessions use. Click to manage accounts.',
          onclick: (e) => {
            const r = e.currentTarget.getBoundingClientRect();
            if (front && isClaudeTab(front)) tabAccountMenu(front)(r.left, r.top - 8 - 34 * (accountList().length + 3));
            else openAccounts();
          },
        },
        h('span.dot'),
        h('b', {}, a.name),
        h('span.sb-dim', {}, accountLine(a.id)),
      );
    },
    info() {
      const a = frontAccount();
      return [{ info: ['Account', a.name] }, { info: ['Sign-in', accountLine(a.id)] }, { info: ['Accounts on this PC', String(accountList().length)] }];
    },
  },
  working: {
    name: 'Working sessions',
    render: () => h('span.sb-stat', {}, h('span.lamp.busy'), `${liveCounts().working.length} working`),
    info: () => [{ heading: 'Working now' }, ...listOf(liveCounts().working)],
  },
  idle: {
    name: 'Idle sessions',
    render: () => h('span.sb-stat', {}, h('span.lamp.idle'), `${liveCounts().idle.length} idle`),
    info: () => [{ heading: 'Waiting for you' }, ...listOf(liveCounts().idle)],
  },
  elsewhere: {
    name: 'Sessions in other windows',
    render() {
      const n = liveCounts().elsewhere.length;
      return n ? h('span.sb-stat', { title: 'Running in other terminal windows or the Claude desktop app' }, h('span.lamp'), `${n} in other windows`) : null;
    },
    info: () => [{ heading: 'Open in other windows' }, ...listOf(liveCounts().elsewhere)],
  },
  ready: {
    name: 'Ready for you',
    render() {
      const n = waitingTabs().length;
      return n ? h('button.sb-btn.sb-ready', { title: `Sessions that finished while you were elsewhere. Click for the next one (${MOD}+Shift+N).`, onclick: nextWaiting }, `${n} ready for you`) : null;
    },
    info: () => [{ info: ['Finished while you were away', String(waitingTabs().length)] }, { info: ['Next one', `${MOD}+Shift+N`] }],
  },
  update: {
    name: 'Loop updates',
    render() {
      const u = S.update;
      if (S.remote || !u || !u.can) return null;
      if (u.status === 'downloading') return h('span.sb-stat.sb-update', { title: `Loop ${u.next} is downloading. You choose when to restart.` }, icon('download'), `Getting Loop ${u.next}: ${u.percent}%`);
      if (u.status === 'available') return h('button.sb-btn.sb-update', { title: `Loop ${u.next} is out. Click to download it.`, onclick: getUpdate }, icon('download'), `Update to ${u.next}`);
      if (u.status === 'ready') return h('button.sb-btn.sb-update.ready', { title: `Loop ${u.next} is ready. Loop restarts and opens your sessions again.`, onclick: restartToUpdate }, icon('refresh'), 'Restart to update');
      return null;
    },
    info() {
      const u = S.update || {};
      return [
        { info: ['This version', u.version || ''] },
        u.next && u.status !== 'none' ? { info: ['New version', u.next] } : null,
        { info: ['Status', updateWords(u)] },
        u.checked ? { info: ['Last checked', `${ago(u.checked)} ago`] } : null,
      ];
    },
  },
  limits: {
    name: 'Plan limits',
    render: () => limitsItem(),
    info: () => limitsInfo(),
  },
  cloud: {
    name: 'Memory sync',
    render() {
      const c = S.cloud;
      if (!c || !c.signedIn) return null;
      const working = { backup: 'Syncing memory…', restore: 'Restoring memory…', bring: 'Bringing memory in…', link: 'Linking memory…' }[c.busy];
      const allLocal = c.defaultMode === 'local' && !Object.values(c.projects || {}).some((m) => m !== 'local');
      const text = working || (c.error ? 'Memory: needs a look' : allLocal ? 'Memory on this PC' : 'Memory synced');
      const when = c.lastSync ? `Last synced ${ago(c.lastSync) === 'now' ? 'just now' : `${ago(c.lastSync)} ago`}` : 'Not synced yet';
      return h('button.sb-btn.sb-cloud', { class: c.error && !working ? 'err' : '', title: c.error || `${when}, to Loop Cloud (${c.email}). Click for the memory panel.`, onclick: () => toggleDrawer() }, icon('cloud'), text);
    },
    info() {
      const c = S.cloud || {};
      if (!c.signedIn) return [{ info: ['Loop Cloud', 'Not signed in'] }];
      return [
        { info: ['Signed in as', c.email] },
        { info: ['New projects', { local: 'This PC only', backup: 'Backed up', linked: 'Linked' }[c.defaultMode] || 'Backed up'] },
        { info: ['Linked here', String(Object.values(c.projects || {}).filter((m) => m === 'linked').length)] },
        c.lastSync ? { info: ['Last in step', `${ago(c.lastSync)} ago`] } : null,
        c.lastBackup ? { info: ['Restorable copy', `${ago(c.lastBackup)} ago`] } : null,
        c.quota ? { info: ['Space', `${(c.used / 1048576).toFixed(1)} MB of ${Math.round(c.quota / 1073741824)} GB`] } : null,
        c.error ? { info: ['Problem', c.error] } : null,
      ];
    },
  },
  cpu: {
    name: 'Processor',
    render: () => (S.stats ? h('span.sb-meter', { class: meterTone(S.stats.cpu) }, h('i', {}, 'CPU'), h('span', { 'data-live': 'cpu' }, `${S.stats.cpu}%`)) : null),
    info: () => (S.stats ? [{ info: ['Whole PC', `${S.stats.cpu}%`] }, { info: ['Loop itself', `${S.stats.appCpu}%`] }, { info: ['Sessions', 'separate programs, counted in the PC total'] }] : []),
  },
  ram: {
    name: 'Memory (RAM)',
    render() {
      const u = S.stats;
      if (!u) return null;
      return h('span.sb-meter', { class: meterTone((100 * u.memUsed) / u.memTotal) }, h('i', {}, 'RAM'), h('span', { 'data-live': 'ram' }, `${gb(u.memUsed)} / ${gb(u.memTotal)} GB`));
    },
    info() {
      const u = S.stats;
      return u ? [{ info: ['In use', `${gb(u.memUsed)} of ${gb(u.memTotal)} GB (${Math.round((100 * u.memUsed) / u.memTotal)}%)`] }, { info: ['Loop itself', `${gb(u.appMem)} GB`] }] : [];
    },
  },
  gpu: {
    name: 'Graphics card',
    render: () => (S.stats && S.stats.gpu ? h('span.sb-meter', { class: meterTone(S.stats.gpu.load) }, h('i', {}, 'GPU'), h('span', { 'data-live': 'gpu' }, `${S.stats.gpu.load}%`)) : null),
    info: () => (S.stats && S.stats.gpu ? [{ info: ['Load', `${S.stats.gpu.load}%`] }, { info: ['Graphics memory', `${S.stats.gpu.used} of ${S.stats.gpu.total} MB`] }] : [{ info: ['Graphics card', 'No NVIDIA card found'] }]),
  },
};

function barLayout() {
  const c = S.config.statusBar || {};
  const known = Object.keys(BAR_ITEMS);
  const left = (c.left || BAR_DEFAULT.left).filter((id) => known.includes(id));
  const right = (c.right || BAR_DEFAULT.right).filter((id) => known.includes(id) && !left.includes(id));
  // Items added in a later version join on their usual side.
  for (const id of known) if (!left.includes(id) && !right.includes(id)) (BAR_DEFAULT.left.includes(id) ? left : right).push(id);
  return { left, right, hidden: (c.hidden || []).filter((id) => known.includes(id)) };
}

function setBarLayout(next) {
  S.config.statusBar = next;
  save();
  renderStatus();
}

// ---------- drawing ----------

let dragId = null;

function renderStatus() {
  const bar = $('#statusbar');
  if (!bar) return;
  const L = barLayout();
  const zone = (side, ids) =>
    h(
      'div.sb-zone',
      { class: side, 'data-side': side, ondragover: (e) => dragOver(e, side), ondragleave: (e) => !e.currentTarget.contains(e.relatedTarget) && dropMark(null), ondrop: (e) => drop(e, side) },
      ids.filter((id) => !L.hidden.includes(id)).map(itemEl),
    );
  put(bar, zone('left', L.left), zone('right', L.right));
  bar.oncontextmenu = (e) => {
    if (e.target.closest('.sb-item')) return;
    e.preventDefault();
    barMenu(e.clientX, e.clientY);
  };
  loadLimits(false);
}

function itemEl(id) {
  const content = BAR_ITEMS[id].render();
  if (!content) return null;
  return h(
    'div.sb-item',
    {
      'data-id': id,
      draggable: true,
      ondragstart: (e) => {
        dragId = id;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', id);
        e.currentTarget.classList.add('dragging');
        $('#statusbar').classList.add('arranging');
      },
      ondragend: (e) => {
        dragId = null;
        e.currentTarget.classList.remove('dragging');
        $('#statusbar').classList.remove('arranging');
        dropMark(null);
      },
      oncontextmenu: (e) => {
        e.preventDefault();
        itemMenu(id, e.clientX, e.clientY);
      },
    },
    content,
  );
}

// The PC meters change every few seconds: only their numbers are redrawn, so a
// drag in progress or an open menu is not disturbed.
function renderUsage() {
  const u = S.stats;
  const bar = $('#statusbar');
  if (!u || !bar) return;
  const has = (id) => bar.querySelector(`.sb-item[data-id="${id}"]`);
  const L = barLayout();
  const want = ['cpu', 'ram', 'gpu'].filter((id) => !L.hidden.includes(id) && (id !== 'gpu' || u.gpu));
  if (want.some((id) => !has(id))) {
    if (!dragId) renderStatus();
    return;
  }
  const set = (id, text, pct) => {
    const item = has(id);
    const meter = item && item.querySelector('.sb-meter');
    const span = item && item.querySelector(`[data-live="${id}"]`);
    if (span) span.textContent = text;
    if (meter) meter.className = `sb-meter ${meterTone(pct)}`;
  };
  set('cpu', `${u.cpu}%`, u.cpu);
  set('ram', `${gb(u.memUsed)} / ${gb(u.memTotal)} GB`, (100 * u.memUsed) / u.memTotal);
  if (u.gpu) set('gpu', `${u.gpu.load}%`, u.gpu.load);
}

// ---------- dragging ----------

// Where a drop would land: before the first item whose middle is right of the pointer.
function dropSpot(zoneEl, x) {
  const items = [...zoneEl.querySelectorAll('.sb-item:not(.dragging)')];
  const before = items.find((el) => {
    const r = el.getBoundingClientRect();
    return x < r.left + r.width / 2;
  });
  return { before, items };
}

function dropMark(zoneEl, before) {
  document.querySelectorAll('.sb-drop').forEach((m) => m.remove());
  if (!zoneEl) return;
  const mark = h('span.sb-drop');
  if (before) zoneEl.insertBefore(mark, before);
  else zoneEl.append(mark);
}

function dragOver(e, side) {
  if (!dragId) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const zoneEl = e.currentTarget;
  const { before } = dropSpot(zoneEl, e.clientX);
  const now = document.querySelector('.sb-drop');
  if (now && now.parentNode === zoneEl && now.nextSibling === (before || null)) return;
  dropMark(zoneEl, before);
  void side;
}

function drop(e, side) {
  if (!dragId) return;
  e.preventDefault();
  const { before } = dropSpot(e.currentTarget, e.clientX);
  const L = barLayout();
  const left = L.left.filter((id) => id !== dragId);
  const right = L.right.filter((id) => id !== dragId);
  const list = side === 'left' ? left : right;
  const at = before ? list.indexOf(before.dataset.id) : -1;
  if (at < 0) list.push(dragId);
  else list.splice(at, 0, dragId);
  dropMark(null);
  dragId = null;
  setBarLayout({ left, right, hidden: L.hidden });
}

// ---------- right-click ----------

function itemMenu(id, x, y) {
  const it = BAR_ITEMS[id];
  const L = barLayout();
  const onLeft = L.left.includes(id);
  menu(x, y - 8, [
    { heading: it.name },
    ...(it.info() || []).filter(Boolean),
    '-',
    {
      label: `Move to the ${onLeft ? 'right' : 'left'}`,
      icon: onLeft ? 'export' : 'import',
      run: () =>
        setBarLayout({
          left: onLeft ? L.left.filter((x2) => x2 !== id) : [...L.left, id],
          right: onLeft ? [id, ...L.right] : L.right.filter((x2) => x2 !== id),
          hidden: L.hidden,
        }),
    },
    { label: 'Hide from the bar', icon: 'eye', run: () => setBarLayout({ ...L, hidden: [...L.hidden, id] }) },
    '-',
    { label: 'Choose what the bar shows…', icon: 'gear', run: () => barMenu(x, y) },
  ]);
}

function barMenu(x, y) {
  const L = barLayout();
  menu(x, y - 8, [
    { heading: 'Status bar: drag items to move them' },
    ...Object.entries(BAR_ITEMS).map(([id, it]) => ({
      label: it.name,
      checked: !L.hidden.includes(id),
      run: () => {
        const hidden = L.hidden.includes(id) ? L.hidden.filter((x2) => x2 !== id) : [...L.hidden, id];
        setBarLayout({ ...L, hidden });
        barMenu(x, y);
      },
    })),
    '-',
    { label: 'Put everything back as it was', icon: 'refresh', run: () => setBarLayout({ ...BAR_DEFAULT }) },
  ]);
}

// ---------- plan limits ----------

const LIMIT_TTL = 60e3;

// Which agent and account the session in front runs as. { apiKey } for a
// session on an API key, which has no plan limit; null when there is nothing to show.
function limitTarget() {
  const front = S.tabs.get(S.active);
  if (front && front.kind === 'agent') return { agent: front.agent, account: front.agentAccount || 'default' };
  if (front && isClaudeTab(front)) {
    const llm = llmFor(front.dir, front.sessionId);
    if (llm) return { apiKey: llmName(llm) };
    return { agent: 'claude', account: front.account || accountFor(front.dir, front.sessionId) };
  }
  if (front) return null;
  return { agent: 'claude', account: accountFor(null, null) };
}

const clock = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const dayClock = (ms) => (new Date(ms).toDateString() === new Date().toDateString() ? clock(ms) : new Date(ms).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }));
function inWords(ms) {
  const m = Math.max(0, Math.round(ms / 60e3));
  if (m < 60) return `${m} min`;
  const hrs = Math.floor(m / 60);
  if (hrs < 48) return m % 60 && hrs < 10 ? `${hrs} h ${m % 60} min` : `${hrs} h`;
  return `${Math.round(hrs / 24)} days`;
}
const LONG_NAME = { '5h': '5-hour session limit', week: 'Weekly limit', month: 'Monthly limit' };
const longName = (w) => LONG_NAME[w.label] || `${w.label} limit`;

// Where an even pace would be by now, and where this pace ends up.
function paceOf(w, now = Date.now()) {
  if (!w.length || !w.resetsAt) return null;
  const start = w.resetsAt - w.length;
  const frac = Math.min(1, Math.max(0, (now - start) / w.length));
  const even = Math.round(frac * 100);
  if (frac < 0.04 || w.used < 1) return { even, projected: null, runsOut: 0 };
  const projected = Math.round(w.used / frac);
  const runsOut = projected > 100 ? start + (now - start) * (100 / w.used) : 0;
  return { even, projected, runsOut };
}

function limitTone(w) {
  const p = paceOf(w);
  if (w.used >= 90 || (p && p.runsOut && p.runsOut < w.resetsAt)) return 'hot';
  if (w.used >= 75 || (p && p.projected && w.used > p.even + 10)) return 'warm';
  return 'calm';
}

function paceLine(w) {
  const p = paceOf(w);
  if (!p || p.projected == null) return w.resetsAt ? 'Too early in this window to read the pace.' : '';
  if (p.runsOut && p.runsOut < w.resetsAt) return `At this pace it runs out around ${dayClock(p.runsOut)}, before it resets.`;
  return `At this pace about ${Math.min(100, p.projected)}% by the reset; an even pace would be ${p.even}% by now.`;
}

// The windows the bar shows: the session one and the long one, never more than two.
const shownWindows = (d) => d.windows.filter((w) => !/ week$/.test(w.label) || w.label === 'week').slice(0, 2);

// A ring: the fill is what is used. Its colour says how the pace is going; on the
// big rings in the card, a faint arc shows where an even pace would be by now.
function ring(w, size) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  const c = size / 2;
  const r = c - (size > 20 ? 3.5 : 1.8);
  const len = 2 * Math.PI * r;
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('class', `ring ${w ? limitTone(w) : 'none'}`);
  const circle = (cls, extra) => {
    const el = document.createElementNS(ns, 'circle');
    el.setAttribute('cx', c);
    el.setAttribute('cy', c);
    el.setAttribute('r', r);
    el.setAttribute('class', cls);
    for (const [k, v] of Object.entries(extra || {})) el.setAttribute(k, v);
    return el;
  };
  svg.append(circle('ring-track'));
  const arc = (pct) => ({ 'stroke-dasharray': `${(len * Math.min(100, pct)) / 100} ${len}`, transform: `rotate(-90 ${c} ${c})` });
  // On the big rings, a faint arc behind the fill shows how far an even pace would have got.
  const p = w && size > 20 && paceOf(w);
  if (p && p.even > 0) svg.append(circle('ring-even', arc(p.even)));
  if (w && w.used > 0) svg.append(circle('ring-fill', arc(Math.max(w.used, 3))));
  return svg;
}

async function loadLimits(force) {
  const t = limitTarget();
  const key = t ? (t.apiKey ? `key|${t.apiKey}` : `${t.agent}|${t.account}`) : '';
  S.limits = S.limits || { key: '', at: 0, data: null };
  if (!t || t.apiKey) {
    if (S.limits.key !== key) S.limits = { key, at: Date.now(), data: null };
    return renderLimits();
  }
  if (!force && S.limits.key === key && Date.now() - S.limits.at < LIMIT_TTL) return renderLimits();
  const changed = S.limits.key !== key;
  S.limits = { key, at: Date.now(), data: changed ? null : S.limits.data, loading: true };
  if (changed) renderLimits();
  const data = await deck.limits(t).catch(() => null);
  if (S.limits.key !== key) return; // the front session changed meanwhile
  S.limits = { key, at: Date.now(), data };
  renderLimits();
}

// Redraws only the limits item, where it is on the bar.
function renderLimits() {
  const slot = document.querySelector('#statusbar .sb-item[data-id="limits"]');
  const fresh = limitsItem();
  if (slot) {
    if (fresh) put(slot, fresh);
    else slot.remove();
  } else if (fresh && !barLayout().hidden.includes('limits') && !dragId) renderStatus();
  const card = document.querySelector('.lim-card');
  if (card) put(card, ...limitsCardBody());
}

function limitsItem() {
  const t = limitTarget();
  if (!t) return null;
  if (t.apiKey) return h('span.sb-limits.none', { title: `This session runs on ${t.apiKey} with an API key: billed per use, so there is no plan limit to show.` }, icon('key'), 'API key');
  const d = S.limits && S.limits.data;
  if (!d || !d.windows || !d.windows.length) {
    if (S.limits && S.limits.loading) return h('span.sb-limits.none', { title: 'Reading the plan limits…' }, ring(null, 15), '…');
    if (!d || !d.error || /No limits/.test(d.error)) return null;
    const why = d.error === 'expired' ? 'This account’s sign-in renews itself the next time one of its sessions works; the limits show then.' : `Could not read the plan limits: ${d.error}`;
    return h('button.sb-btn.sb-limits.none', { title: why, onclick: (e) => openLimitsCard(e.currentTarget) }, ring(null, 15), '—');
  }
  const shown = shownWindows(d);
  return h(
    'button.sb-btn.sb-limits',
    {
      class: d.stale ? 'stale' : '',
      title: shown.map((w) => `${longName(w)}: ${w.used}% used${w.resetsAt ? `, resets in ${inWords(w.resetsAt - Date.now())}` : ''}`).join('\n') + '\nClick for details',
      onclick: (e) => openLimitsCard(e.currentTarget),
    },
    shown.map((w) => h('span.lim', { class: limitTone(w) }, ring(w, 15), h('span', {}, `${w.used}%`))),
  );
}

function limitsInfo() {
  const t = limitTarget();
  const d = S.limits && S.limits.data;
  if (!t) return [{ info: ['Plan limits', 'Nothing to show for this tab'] }];
  if (t.apiKey) return [{ info: ['This session', `${t.apiKey}, API key`] }, { info: ['Plan limit', 'none: billed per use'] }];
  if (!d || !d.windows) return [{ info: ['Plan limits', d && d.error === 'expired' ? 'show once the sign-in renews' : 'not read yet'] }];
  return d.windows.map((w) => ({ info: [longName(w), `${w.used}% used${w.resetsAt ? ` · resets ${dayClock(w.resetsAt)}` : ''}`] }));
}

// ---------- the details card ----------

function limitsCardBody() {
  const t = limitTarget();
  const d = S.limits && S.limits.data;
  const tool = !t || t.apiKey ? '' : t.agent === 'claude' ? 'Claude' : (PROVIDERS.find((p) => p.key === t.agent) || { name: t.agent }).name;
  const who = t && t.agent === 'claude' ? accountById(t.account) : null;
  const head = h(
    'div.lim-card-head',
    {},
    t && !t.apiKey ? brandIcon(t.agent) : icon('key'),
    h('div', {}, h('b', {}, t && t.apiKey ? t.apiKey : `${tool}${who ? ` · ${who.name}` : ''}`), h('small', {}, [d && d.plan ? `${d.plan[0].toUpperCase()}${d.plan.slice(1)} plan` : t && t.apiKey ? 'API key' : 'Plan limits', d && d.email ? `signed in as ${d.email}` : ''].filter(Boolean).join(' · '))),
  );
  if (!d || !d.windows || !d.windows.length) {
    const text = t && t.apiKey ? 'Billed per use: there is no plan limit.' : d && d.error === 'expired' ? 'This account’s sign-in renews itself the next time one of its sessions works; the limits show then.' : 'The limits are being read.';
    return [head, h('p.lim-card-empty', {}, text)];
  }
  const rows = d.windows.map((w) =>
    h(
      'div.lim-row',
      { class: limitTone(w) },
      h('div.lim-ring', {}, ring(w, 44), h('b', {}, `${w.used}%`)),
      h(
        'div.lim-text',
        {},
        h('b', {}, longName(w)),
        h('span', {}, `${100 - w.used}% left${w.resetsAt ? ` · resets in ${inWords(w.resetsAt - Date.now())}, ${dayClock(w.resetsAt)}` : ''}`),
        h('small', {}, paceLine(w)),
      ),
    ),
  );
  const foot = h(
    'div.lim-card-foot',
    {},
    h('small', {}, d.stale ? `From ${ago(d.at)} ago, while the sign-in renews` : `Read ${ago(d.at) === 'now' ? 'just now' : `${ago(d.at)} ago`}`),
    h('small', {}, 'The faint arc: an even pace'),
    h('button.btn.small', { onclick: () => loadLimits(true) }, 'Refresh'),
  );
  return [head, ...rows, foot];
}

function openLimitsCard(anchor) {
  closeMenu();
  const card = h('div.lim-card', { role: 'dialog', 'aria-label': 'Plan limits' }, ...limitsCardBody());
  const scrim = h('div.scrim.menu-scrim', { onmousedown: (e) => e.target === scrim && closeMenu() });
  $('#overlay').append(scrim, card);
  const r = anchor.getBoundingClientRect();
  const w = card.getBoundingClientRect();
  card.style.left = `${Math.max(8, Math.min(r.left + r.width / 2 - w.width / 2, innerWidth - w.width - 8))}px`;
  card.style.top = `${Math.max(8, r.top - w.height - 8)}px`;
}

// ---------- updates ----------
// The work is in src/main/updater.js: it checks GitHub every few hours and
// downloads a new version in the background. The bar shows it coming, then a
// button that restarts Loop into it.

function updateWords(u) {
  if (!u.can) return u.why || 'Not available';
  return (
    {
      checking: 'Checking…',
      none: 'Up to date',
      available: `Loop ${u.next} is out`,
      downloading: `Downloading ${u.percent}%`,
      ready: `Loop ${u.next} is ready to install`,
      error: u.error,
    }[u.status] || 'Up to date'
  );
}

function wireUpdates() {
  const take = (u) => {
    const was = S.update && S.update.status;
    S.update = u;
    renderStatus();
    if (u.status === 'ready' && was && was !== 'ready') toast(`Loop ${u.next} is ready. Click Restart to update in the status bar when it suits you.`);
  };
  deck.onUpdate(take);
  deck.updateState().then(take);
}

async function getUpdate() {
  const u = await deck.updateDownload();
  if (u.status === 'error') toast(u.error, true);
}

// One click. If sessions are working it asks first, since a restart stops the
// step they are on; either way they open again once the new version starts.
async function restartToUpdate() {
  const u = S.update;
  if (!u || u.status !== 'ready') return;
  const working = liveCounts().working.filter((l) => tabFor(l.sessionId)).length;
  if (working) {
    const ok = await confirmBox({
      title: `Restart Loop to update to ${u.next}?`,
      body: `${working} session${working === 1 ? ' is' : 's are'} working right now. Restarting stops the step ${working === 1 ? 'it is' : 'they are'} on; the conversation is kept, and every open session comes back when Loop opens again. Or leave it: the update goes in the next time you quit Loop.`,
      confirm: 'Restart now',
    });
    if (!ok) return;
  }
  S.config.reopenAfterUpdate = S.config.lastOpen.length > 0;
  save();
  if (!(await deck.updateInstall())) toast('The update could not start. Quit Loop and it goes in then.', true);
}

async function checkForUpdates() {
  let u = S.update || (await deck.updateState());
  if (!u.can) {
    toast(u.why);
    if (/download/i.test(u.why)) deck.updatePage();
    return;
  }
  if (u.status === 'ready') return restartToUpdate();
  if (u.status === 'downloading') return toast(`Loop ${u.next} is downloading: ${u.percent}%.`);
  u = await deck.updateCheck();
  if (u.status === 'none') toast(`You have the newest Loop, ${u.version}.`);
  else if (u.status === 'downloading') toast(`Loop ${u.next} is out. It is downloading; the status bar shows when it is ready.`);
  else if (u.status === 'available') getUpdate();
  else if (u.status === 'error') toast(u.error, true);
}

function wireLimits() {
  setInterval(() => loadLimits(false), LIMIT_TTL);
}
