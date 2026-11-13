/* global deck, S, h, put, icon, toast, lampFor, isClaudeTab, fitTab, accountFor, projectByDir */
// A session as a chat: its conversation, read from the same file Claude Code
// writes, with a message box underneath. The terminal stays where it is; a
// switch on each session flips between the two. A browser or a touch screen
// opens sessions as chat; Loop on a PC opens them as a terminal.
//
// What is typed is typed into the session's terminal, so everything Claude
// Code does works the same. Commands that open a menu there (/model, /resume …)
// flip the tab to the terminal to answer it, with one tap back.

const CHAT_POLL = 1200;

function chatDevice() {
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  return S.remote || coarse ? 'remote' : 'desktop';
}

function chatDefault() {
  const s = S.config.settings || {};
  const d = chatDevice();
  const want = d === 'remote' ? s.viewRemote || 'chat' : s.viewDesktop || 'terminal';
  return want === 'chat' ? 'chat' : 'terminal';
}

// ---- a little Markdown, safely: everything is escaped first ----
const chatEsc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
function chatInline(s) {
  return chatEsc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" data-ext="1">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" data-ext="1">$2</a>');
}
function chatMarkdown(text) {
  const out = [];
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  let list = null;
  const endList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const fence = /^\s*```/.exec(l);
    if (fence) {
      endList();
      const body = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) body.push(lines[i]);
      out.push(`<pre><code>${chatEsc(body.join('\n'))}</code></pre>`);
      continue;
    }
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(l);
    const num = /^\s*\d+[.)]\s+(.*)$/.exec(l);
    if (bullet || num) {
      const want = bullet ? 'ul' : 'ol';
      if (list !== want) {
        endList();
        list = want;
        out.push(`<${want}>`);
      }
      out.push(`<li>${chatInline((bullet || num)[1])}</li>`);
      continue;
    }
    endList();
    const head = /^\s*#{1,6}\s+(.*)$/.exec(l);
    if (head) out.push(`<p class="chat-h">${chatInline(head[1])}</p>`);
    else if (/^\s*\|/.test(l)) out.push(`<pre class="chat-table">${chatEsc(l)}</pre>`);
    else if (l.trim()) out.push(`<p>${chatInline(l)}</p>`);
  }
  endList();
  return out.join('').replace(/<\/pre><pre class="chat-table">/g, '\n');
}

// ---- setting up a tab ----

function setupChat(tab, termEl) {
  if (!isClaudeTab(tab)) return;
  const c = { items: [], from: -1, byId: new Map(), timer: 0, open: new Set(), commands: null };
  tab.chat = c;
  c.list = h('div.chat-list', {
    onclick: (e) => {
      const a = e.target.closest('a[data-ext]');
      if (a) {
        e.preventDefault();
        deck.openExternal(a.href);
      }
    },
  });
  c.st = {
    star: h('span.st-star', { 'aria-hidden': 'true' }, '✻'),
    word: h('b.st-word'),
    doing: h('span.st-doing'),
    ask: h(
      'div.st-ask',
      {},
      h('span', {}, 'It is asking you something in the terminal.'),
      h('button.btn.small.primary', { onclick: () => setView(tab, 'terminal') }, 'Answer it'),
    ),
  };
  c.status = h(
    'div.chat-status',
    {},
    c.st.ask,
    h('div.st-work', {}, c.st.star, c.st.word, c.st.doing),
  );
  c.input = h('textarea.chat-input', { rows: 1, placeholder: 'Message…', 'aria-label': 'Message' });
  const sendBtn = h(
    'button.chat-send',
    {
      title: 'Send',
      'aria-label': 'Send',
      onclick: () => (sendBtn.classList.contains('stop') ? deck.write(tab.id, '\x1b') : chatSend(tab)),
    },
    icon('play'),
    h('i.stop-sq'),
  );
  c.send = sendBtn;
  // Commands work in the terminal only: a / here says so, and goes nowhere.
  c.hint = h(
    'div.chat-hint',
    {},
    h('span', {}, 'Commands work in the terminal.'),
    h('button.btn.small', { onmousedown: (e) => e.preventDefault(), onclick: () => setView(tab, 'terminal') }, 'Open terminal'),
  );
  c.files = []; // waiting to go with the next message: { file, url }
  c.tray = h('div.chat-tray');
  c.picker = h('input', { type: 'file', multiple: true, hidden: true, onchange: () => (chatAdd(tab, c.picker.files), (c.picker.value = '')) });
  const attach = h('button.chat-attach', { title: 'Add photos or files', 'aria-label': 'Add photos or files', onclick: () => c.picker.click() }, icon('clip'));
  c.box = h('div.chat-box', {}, c.hint, c.tray, h('div.chat-row', {}, attach, c.input, sendBtn), c.picker);
  // A picture pasted from the clipboard, or files dropped on the chat.
  c.input.addEventListener('paste', (e) => {
    const got = [...((e.clipboardData && e.clipboardData.files) || [])];
    if (got.length) {
      e.preventDefault();
      chatAdd(tab, got);
    }
  });
  c.el = h('div.chat', {}, c.list, c.status, c.box);
  tab.pane.insertBefore(c.el, termEl.nextSibling);
  c.el.addEventListener('dragover', (e) => {
    if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) {
      e.preventDefault();
      c.el.classList.add('drop');
    }
  });
  c.el.addEventListener('dragleave', (e) => e.target === c.el && c.el.classList.remove('drop'));
  c.el.addEventListener('drop', (e) => {
    c.el.classList.remove('drop');
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault();
    e.stopPropagation();
    chatAdd(tab, e.dataTransfer.files);
  });

  c.input.addEventListener('input', () => {
    c.hint.classList.toggle('on', c.input.value.trimStart().startsWith('/'));
    chatSendKey(tab);
    c.input.style.height = 'auto';
    c.input.style.height = Math.min(c.input.scrollHeight, 160) + 'px';
  });
  c.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      chatSend(tab);
    }
  });

  // The switch, top right of the session.
  c.toggle = h(
    'div.view-switch',
    { role: 'tablist', 'aria-label': 'Show as' },
    h('button', { 'data-v': 'terminal', title: 'Show as a terminal', onclick: (e) => (e.stopPropagation(), setView(tab, 'terminal')) }, icon('terminal'), 'Terminal'),
    h('button', { 'data-v': 'chat', title: 'Show as a chat', onclick: (e) => (e.stopPropagation(), setView(tab, 'chat')) }, icon('book'), 'Chat'),
  );
  tab.pane.append(c.toggle);

  // A phone has no Esc or arrow keys, and the terminal's pickers need them.
  if (chatDevice() === 'remote') {
    tab.pane.classList.add('touch');
    const key = (label, seq, title) =>
      h('button', { title, 'aria-label': title, onmousedown: (e) => e.preventDefault(), onclick: () => deck.write(tab.id, seq) }, label);
    tab.pane.append(
      h(
        'div.term-keys',
        {},
        key('Esc', '\x1b', 'Escape'),
        key('Tab', '\t', 'Tab'),
        key('↑', '\x1b[A', 'Up'),
        key('↓', '\x1b[B', 'Down'),
        key('←', '\x1b[D', 'Left'),
        key('→', '\x1b[C', 'Right'),
        key('Enter', '\r', 'Enter'),
      ),
    );
  }
  setView(tab, chatDefault());
}

function setView(tab, view) {
  const c = tab.chat;
  if (!c) return;
  tab.view = view;
  tab.pane.classList.toggle('as-chat', view === 'chat');
  for (const b of c.toggle.querySelectorAll('button')) b.classList.toggle('on', b.dataset.v === view);
  clearInterval(c.timer);
  clearInterval(c.beat);
  if (view === 'chat') {
    chatPoll(tab);
    c.timer = setInterval(() => chatPoll(tab), CHAT_POLL);
    clearInterval(c.beat);
    c.beat = setInterval(() => chatStatus(tab), 450);
    if (!S.remote || !matchMedia('(pointer: coarse)').matches) setTimeout(() => c.input.focus(), 50);
  } else {
    requestAnimationFrame(() => {
      fitTab(tab);
      tab.term.focus();
    });
  }
}

// ---- reading and drawing ----

async function chatPoll(tab) {
  const c = tab.chat;
  if (!c || c.busyRead || !tab.sessionId || !tab.pane.isConnected) return;
  c.busyRead = true;
  try {
    const r = await deck.chatRead({ dir: tab.dir, sessionId: tab.sessionId, from: c.from });
    if (r && typeof r.size === 'number') {
      if (r.size < c.from) {
        // The file started over (/clear): read it again from the top.
        c.from = -1;
        c.items = [];
        c.byId.clear();
      } else c.from = r.size;
      if (r.items && r.items.length) {
        for (const it of r.items) {
          if (it.k === 'result') {
            const t = c.byId.get(it.id);
            if (t) t.result = it;
            continue;
          }
          if (c.byId.has(it.id)) continue;
          c.byId.set(it.id, it);
          c.items.push(it);
        }
        if (c.items.length > 600) c.items = c.items.slice(-600);
        chatDraw(tab);
      }
    }
  } catch {
    // the next poll tries again
  } finally {
    c.busyRead = false;
  }
  chatStatus(tab);
}

function chatDraw(tab) {
  const c = tab.chat;
  const near = c.list.scrollHeight - c.list.scrollTop - c.list.clientHeight < 80;
  const nodes = [];
  let tools = [];
  // The newest item, when it is a tool call: its group may still be running.
  const endTool = c.items.length && c.items[c.items.length - 1].k === 'tool' ? c.items[c.items.length - 1] : null;
  const flush = () => {
    if (!tools.length) return;
    const group = tools;
    const key = group[0].id;
    const open = c.open.has(key);
    const failed = group.filter((t) => t.result && t.result.ok === false).length;
    // The last group, while the session works and a step has no result yet.
    const running = Boolean(c.busy) && group[group.length - 1] === endTool && group.some((t) => !t.result);
    nodes.push(
      h(
        'div.chat-tools',
        { class: open ? 'open' : '' },
        h(
          'button.chat-tools-head',
          {
            onclick: () => {
              if (c.open.has(key)) c.open.delete(key);
              else c.open.add(key);
              chatDraw(tab);
            },
          },
          running ? 'Running' : `Used ${group.length} tool${group.length === 1 ? '' : 's'}${failed ? ` · ${failed} failed` : ''}`,
          icon('chevron'),
        ),
        open ? h('div.chat-tools-list', {}, group.map((t) => h('div.chat-tool', { class: t.result && t.result.ok === false ? 'bad' : '' }, h('b', {}, t.title || t.name), h('span', {}, t.sub || t.label || '')))) : null,
      ),
    );
    tools = [];
  };
  for (const it of c.items) {
    if (it.k === 'tool') {
      tools.push(it);
      continue;
    }
    flush();
    if (it.k === 'user') {
      const pics = (it.images || []).filter((img) => img.file || img.b64);
      nodes.push(
        h(
          'div.chat-msg.chat-me',
          { class: it.command ? 'cmd' : '' },
          h(
            'div.chat-me-col',
            {},
            pics.length ? chatStrip(pics) : null,
            (it.files || []).length ? h('div.chat-files', {}, it.files.map((f) => h('span.chat-file', { title: f.name }, icon('file'), h('span', {}, f.name)))) : null,
            it.text ? h('div.bubble', {}, it.text) : null,
          ),
        ),
      );
    }
    else if (it.k === 'peer') nodes.push(h('div.chat-msg.chat-peer', {}, h('small', {}, it.from), h('div.bubble', {}, it.text)));
    else if (it.k === 'text') {
      const body = h('div.md', { innerHTML: chatMarkdown(it.text) });
      nodes.push(
        h(
          'div.chat-msg.chat-claude',
          { class: it.command ? 'cmd' : '' },
          body,
          h('button.chat-copy', { title: 'Copy', onclick: () => deck.clipWrite(it.text) && toast('Copied') }, icon('copy')),
        ),
      );
    } else if (it.k === 'note') nodes.push(h('div.chat-note', {}, it.text));
  }
  flush();
  if (!nodes.length) nodes.push(h('div.chat-empty', {}, 'Nothing said yet. Type a message below.'));
  put(c.list, nodes);
  if (near || !c.drawn) c.list.scrollTop = c.list.scrollHeight;
  c.drawn = true;
}

// Claude Code's own line while it works, from the terminal screen, e.g.
// "✽ Reticulating… (12s · ↓ 1.2k tokens · thinking)". Null when it is not working.
const SPIN = /^\s*[✻✽✶✢✳*·∗⏺●]\s+([A-Z][\w' -]{1,40}…)\s*(?:\(([^)]*)\))?/;
function spinnerLine(tab) {
  const b = tab.term && tab.term.buffer.active;
  if (!b) return null;
  const end = b.baseY + tab.term.rows;
  const text = (y) => {
    const line = b.getLine(y);
    return line ? line.translateToString(true) : '';
  };
  // It sits just above the input box, whose top and bottom are ruled lines.
  let rules = 0;
  let top = -1;
  for (let y = end - 1; y >= Math.max(0, end - 14); y--) {
    if (/^\s*─{8,}/.test(text(y)) && ++rules === 2) {
      top = y;
      break;
    }
  }
  if (top < 0) return null;
  for (let y = top - 1; y >= Math.max(0, top - 6); y--) {
    const m = SPIN.exec(text(y));
    if (m) {
      const meta = (m[2] || '')
        .split('·')
        .map((x) => x.trim())
        .filter((x) => x && !/esc to|interrupt/i.test(x))
        .slice(0, 3)
        .join(' · ');
      return { word: m[1], meta };
    }
  }
  return null;
}

const STARS = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];

// What the session is doing, and anything it is waiting on in the terminal.
function chatStatus(tab) {
  const c = tab.chat;
  if (!c || !c.st) return;
  const lamp = lampFor(tab.sessionId, tab);
  const last = c.items[c.items.length - 1];
  const asking = last && last.k === 'tool' && /AskUserQuestion|ExitPlanMode/.test(last.name) && !last.result;
  const spin = spinnerLine(tab);
  const busy = !asking && (lamp === 'busy' || lamp === 'shell' || Boolean(spin));
  c.status.classList.toggle('on', asking || busy);
  c.status.classList.toggle('asking', asking);
  if (busy !== c.busy) {
    c.busy = busy;
    c.input.placeholder = busy ? 'Queue a message…' : 'Message…';
    chatSendKey(tab);
    chatDraw(tab); // the step in progress reads Running, not Used
  }
  if (!busy) return;
  // The step it is on: the newest tool call that has no result yet.
  let step = null;
  for (let i = c.items.length - 1; i >= 0 && i >= c.items.length - 40; i--) {
    const it = c.items[i];
    if (it.k === 'tool' && !it.result) {
      step = it;
      break;
    }
    if (it.k === 'user') break;
  }
  c.st.star.textContent = STARS[Math.floor(Date.now() / 140) % STARS.length];
  c.st.word.textContent = spin ? spin.word : 'Working…';
  // What is running: the command itself, or the step, else Claude's own time and tokens.
  const cmd = step && step.kind === 'run' && step.detail ? String(step.detail).split('\n')[0] : '';
  const what = step ? cmd || [step.doing || step.title, step.sub].filter(Boolean).join(' ') : spin && spin.meta ? spin.meta : '';
  c.st.doing.textContent = what ? ' · ' + what : '';
  c.st.doing.title = what;
}

// The button in the message box: Stop while it works and the box is empty.
function chatSendKey(tab) {
  const c = tab.chat;
  const stop = Boolean(c.busy) && !c.input.value.trim() && !c.files.length;
  c.send.classList.toggle('stop', stop);
  c.send.title = stop ? 'Stop (Esc)' : c.busy ? 'Queue this message' : 'Send';
  c.send.setAttribute('aria-label', stop ? 'Stop' : 'Send');
}

// ---- sending ----

async function chatSend(tab) {
  const c = tab.chat;
  let text = c.input.value.replace(/\s+$/, '');
  if ((!text.trim() && !c.files.length) || c.sending) return;
  // A command is not sent from here: the hint points to the terminal.
  if (text.trimStart().startsWith('/')) {
    c.hint.classList.add('on');
    c.hint.animate([{ opacity: 0.4 }, { opacity: 1 }], { duration: 300 });
    return;
  }
  if (c.files.length) {
    c.sending = true;
    c.send.classList.add('wait');
    try {
      await Promise.all(c.files.map((f) => f.promise));
    } finally {
      c.sending = false;
      c.send.classList.remove('wait');
    }
    if (c.files.some((f) => f.state !== 'done')) {
      toast('A file did not send. Try it again, or remove it.', true);
      return;
    }
    text = [text.trim(), ...c.files.map((f) => f.path)].filter(Boolean).join(' ');
    for (const f of c.files) if (f.url) URL.revokeObjectURL(f.url);
    c.files = [];
    chatTray(tab);
  }
  c.input.value = '';
  c.input.style.height = 'auto';
  c.hint.classList.remove('on');
  chatSendKey(tab);
  if (!text.includes('\n')) deck.write(tab.id, text);
  // Pasted as one block, so Claude Code takes the line breaks as part of the message.
  else deck.write(tab.id, `\x1b[200~${text}\x1b[201~`);
  setTimeout(() => deck.write(tab.id, '\r'), 60);
  setTimeout(() => chatPoll(tab), 700);
}

// ---- attachments ----

const IMG_FILE = /^image\/(png|jpe?g|gif|webp|bmp)$/i;

// What was picked, pasted or dropped joins the tray, up to ten at a time.
function chatAdd(tab, list) {
  const c = tab.chat;
  for (const file of [...(list || [])]) {
    if (c.files.length >= 10) {
      toast('Ten at a time is the most.', true);
      break;
    }
    if (file.size > 20 * 1024 * 1024 && !IMG_FILE.test(file.type)) {
      toast(`${file.name} is bigger than 20 MB.`, true);
      continue;
    }
    const f = { file, url: IMG_FILE.test(file.type) ? URL.createObjectURL(file) : '' };
    c.files.push(f);
    chatUploadOne(tab, f);
  }
  chatTray(tab);
  chatSendKey(tab);
  c.input.focus();
}

// One file goes up as soon as it is added, a megabyte at a time, so its ring
// fills as it goes. Several go up side by side.
function chatUploadOne(tab, f) {
  f.state = 'up';
  f.pct = 0;
  f.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  chatPaint(f);
  f.promise = (async () => {
    try {
      const b64 = await packFile(f.file);
      const CHUNK = 1 << 20; // a multiple of 4, so each part is whole base64
      const of = Math.max(1, Math.ceil(b64.length / CHUNK));
      let got = null;
      for (let i = 0; i < of; i++) {
        if (f.dropped) return;
        got = await deck.chatUploadPart({ id: f.id, name: f.file.name, i, of, b64: b64.slice(i * CHUNK, (i + 1) * CHUNK) });
        f.pct = (i + 1) / of;
        chatPaint(f);
      }
      f.path = got.path;
      f.state = 'done';
      // Taken out of the tray while it was going up: it goes from the PC too.
      if (f.dropped) deck.chatDiscard(f.path).catch(() => {});
    } catch {
      f.state = 'fail';
    }
    chatPaint(f);
    chatSendKey(tab);
  })();
}

// A tray item is made once and then only repainted: its ring, tick or retry.
function chatItem(tab, f) {
  const c = tab.chat;
  if (f.el) return f.el;
  const remove = () => {
    f.dropped = true;
    if (f.state === 'done' && f.path) deck.chatDiscard(f.path).catch(() => {});
    c.files.splice(c.files.indexOf(f), 1);
    if (f.url) URL.revokeObjectURL(f.url);
    chatTray(tab);
    chatSendKey(tab);
  };
  f.ring = h('span.tray-ring', { 'aria-hidden': 'true' });
  const retry = h('button.tray-retry', { title: 'Try again', 'aria-label': 'Try again', onclick: () => chatUploadOne(tab, f) }, icon('refresh'));
  const drop = h('button.tray-x', { title: 'Remove', 'aria-label': 'Remove', onclick: remove }, icon('x'));
  const pics = () => c.files.filter((x) => x.url);
  f.el = f.url
    ? h('div.tray-pic', { title: f.file.name }, h('img', { src: f.url, alt: f.file.name, onclick: () => chatViewer(pics().map((x) => x.url), pics().indexOf(f)) }), f.ring, retry, drop)
    : h('div.tray-file', { title: f.file.name }, icon('file'), h('span', {}, f.file.name), f.ring, retry, drop);
  chatPaint(f);
  return f.el;
}

function chatPaint(f) {
  if (!f.el) return;
  f.el.classList.toggle('up', f.state === 'up');
  f.el.classList.toggle('done', f.state === 'done');
  f.el.classList.toggle('fail', f.state === 'fail');
  f.ring.style.setProperty('--p', String(Math.round((f.pct || 0) * 100)));
  f.el.title = f.file.name + (f.state === 'up' ? ' (sending)' : f.state === 'fail' ? ' (did not send: try again)' : '');
}

function chatTray(tab) {
  const c = tab.chat;
  put(
    c.tray,
    c.files.map((f) => chatItem(tab, f)),
  );
  c.tray.classList.toggle('on', c.files.length > 0);
}

// A file as base64. A big photo is made smaller first (a phone camera's
// 4000 px is more than Claude needs, and slow to send): 2000 px on its long side.
async function packFile(file) {
  let blob = file;
  if (/^image\/(png|jpe?g|webp|bmp)$/i.test(file.type) && file.size > 900 * 1024) {
    try {
      const bmp = await createImageBitmap(file);
      const k = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
      if (k < 1 || file.size > 3 * 1024 * 1024) {
        const cv = document.createElement('canvas');
        cv.width = Math.round(bmp.width * k);
        cv.height = Math.round(bmp.height * k);
        cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
        blob = await new Promise((res) => cv.toBlob(res, 'image/jpeg', 0.88));
      }
    } catch {
      blob = file;
    }
  }
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return btoa(s);
}

// Pictures in a message: a strip that slides; each opens full screen.
const PICS = new Map(); // upload path -> data URL
function picSrc(img) {
  if (img.b64) return Promise.resolve(`data:${img.type && img.type.includes('/') ? img.type : 'image/png'};base64,${img.b64}`);
  if (!PICS.has(img.file)) PICS.set(img.file, deck.chatPicture(img.file).catch(() => null));
  return PICS.get(img.file);
}
function chatStrip(pics) {
  const srcs = pics.map(picSrc);
  const strip = h('div.chat-pics', { class: pics.length === 1 ? 'one' : '' });
  pics.forEach((img, i) => {
    const el = h('img', { alt: 'Picture', loading: 'lazy', onclick: async () => chatViewer(await Promise.all(srcs), i) });
    const box = h('div.chat-pic', {}, el);
    srcs[i].then((src) => (src ? (el.src = src) : box.classList.add('gone')));
    strip.append(box);
  });
  return strip;
}

// Full screen: one picture at a time; arrows, a swipe, or the keys move along.
function chatViewer(srcs, at) {
  const list = srcs.map((s, i) => [s, i]).filter(([s]) => s);
  if (!list.length) return toast('That picture is no longer kept on the PC.', true);
  let i = Math.max(0, list.findIndex(([, n]) => n === at));
  const img = h('img.lb-img', { alt: 'Picture' });
  const count = h('div.lb-count');
  const show = () => {
    img.src = list[i][0];
    count.textContent = list.length > 1 ? `${i + 1} / ${list.length}` : '';
    prev.disabled = i === 0;
    next.disabled = i === list.length - 1;
  };
  const go = (d) => {
    const n = i + d;
    if (n < 0 || n >= list.length) return;
    i = n;
    show();
  };
  const close = () => {
    document.removeEventListener('keydown', keys, true);
    lb.remove();
  };
  const keys = (e) => {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft') go(-1);
    else if (e.key === 'ArrowRight') go(1);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  const prev = h('button.lb-nav.prev', { 'aria-label': 'Previous', onclick: (e) => (e.stopPropagation(), go(-1)) }, '‹');
  const next = h('button.lb-nav.next', { 'aria-label': 'Next', onclick: (e) => (e.stopPropagation(), go(1)) }, '›');
  const lb = h(
    'div.lightbox',
    { onclick: (e) => e.target === lb && close() },
    img,
    list.length > 1 ? prev : null,
    list.length > 1 ? next : null,
    count,
    h('button.lb-close', { 'aria-label': 'Close', onclick: close }, icon('x')),
  );
  let x0 = null;
  lb.addEventListener('touchstart', (e) => (x0 = e.touches.length === 1 ? e.touches[0].clientX : null), { passive: true });
  lb.addEventListener('touchend', (e) => {
    if (x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0;
    if (Math.abs(dx) > 45) go(dx < 0 ? 1 : -1);
    x0 = null;
  });
  img.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('keydown', keys, true);
  document.body.append(lb);
  show();
}

function touchScroll(tab, termEl) {
  let y = null;
  let acc = 0;
  termEl.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length !== 1) return;
      y = e.touches[0].clientY;
      acc = 0;
    },
    { passive: true },
  );
  termEl.addEventListener(
    'touchmove',
    (e) => {
      if (y === null || e.touches.length !== 1) return;
      const now = e.touches[0].clientY;
      acc += y - now;
      y = now;
      const row = Math.max(10, (S.config.settings.fontSize || 13) * 1.35);
      const b = tab.term.buffer.active;
      // Claude Code drawing full screen keeps its own scrollback: it scrolls on
      // mouse-wheel reports (each one moves a few lines), not the terminal's.
      const app = b.type === 'alternate' && tab.term.modes.mouseTrackingMode !== 'none';
      const unit = app ? row * 3 : row;
      const steps = Math.trunc(acc / unit);
      if (steps) {
        if (app) {
          const at = `${Math.max(1, tab.term.cols >> 1)};${Math.max(1, tab.term.rows >> 1)}`;
          deck.write(tab.id, `\x1b[<${steps > 0 ? 65 : 64};${at}M`.repeat(Math.abs(steps)));
        } else tab.term.scrollLines(steps);
        acc -= steps * unit;
      }
      e.preventDefault();
    },
    { passive: false },
  );
  termEl.addEventListener('touchend', () => (y = null), { passive: true });
}
