// The window's `deck`, in a browser: every call goes over the connection to
// Loop on the PC, and events come back the same way. Served by remote-desk.js
// ahead of the window's own scripts.
(() => {
  'use strict';
  const found = /[#&]k=([a-f0-9]{64})/.exec(location.hash);
  if (found) {
    try {
      localStorage.setItem('loopDeskKey', found[1]);
    } catch {
      // private window: the key lives only in this page
    }
    history.replaceState(null, '', location.pathname);
  }
  let key = found ? found[1] : '';
  try {
    key = key || localStorage.getItem('loopDeskKey') || '';
  } catch {
    // no storage
  }

  const props = window.__deskProps || {};
  const pending = new Map();
  const subs = new Map(); // channel -> callbacks
  let seq = 0;
  let ws = null;
  let ready = null;
  let readyNow = () => {};
  const fresh = () => (ready = new Promise((r) => (readyNow = r)));
  fresh();

  function banner(text, link) {
    let el = document.getElementById('desk-banner');
    if (!el) {
      el = document.createElement('div');
      el.id = 'desk-banner';
      el.style.cssText = 'position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:9999;background:#22313f;color:#dce5ec;border:1px solid #35485a;border-radius:8px;padding:9px 14px;font:13px system-ui;box-shadow:0 6px 24px rgba(0,0,0,.4)';
      document.body.append(el);
    }
    el.textContent = text + ' ';
    if (link) {
      const a = document.createElement('a');
      a.href = 'https://loop.prismaple.com/cloud#/machines';
      a.textContent = 'Open it again';
      a.style.color = '#7cc4f0';
      el.append(a);
    }
    el.hidden = !text;
  }

  function connect() {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.onopen = () => ws.send(JSON.stringify({ t: 'desk', key }));
    ws.onmessage = (e) => {
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.t === 'desk-ready') {
        banner('');
        readyNow();
      } else if (m.t === 'desk-denied') {
        try {
          localStorage.removeItem('loopDeskKey');
        } catch {
          // fine
        }
        key = '';
        banner('This browser is not let in to this PC any more.', true);
      } else if (m.t === 'ret') {
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        if (m.ok) p.res(m.value);
        else p.rej(new Error(m.error || 'Failed'));
      } else if (m.t === 'ev') {
        for (const cb of subs.get(m.ch) || []) {
          try {
            cb(...(m.args || []));
          } catch (x) {
            console.error(x);
          }
        }
      }
    };
    ws.onclose = () => {
      for (const p of pending.values()) p.rej(new Error('Connection lost'));
      pending.clear();
      if (!key) return;
      fresh();
      banner('Reconnecting to your PC…');
      setTimeout(connect, 2000);
    };
  }
  if (key) connect();
  else setTimeout(() => banner('Open this PC from your machines list to use it here.', true), 0);

  const call = (name, args) =>
    ready.then(
      () =>
        new Promise((res, rej) => {
          const id = ++seq;
          pending.set(id, { res, rej });
          ws.send(JSON.stringify({ t: 'call', id, name, args }));
        }),
    );

  // Things that would happen on the PC's own screen happen here instead.
  const local = {
    openExternal: (url) => window.open(url, '_blank', 'noopener'),
    cloudSite: () => window.open('https://loop.prismaple.com/cloud', '_blank', 'noopener'),
    dropPath: () => '',
    closeWindow: () => {},
  };

  window.deck = new Proxy(
    {},
    {
      get: (_t, name) => {
        if (typeof name !== 'string') return undefined;
        if (name in local) return local[name];
        if (name in props) return props[name];
        if (/^on[A-Z]/.test(name)) {
          return (cb) => {
            call(name, [])
              .then((r) => {
                if (!r || !r.sub) return;
                if (!subs.has(r.sub)) subs.set(r.sub, []);
                subs.get(r.sub).push(cb);
              })
              .catch(() => {});
            return () => {};
          };
        }
        // write and resize are many and small; they need no answer.
        if (name === 'write' || name === 'resize') {
          return (...args) => {
            if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'call', id: 0, name, args }));
          };
        }
        return (...args) => call(name, args);
      },
    },
  );
})();
