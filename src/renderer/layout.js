/* global serverChip, stopOnServer */
/* global deck, S, h, icon, put, menu, save, toast, $, SerializeAddon */
/* global projectByDir, projectTitle, tabTitle, lampFor, wsColor, STATUS_WORDS, isClaudeTab, multiAccount, accountById, accountChip, tabAccountMenu, accountMenu */
/* global switchAccount, remoteSwitch, openDrawer, createTab, closeTab, activate, focusActive, renderTools, tabsChanged, queueOutput */
'use strict';

// Terminals live in groups. A group is a strip of tabs with one of them showing;
// groups sit side by side or one above the other, nested as deep as you like.
// Drag a tab onto a group's edge to split it, onto its middle or its strip to
// move it there, or out of the window to give it a window of its own.

const L = { root: null, focus: null, seq: 0, sig: '', gridOf: '' };
const TAB_MIME = 'application/x-deck-tab';

function newGroup(tabs = []) {
  return { type: 'group', id: 'g' + ++L.seq, tabs, active: tabs[0] || null };
}

function groups(node = L.root, out = []) {
  if (!node) return out;
  if (node.type === 'group') out.push(node);
  else for (const k of node.kids) groups(k, out);
  return out;
}

const groupOf = (id) => groups().find((g) => g.tabs.includes(id));
const focusedGroup = () => groups().find((g) => g.id === L.focus) || groups()[0];
const flatTabs = () => groups().flatMap((g) => g.tabs);

// Drop empty groups, unwrap splits left with one side, and merge a split nested
// in a split of the same direction, keeping every pane the size it had.
function tidy(node, isRoot) {
  if (node.type === 'group') return node.tabs.length || isRoot ? node : null;
  const kids = [];
  const sizes = [];
  node.kids.forEach((k, i) => {
    const t = tidy(k, false);
    if (!t) return;
    if (t.type === 'split' && t.dir === node.dir) {
      const total = t.sizes.reduce((a, b) => a + b, 0);
      t.kids.forEach((kk, j) => {
        kids.push(kk);
        sizes.push((node.sizes[i] * t.sizes[j]) / total);
      });
    } else {
      kids.push(t);
      sizes.push(node.sizes[i]);
    }
  });
  if (!kids.length) return isRoot ? newGroup() : null;
  if (kids.length === 1) return kids[0];
  node.kids = kids;
  node.sizes = sizes;
  node.el = null;
  return node;
}

function gridTree(ids) {
  const n = ids.length;
  const cols = n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4;
  const rows = [];
  for (let i = 0; i < n; i += cols) {
    const cells = ids.slice(i, i + cols).map((id) => newGroup([id]));
    rows.push(cells.length === 1 ? cells[0] : { type: 'split', dir: 'row', kids: cells, sizes: cells.map(() => 1) });
  }
  return rows.length === 1 ? rows[0] : { type: 'split', dir: 'col', kids: rows, sizes: rows.map(() => 1) };
}

// Bring the tree in line with the tabs that exist and the chosen arrangement.
function reconcile() {
  if (!L.root) L.root = newGroup();
  const live = S.order.filter((id) => S.tabs.has(id));
  const mode = S.config.layout;
  if (mode === 'grid') {
    if (L.gridOf !== live.join()) {
      L.root = live.length ? gridTree(live) : newGroup();
      L.gridOf = live.join();
    }
  } else {
    L.gridOf = '';
    for (const g of groups()) g.tabs = g.tabs.filter((id) => S.tabs.has(id));
    if (mode !== 'custom') {
      const keep = groups()[0];
      keep.tabs = flatTabs();
      L.root = keep;
    }
    const known = new Set(flatTabs());
    for (const id of live) if (!known.has(id)) focusedGroup().tabs.push(id);
    L.root = tidy(L.root, true);
  }
  const front = S.active && groupOf(S.active);
  if (front) {
    front.active = S.active;
    L.focus = front.id;
  }
  for (const g of groups()) if (!g.tabs.includes(g.active)) g.active = g.tabs[g.tabs.length - 1] || null;
  if (!front) {
    const g = focusedGroup();
    L.focus = g.id;
    S.active = g.active;
  }
  S.order = flatTabs();
}

const signature = (node) => (node.type === 'group' ? `${node.id}[${node.tabs.join()}]` : `${node.dir}(${node.kids.map(signature).join('|')})`);

function gutter(node, i) {
  return h('div.gutter', {
    title: 'Drag to resize. Double-click to make both sides equal.',
    ondblclick: () => {
      const half = (node.sizes[i - 1] + node.sizes[i]) / 2;
      node.sizes[i - 1] = node.sizes[i] = half;
      for (const k of [i - 1, i]) node.kids[k].el.style.flex = `${half} 1 0px`;
    },
    onmousedown: (e) => {
      e.preventDefault();
      const a = node.kids[i - 1].el;
      const b = node.kids[i].el;
      const across = node.dir === 'row';
      const size = (el) => (across ? el.offsetWidth : el.offsetHeight);
      const total = size(a) + size(b);
      const sum = node.sizes[i - 1] + node.sizes[i];
      const start = across ? e.clientX : e.clientY;
      const from = size(a);
      document.body.classList.add('resizing', across ? 'across' : 'down');
      const move = (ev) => {
        const px = Math.min(total - 90, Math.max(90, from + (across ? ev.clientX : ev.clientY) - start));
        node.sizes[i - 1] = (sum * px) / total;
        node.sizes[i] = sum - node.sizes[i - 1];
        a.style.flex = `${node.sizes[i - 1]} 1 0px`;
        b.style.flex = `${node.sizes[i]} 1 0px`;
        clearControls();
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        document.body.classList.remove('resizing', 'across', 'down');
        if (S.config.layout !== 'custom') {
          S.config.layout = 'custom'; // you sized it by hand; keep it that way
          save();
          renderTools();
        }
        focusActive();
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up, { once: true });
    },
  });
}

function build(node) {
  if (node.type === 'group') {
    if (!node.el) {
      node.strip = h('div.tabs', { role: 'tablist' });
      node.body = h('div.group-body');
      node.catcher = h('div.drop-catch');
      node.el = h('div.group', {}, node.strip, node.body);
      wireDrops(node);
    }
    node.body.replaceChildren(...node.tabs.map((id) => S.tabs.get(id).pane), node.catcher);
    return node.el;
  }
  const el = h('div.split', { class: node.dir });
  node.kids.forEach((k, i) => {
    if (i) el.append(gutter(node, i));
    const child = build(k);
    child.style.flex = `${node.sizes[i]} 1 0px`;
    el.append(child);
  });
  node.el = el;
  return el;
}

function layoutPanes() {
  reconcile();
  const sig = signature(L.root);
  if (sig !== L.sig) {
    L.sig = sig;
    const root = build(L.root);
    root.style.flex = '1 1 0px';
    $('#panes').replaceChildren(root);
    requestAnimationFrame(focusActive); // moving a terminal in the page drops its focus
  }
  const many = groups().length > 1;
  for (const g of groups()) {
    g.el.classList.toggle('focus', many && g.id === L.focus);
    for (const id of g.tabs) S.tabs.get(id).pane.classList.toggle('on', id === g.active);
  }
  renderTabs();
  clearControls();
}

// In an extra window the minimise, maximise and close buttons sit over the top
// right corner (top left on a Mac), so the strip that reaches that corner keeps clear of them.
function clearControls() {
  if (!S.child) return;

  const mac = deck.platform === 'darwin';

  for (const g of groups()) {
    if (!g.strip) continue;
    const r = g.el.getBoundingClientRect();
    g.strip.style.paddingRight = !mac && r.top < 4 && r.right > innerWidth - 4 ? '146px' : '';
    g.strip.style.paddingLeft = mac && r.top < 4 && r.left < 4 ? '76px' : '';
  }
}
window.addEventListener('resize', clearControls);

function setLayout(layout) {
  S.config.layout = layout;
  L.gridOf = '';
  save();
  renderTools();
  layoutPanes();
  requestAnimationFrame(focusActive);
}

// ---------- tab strips ----------

function tabNode(g, id) {
  const tab = S.tabs.get(id);
  const lamp = lampFor(tab.sessionId, tab);
  const p = projectByDir(tab.dir);
  return h(
    'div.tab',
    {
      class: [id === g.active ? 'on' : '', id === S.active ? 'front' : '', tab.attention ? 'attention' : ''].join(' '),
      style: `--ws-color:${wsColor(p)}`,
      role: 'tab',
      draggable: true,
      'data-tab': id,
      ondragstart: (e) => {
        e.dataTransfer.setData(TAB_MIME, JSON.stringify({ id, win: S.winId }));
        e.dataTransfer.effectAllowed = 'move';
        document.body.classList.add('dragging-tab');
      },
      ondragend: (e) => {
        document.body.classList.remove('dragging-tab');
        hideHint();
        renderTabs();
        // Let go outside every Loop window: it gets a window of its own.
        const outside =
          e.screenX < window.screenX ||
          e.screenX > window.screenX + window.outerWidth ||
          e.screenY < window.screenY ||
          e.screenY > window.screenY + window.outerHeight;
        if (!S.remote && e.dataTransfer.dropEffect === 'none' && outside && S.tabs.has(id)) popOut([id], e.screenX, e.screenY);
      },
      title: `${tabTitle(tab)}\n${p ? projectTitle(p) : ''}\n${isClaudeTab(tab) ? STATUS_WORDS[lamp] : 'Terminal'}${multiAccount() ? '\nAccount: ' + accountById(tab.account).name : ''}\n\nDrag to reorder${S.remote ? ' or to split' : ', to split, or out of the window'}`,
      onclick: () => activate(id),
      onauxclick: (e) => e.button === 1 && closeTab(id),
      oncontextmenu: (e) => {
        e.preventDefault();
        const alone = g.tabs.length < 2;
        menu(e.clientX, e.clientY, [
          { label: 'Close, keep it working', icon: 'x', run: () => closeTab(id) },
          {
            label: 'Close the others',
            icon: 'x',
            run: async () => {
              for (const x of S.order.filter((o) => o !== id)) await closeTab(x);
            },
          },
          isClaudeTab(tab)
            ? {
                label: 'Stop this session',
                icon: 'x',
                danger: true,
                title: 'Ends it. The conversation is saved and can be opened again.',
                run: () => closeTab(id, { stop: true }),
              }
            : null,
          isClaudeTab(tab)
            ? {
                label: 'Force stop',
                icon: 'x',
                danger: true,
                title: 'For one that will not end: the whole thing goes at once.',
                run: () => closeTab(id, { stop: true, force: true }),
              }
            : null,
          '-',
          alone ? null : { label: 'Split to the right', icon: 'grid', run: () => place(id, g, 'right') },
          alone ? null : { label: 'Split below', icon: 'grid', run: () => place(id, g, 'bottom') },
          // Extra windows are the PC's own; a browser has just its one page.
          S.remote ? null : { label: 'Move to a new window', icon: 'single', run: () => popOut([id]) },
          tab.server && tab.sessionId ? '-' : null,
          tab.server && tab.sessionId ? { label: 'Stop it on the server', icon: 'x', danger: true, run: () => stopOnServer(tab) } : null,
          tab.sessionId && !tab.server ? '-' : null,
          tab.sessionId && !tab.server
            ? {
                label: `Switch account (now ${accountById(tab.account).name})`,
                icon: 'person',
                run: () => accountMenu(e.clientX, e.clientY, `Run ${tabTitle(tab)} as`, tab.account, null, (pick) => switchAccount(tab, pick)),
              }
            : null,
          tab.sessionId ? { label: 'Knowledge base', icon: 'book', run: () => openDrawer(tab.dir, tab.sessionId) } : null,
          tab.sessionId ? { label: 'Copy session ID', icon: 'copy', run: () => deck.clipWrite(tab.sessionId) } : null,
        ]);
      },
    },
    isClaudeTab(tab) ? h('span.lamp', { class: lamp }) : tab.agent ? brandIcon(tab.agent) : icon(tab.kind === 'login' ? 'person' : 'terminal'),
    h('span.title', {}, tabTitle(tab)),
    tab.server
      ? serverChip(tab.server)
      : multiAccount() && tab.kind !== 'login'
        ? accountChip(tab.account, false, isClaudeTab(tab) ? tabAccountMenu(tab) : null)
        : null,
    !tab.server && isClaudeTab(tab) && llmFor(tab.dir, tab.sessionId) ? llmChip(llmFor(tab.dir, tab.sessionId)) : null,
    isClaudeTab(tab) && (tab.server || !llmFor(tab.dir, tab.sessionId)) ? remoteSwitch(tab) : null,
    h(
      'button.x',
      {
        title: 'Close',
        onclick: (e) => {
          e.stopPropagation();
          closeTab(id);
        },
      },
      icon('x'),
    ),
  );
}

function renderTabs() {
  if (!L.root) return;
  if (document.body.classList.contains('dragging-tab')) return; // redrawing the strip would cancel the drag
  for (const g of groups()) {
    if (!g.strip) continue;
    put(
      g.strip,
      g.tabs.filter((id) => S.tabs.has(id)).map((id) => tabNode(g, id)),
      // An extra window has no title bar: the empty part of a strip is what you drag it by.
      S.child ? h('div.strip-grip') : null,
    );
    for (const id of g.tabs.filter((x) => S.tabs.has(x))) S.tabs.get(id).pane.style.setProperty('--ws-color', wsColor(projectByDir(S.tabs.get(id).dir)));
  }
}

// ---------- moving tabs ----------

function replaceNode(old, next, node = L.root) {
  if (node === old) {
    L.root = next;
    return true;
  }
  if (node.type !== 'split') return false;
  const i = node.kids.indexOf(old);
  if (i >= 0) {
    node.kids[i] = next;
    node.el = null;
    return true;
  }
  return node.kids.some((k) => replaceNode(old, next, k));
}

// Put a tab in a group (zone 'center' or 'strip', optionally at an index) or
// beside it (zone 'left', 'right', 'top', 'bottom').
function place(id, target, zone, index) {
  const from = groupOf(id);
  const beside = zone !== 'center' && zone !== 'strip';
  if (beside && from === target && target.tabs.length === 1) return;
  if (!beside && from === target && index === undefined) return;
  if (from) {
    const at = from.tabs.indexOf(id);
    from.tabs.splice(at, 1);
    if (from === target && index !== undefined && at < index) index--;
  }
  if (!beside) {
    target.tabs.splice(index === undefined ? target.tabs.length : index, 0, id);
    target.active = id;
  } else {
    const made = newGroup([id]);
    const before = zone === 'left' || zone === 'top';
    replaceNode(target, {
      type: 'split',
      dir: zone === 'left' || zone === 'right' ? 'row' : 'col',
      kids: before ? [made, target] : [target, made],
      sizes: [1, 1],
    });
  }
  if (beside || from !== target) S.config.layout = 'custom';
  L.root = tidy(L.root, true);
  L.gridOf = '';
  S.order = flatTabs();
  S.active = id;
  renderTools();
  tabsChanged();
  activate(id);
}

// Where a tab sits, so its replacement can take the same place.
function slotOf(id) {
  const g = groupOf(id);
  return g ? { group: g.id, index: g.tabs.indexOf(id) } : null;
}

function moveToSlot(id, slot) {
  const g = slot && groups().find((x) => x.id === slot.group);
  const from = groupOf(id);
  if (!g || !from) return;
  from.tabs.splice(from.tabs.indexOf(id), 1);
  g.tabs.splice(Math.min(slot.index, g.tabs.length), 0, id);
  g.active = id;
  L.root = tidy(L.root, true);
  S.order = flatTabs();
}

// ---------- drop targets and the snapping preview ----------

let hint = null;

function showHint(rect) {
  if (!hint) hint = h('div.drop-hint');
  const stage = $('#stage');
  const fresh = hint.parentNode !== stage;
  if (fresh) stage.append(hint);
  hint.classList.toggle('fresh', fresh); // appear in place; only glide between zones
  const base = stage.getBoundingClientRect();
  hint.style.cssText = `left:${rect.left - base.left}px;top:${rect.top - base.top}px;width:${rect.width}px;height:${rect.height}px`;
}

function hideHint() {
  if (hint) hint.remove();
}

const carriesTab = (e) => [...e.dataTransfer.types].includes(TAB_MIME);

// Which part of a group the pointer is over: an edge snaps to half, the middle joins the group.
function zoneAt(e, box) {
  const x = (e.clientX - box.left) / box.width;
  const y = (e.clientY - box.top) / box.height;
  const edge = 0.26;
  const near = [
    ['left', x],
    ['right', 1 - x],
    ['top', y],
    ['bottom', 1 - y],
  ].sort((a, b) => a[1] - b[1])[0];
  return near[1] < edge ? near[0] : 'center';
}

function zoneRect(zone, box) {
  const r = { left: box.left, top: box.top, width: box.width, height: box.height };
  if (zone === 'left' || zone === 'right') r.width = box.width / 2;
  if (zone === 'top' || zone === 'bottom') r.height = box.height / 2;
  if (zone === 'right') r.left += box.width / 2;
  if (zone === 'bottom') r.top += box.height / 2;
  return r;
}

async function takeDrop(e, g, zone, index) {
  e.preventDefault();
  document.body.classList.remove('dragging-tab');
  hideHint();
  let data;
  try {
    data = JSON.parse(e.dataTransfer.getData(TAB_MIME));
  } catch {
    return;
  }
  if (!S.tabs.has(data.id)) {
    // It comes from another Loop window: take it over, terminal and all.
    const spec = await deck.claimTab(data.id);
    if (!spec) return toast('That terminal could not be moved here.', true);
    createTab({ ...spec, adopt: true });
  }
  place(data.id, g, zone, index);
}

function wireDrops(g) {
  g.strip.addEventListener('dragover', (e) => {
    if (!carriesTab(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const tabs = [...g.strip.querySelectorAll('.tab')];
    const i = tabs.findIndex((t) => e.clientX < t.getBoundingClientRect().left + t.offsetWidth / 2);
    const strip = g.strip.getBoundingClientRect();
    const at = i < 0 ? (tabs.length ? tabs[tabs.length - 1].getBoundingClientRect().right : strip.left + 8) : tabs[i].getBoundingClientRect().left;
    showHint({ left: at - 1, top: strip.top + 4, width: 2, height: strip.height - 4 });
    g.dropIndex = i < 0 ? tabs.length : i;
  });
  g.strip.addEventListener('drop', (e) => carriesTab(e) && takeDrop(e, g, 'strip', g.dropIndex));
  g.catcher.addEventListener('dragover', (e) => {
    if (!carriesTab(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const box = g.body.getBoundingClientRect();
    showHint(zoneRect(zoneAt(e, box), box));
  });
  g.catcher.addEventListener('drop', (e) => carriesTab(e) && takeDrop(e, g, zoneAt(e, g.body.getBoundingClientRect())));
}

// A tab dragged in from another window never fired dragstart here.
window.addEventListener('dragenter', (e) => carriesTab(e) && document.body.classList.add('dragging-tab'));
window.addEventListener('dragleave', (e) => {
  if (e.relatedTarget === null) {
    document.body.classList.remove('dragging-tab');
    hideHint();
  }
});
window.addEventListener('drop', () => document.body.classList.remove('dragging-tab'));

// ---------- windows ----------

// Everything another window needs to carry a terminal on: what it is, and what is on its screen.
function specOf(tab) {
  let snapshot = '';
  try {
    snapshot = tab.serialize.serialize({ scrollback: 3000 });
  } catch {
    // the new window starts with an empty screen; Claude repaints it on resize
  }
  return {
    id: tab.id,
    kind: tab.kind,
    dir: tab.dir,
    cwd: tab.cwd,
    sessionId: tab.sessionId,
    name: tab.name,
    account: tab.account,
    server: tab.server,
    exited: tab.exited,
    snapshot: snapshot + tab.pending.join(''),
  };
}

// Let go of a terminal without stopping it: another window carries it on.
function detachTab(id) {
  const tab = S.tabs.get(id);
  if (!tab) return;
  tab.term.dispose();
  tab.pane.remove();
  S.tabs.delete(id);
  S.muted.delete(id);
  const i = S.order.indexOf(id);
  S.order.splice(i, 1);
  if (S.active === id) S.active = S.order[Math.min(i, S.order.length - 1)] || null;
  tabsChanged();
  focusActive();
  if (S.child && !S.tabs.size) deck.closeWindow();
}

async function popOut(ids, x, y) {
  if (S.remote) return;
  const specs = ids.filter((id) => S.tabs.has(id)).map((id) => specOf(S.tabs.get(id)));
  if (!specs.length) return;
  if (S.child && specs.length === S.tabs.size) return toast('This window already holds only that terminal. Drag it onto another window to move it.');
  await deck.popOut({ specs, x: x === undefined ? window.screenX + 80 : x, y: y === undefined ? window.screenY + 80 : y });
  for (const s of specs) detachTab(s.id);
}

function wireWindows() {
  deck.onTabRelease((reqId, id) => {
    const tab = S.tabs.get(id);
    deck.reply(reqId, tab ? specOf(tab) : null);
    if (tab) detachTab(id);
  });
  // This window is closing: hand every terminal back to the main window.
  deck.onSurrender((reqId) => {
    deck.reply(
      reqId,
      S.order.map((id) => specOf(S.tabs.get(id))),
    );
  });
  deck.onAdoptTabs((specs) => {
    for (const spec of specs) createTab({ ...spec, adopt: true });
  });
  deck.onTabShow((id) => S.tabs.has(id) && activate(id));
}

// Take over a terminal that is already running: show what was on its screen, then follow it live.
async function adoptTab(tab) {
  tab.started = true;
  if (tab.snapshot) tab.term.write(tab.snapshot);
  tab.snapshot = null;
  tab.term.onData((d) => deck.write(tab.id, d));
  tab.term.onResize(({ cols, rows }) => deck.resize(tab.id, cols, rows));
  await deck.adopt(tab.id);
  deck.resize(tab.id, tab.term.cols, tab.term.rows);
  if (tab.exited) queueOutput(tab, '\r\n\x1b[90mThis terminal has closed.\x1b[0m\r\n');
  if (tab.id === S.active) tab.term.focus();
}
