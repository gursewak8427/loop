/* global S, h, put, icon, deck, save, toast, openPanel, fitTab, renderStatus, renderDrawer, loadNotes, hearVoice, MOD,
   openAccounts, openTools, openInternet, openPhone, openServers, restartToUpdate, getUpdate */
// Settings: one window, its sections down the left. Each section is a few
// groups of related settings, and a change takes effect as it is made: there is
// no Save to forget. Updates live here too: what version this is, whether a
// newer one is out, and the button that installs it.

const SET_TONES = { blue: '#6cb6ff', green: '#56d39b', violet: '#b79cf2', amber: '#f0b860', pink: '#f291b9', teal: '#5dcaa5' };

function settingsSections(voices) {
  return [
    { key: 'general', label: 'General', icon: 'gear', tone: 'blue', about: 'How Loop starts, and how it opens a session.' },
    { key: 'look', label: 'Appearance', icon: 'eye', tone: 'violet', about: 'How terminals look and how they are drawn.' },
    { key: 'sessions', label: 'Sessions', icon: 'terminal', tone: 'green', about: 'What Loop runs when it starts a Claude Code session.' },
    { key: 'memory', label: 'Memory', icon: 'book', tone: 'amber', about: 'The notes your sessions keep, and where they live.' },
    voices && voices.length ? { key: 'voice', label: 'Voice', icon: 'mic', tone: 'pink', about: 'The voice Loop answers in when you talk to a session.' } : null,
    { key: 'access', label: 'Accounts and access', icon: 'plug', tone: 'teal', about: 'Who sessions run as, what they can use, and where you can reach them from.' },
    S.remote ? null : { key: 'updates', label: 'Updates', icon: 'download', tone: 'blue', about: 'The version of Loop on this PC, and newer ones.' },
  ].filter(Boolean);
}

async function openSettings(section) {
  const st = { at: typeof section === 'string' ? section : openSettings.last || 'general', voices: [], checking: false };
  const nav = h('nav.set-nav', { 'aria-label': 'Settings sections' });
  const body = h('div.set-body');
  const version = h('small.set-ver');
  const box = h(
    'div.dialog.settings',
    { tabIndex: -1, role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Settings' },
    h('aside.set-side', {}, h('h2', {}, 'Settings'), nav, version),
    h('div.set-main', {}, h('button.mini.set-close', { title: 'Close', 'aria-label': 'Close settings', onclick: () => close() }, icon('x')), body),
  );
  const close = openPanel(box);

  // ---- the parts every section is made of ----
  const apply = (patch) => {
    S.config.settings = { ...S.config.settings, ...patch };
    save();
  };
  const row = (label, hint, control) => h('div.set-row', {}, h('div.set-text', {}, h('b', {}, label), hint ? h('small', {}, hint) : null), h('div.set-ctl', {}, control));
  const group = (title, ...rows) => h('section.set-group', {}, title ? h('h4', {}, title) : null, h('div.set-card', {}, rows.filter(Boolean)));
  const toggle = (label, on, change) => {
    const b = h('button.set-switch', { type: 'button', role: 'switch', 'aria-checked': String(Boolean(on)), 'aria-label': label, class: on ? 'on' : '' }, h('i'));
    b.onclick = () => {
      const now = b.getAttribute('aria-checked') !== 'true';
      b.setAttribute('aria-checked', String(now));
      b.classList.toggle('on', now);
      change(now);
    };
    return b;
  };
  const choose = (label, value, options, change) =>
    h(
      'select.set-input',
      { 'aria-label': label, onchange: (e) => change(e.target.value) },
      options.map((o) => h('option', { value: o.value, selected: o.value === value }, o.label)),
    );
  // A line of text is taken when it is left, or on Enter: not on every key.
  const text = (label, value, change, placeholder) => {
    const i = h('input.set-input.mono', { type: 'text', value, placeholder: placeholder || '', 'aria-label': label, spellcheck: false });
    i.onchange = () => change(i.value);
    i.onkeydown = (e) => e.key === 'Enter' && i.blur();
    return i;
  };
  const go = (label, run) => h('button.btn.small', { type: 'button', onclick: () => (close(), run()) }, label);

  // ---- the sections ----
  const sections = {
    general: () => {
      const s = S.config.settings;
      return [
        group(
          'When Loop starts',
          row('Reopen the sessions from last time', 'The terminals that were open when you closed Loop come back.', toggle('Reopen the sessions from last time', s.restoreOnStart, (on) => apply({ restoreOnStart: on }))),
        ),
        group(
          'Opening a session',
          row(
            'On this PC, open it as',
            'A terminal is Claude Code as it is. A chat shows the same conversation as messages.',
            choose('On this PC, open sessions as', s.viewDesktop || 'terminal', [{ value: 'terminal', label: 'A terminal' }, { value: 'chat', label: 'A chat' }], (v) => apply({ viewDesktop: v })),
          ),
          row(
            'In a browser or on a phone, open it as',
            'For Loop opened from another device.',
            choose('In a browser or on a phone, open sessions as', s.viewRemote || 'chat', [{ value: 'chat', label: 'A chat' }, { value: 'terminal', label: 'A terminal' }], (v) => apply({ viewRemote: v })),
          ),
        ),
        group(
          'Notifications',
          row('Tell me when a session finishes', 'Only while you are in another window.', toggle('Tell me when a session finishes', s.notify !== false, (on) => apply({ notify: on }))),
        ),
      ];
    },

    look: () => {
      const s = S.config.settings;
      const size = h('output.set-num', {}, String(s.fontSize || 13));
      const setSize = (n) => {
        const now = Math.min(28, Math.max(8, n));
        size.textContent = String(now);
        apply({ fontSize: now });
        for (const tab of S.tabs.values()) {
          tab.term.options.fontSize = now;
          fitTab(tab);
        }
      };
      const step = (by, label) => h('button.btn.small.set-step', { type: 'button', 'aria-label': label, onclick: () => setSize((S.config.settings.fontSize || 13) + by) }, by < 0 ? '−' : '+');
      return [
        group('Terminals', row('Text size', 'Changes every open terminal at once. From 8 to 28.', h('div.set-stepper', {}, step(-1, 'Smaller text'), size, step(1, 'Larger text')))),
        group(
          'Drawing',
          row(
            'Use the high-performance graphics card',
            'Smoother with many terminals open. Takes effect the next time Loop starts.',
            toggle('Use the high-performance graphics card', s.fastGpu !== false, (on) => apply({ fastGpu: on })),
          ),
        ),
      ];
    },

    sessions: () => {
      const s = S.config.settings;
      return [
        group(
          'Claude Code',
          row('Claude command', 'The program that starts Claude Code. Give a full path if claude is not on your PATH.', text('Claude command', s.claudeCmd, (v) => apply({ claudeCmd: String(v).trim() || 'claude' }), 'claude')),
          row('Options added to every session', 'Used when a session is opened or started here. Open terminals keep the options they started with.', text('Options added to every session', s.flags, (v) => apply({ flags: String(v).trim() }), '--model …')),
        ),
      ];
    },

    memory: () => {
      const s = S.config.settings;
      const where = h('code.set-path', { title: S.memoryRoot }, S.memoryRoot);
      const move = async () => {
        const picked = await deck.pickFolder(S.memoryRoot).catch(() => null);
        if (!picked || String(picked).toLowerCase() === S.memoryRoot.toLowerCase()) return;
        const r = await deck.memSetRoot(picked);
        toast(r.message, !r.ok);
        S.memoryRoot = r.root;
        if (r.ok) apply({ memoryDir: r.root });
        where.textContent = S.memoryRoot;
        where.title = S.memoryRoot;
        loadNotes();
        renderDrawer();
      };
      return [
        group(
          'Project memory',
          row('Give sessions access to memory', 'Sessions opened here can read and save notes about the project, and reach their teammates.', toggle('Give sessions access to memory', s.memoryEnabled !== false, (on) => apply({ memoryEnabled: on }))),
        ),
        group(
          'Where it is kept',
          row('Memory folder', 'Notes are plain files here. Choose another place and they move there; choose a folder that already holds Loop memory and it is used as it is.', h('div.set-pathline', {}, where, S.remote ? null : h('button.btn.small', { type: 'button', onclick: move }, 'Change…'))),
        ),
      ];
    },

    voice: () => {
      const s = S.config.settings;
      const value = st.voices.some((v) => v.id === s.voiceName) ? s.voiceName : (st.voices[0] || {}).id;
      return [
        group(
          'Answering out loud',
          row(
            'Voice to answer in',
            `Used when you talk to a session (${MOD}+Shift+V). Choose one and Loop says a line in it.`,
            choose('Voice to answer in', value, st.voices.map((v) => ({ value: v.id, label: `${v.name || v.id}${v.gender ? ' · ' + v.gender : ''}` })), (v) => {
              apply({ voiceName: v });
              hearVoice(v);
            }),
          ),
        ),
      ];
    },

    access: () => [
      group(
        'Accounts',
        row('Claude accounts', 'The logins your sessions run as, and which one new sessions use.', go('Open', () => openAccounts())),
        S.remote ? null : row('Tools', 'What your sessions can use: tools on this PC and the ones you connected on Loop Cloud.', go('Open', () => openTools())),
      ),
      S.remote && !S.switches.phone && !S.switches.servers
        ? null
        : group(
            'Reaching Loop from elsewhere',
            S.remote ? null : row('From a browser anywhere', 'Open this Loop from a tablet or another computer.', go('Open', () => openInternet())),
            S.switches.phone ? row('Your phone', 'Work on these sessions from the Loop app.', go('Open', () => openPhone())) : null,
            S.switches.servers ? row('Servers', 'Run sessions on another machine.', go('Open', () => openServers())) : null,
          ),
    ],

    updates: () => {
      const u = S.update || {};
      const s = S.config.settings;
      let line = 'You have the newest Loop.';
      let act = null;
      let tone = 'ok';
      if (st.checking) {
        line = 'Looking for a newer Loop…';
        tone = 'busy';
      } else if (u.can === false) {
        line = u.why || 'This copy of Loop cannot update itself.';
        tone = 'quiet';
        act = /download/i.test(line) ? h('button.btn.small', { type: 'button', onclick: () => deck.updatePage() }, 'Open the download page') : null;
      } else if (u.status === 'ready') {
        line = `Loop ${u.next} is downloaded and ready to install.`;
        tone = 'new';
        act = h('button.btn.primary', { type: 'button', onclick: () => restartToUpdate() }, icon('refresh'), 'Restart to update');
      } else if (u.status === 'downloading') {
        line = `Downloading Loop ${u.next}: ${u.percent || 0}%`;
        tone = 'busy';
        act = h('div.set-bar', { role: 'progressbar', 'aria-valuenow': String(u.percent || 0), 'aria-valuemin': '0', 'aria-valuemax': '100' }, h('i', { style: `width:${Math.max(2, u.percent || 0)}%` }));
      } else if (u.status === 'available') {
        line = `Loop ${u.next} is out.`;
        tone = 'new';
        act = h('button.btn.primary', { type: 'button', onclick: () => getUpdate().then(paint) }, icon('download'), 'Download');
      } else if (u.status === 'error') {
        line = u.error || 'The update could not be checked.';
        tone = 'bad';
      }
      const check = async () => {
        st.checking = true;
        paint();
        try {
          const now = await deck.updateCheck();
          if (now) S.update = now;
        } catch {
          // said on the next line, from the state the app keeps
        }
        st.checking = false;
        paint();
        renderStatus();
      };
      return [
        h(
          'div.set-update',
          { class: tone },
          h('div.set-update-mark', {}, icon(tone === 'new' ? 'download' : tone === 'bad' ? 'x' : tone === 'busy' ? 'refresh' : 'check')),
          h('div.set-update-text', {}, h('b', {}, `Loop ${u.version || ''}`.trim()), h('small', { role: 'status' }, line)),
          h('div.set-update-act', {}, act, u.can === false || u.status === 'downloading' ? null : h('button.btn.small', { type: 'button', disabled: st.checking, onclick: check }, icon('refresh'), 'Check for updates')),
        ),
        group(
          'How updates arrive',
          row('Download updates by themselves', 'A new version is fetched in the background. You choose when to restart into it.', toggle('Download updates by themselves', s.autoUpdate !== false, (on) => (apply({ autoUpdate: on }), deck.updateAuto(on)))),
        ),
      ];
    },
  };

  function paint() {
    if (!box.isConnected) return;
    const list = settingsSections(st.voices);
    if (!list.some((x) => x.key === st.at)) st.at = list[0].key;
    openSettings.last = st.at;
    const now = list.find((x) => x.key === st.at);
    put(
      nav,
      list.map((x) =>
        h(
          'button.set-tab',
          {
            type: 'button',
            class: x.key === st.at ? 'on' : '',
            style: `--tone:${SET_TONES[x.tone]}`,
            'aria-current': x.key === st.at ? 'page' : null,
            onclick: () => {
              st.at = x.key;
              paint();
              body.scrollTop = 0;
            },
          },
          h('span.set-ico', {}, icon(x.icon)),
          x.label,
          x.key === 'updates' && S.update && (S.update.status === 'ready' || S.update.status === 'available') ? h('span.set-dot', { title: 'A newer Loop is out' }) : null,
        ),
      ),
    );
    version.textContent = S.update && S.update.version ? `Loop ${S.update.version}` : 'Loop';
    put(body, h('header.set-head', { style: `--tone:${SET_TONES[now.tone]}` }, h('span.set-ico.big', {}, icon(now.icon)), h('div', {}, h('h3', {}, now.label), h('p', {}, now.about))), sections[st.at]());
  }

  paint();
  box.focus();
  // The voices are asked of the helper that speaks: the section appears once they are known.
  (S.switches.voice ? deck.voiceState() : Promise.resolve(null))
    .then((v) => (v && v.node ? deck.voiceVoices() : []))
    .then((list) => {
      st.voices = list || [];
      if (st.voices.length) paint();
    })
    .catch(() => {});
  // A download moves by itself: the Updates section follows it while it is in view.
  const follow = setInterval(() => {
    if (!box.isConnected) return clearInterval(follow);
    if (st.at === 'updates' && !st.checking && S.update && S.update.status === 'downloading') paint();
  }, 1000);
}
