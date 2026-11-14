/* global TOOL_CATALOG, TOOL_PROGRAMS, deck, S, h, $, icon, menu, closeOverlay, confirmBox, toast, projectTitle, projectByDir, cloudSignIn */
// Tools. Two places a tool can come from, shown as two tabs:
//   Loop Cloud  every tool connected on the website, which is the only place
//               a tool is added with a form. All of them are listed here,
//               whatever environment they are in: an environment only says
//               which tools a project's sessions get. Here you choose the
//               environment this PC uses, allow programs, and sign in.
//   This PC     tools this PC already has. A new one is added with the agent's
//               own command (claude mcp add ...) and brought in here; Loop has
//               no form for it. Every session on this PC gets the ones switched on.
// The work is in src/main/hub.js.

let toolsTab = 'cloud'; // 'cloud' or 'pc'

function wireTools() {
  const take = (s) => {
    S.hub = s;
    if (document.querySelector('.dialog.tools')) paintTools();
  };
  deck.onHub(take);
  deck.hubState().then(take);
}

// "All tools" is not an environment made on Loop Cloud: it is every tool there is.
const ALL_TOOLS = '*';
const allTools = () => ({ id: ALL_TOOLS, name: 'All tools', servers: ((S.hub && S.hub.servers) || []).map((s) => s.key) });
const hubEnv = (id) => ((S.hub && S.hub.envs) || []).find((e) => e.id === id);

// What a project's sessions get from Loop Cloud: its own choice, or this PC's.
function toolsEnvOf(dir) {
  const hub = S.hub || { projectEnv: {}, envs: [] };
  const own = hub.projectEnv[dir];
  if (own === 'none') return null;
  return (own !== ALL_TOOLS && hubEnv(own)) || (own !== ALL_TOOLS && hubEnv(hub.defaultEnv)) || allTools();
}

function toolsLabel(dir) {
  const e = toolsEnvOf(dir);
  return e ? e.name : 'none';
}

// From a project's menu: which environment its sessions work in.
function projectToolsMenu(x, y, p) {
  const hub = S.hub || { envs: [], projectEnv: {} };
  const set = async (id, name) => {
    await deck.hubProjectEnv(p.dir, id);
    toast(`Sessions opened in ${projectTitle(p)} from now on get ${id === ALL_TOOLS ? 'all tools' : `the ${name} tools`}.`);
  };
  // One short list: All tools, then the environments. The tick is on what the project gets now.
  const now = toolsEnvOf(p.dir);
  const all = allTools();
  menu(x, y, [
    { heading: `Tools for ${projectTitle(p)}` },
    { label: 'All tools', hint: toolCount(all.servers.length + (hub.local || []).filter((s) => s.on).length), checked: Boolean(now) && now.id === ALL_TOOLS, run: () => set(ALL_TOOLS) },
    ...hub.envs.map((e) => ({ label: e.name, hint: toolCount(e.servers.length), checked: Boolean(now) && now.id === e.id, run: () => set(e.id, e.name) })),
  ]);
}

async function openTools() {
  closeOverlay();
  const box = h('form.dialog.wide.tools', { onsubmit: (e) => e.preventDefault() });
  const scrim = h('div.scrim.dim', { onmousedown: (e) => e.target === scrim && closeOverlay() }, box);
  $('#overlay').append(scrim);
  box.addEventListener('keydown', (e) => e.key === 'Escape' && closeOverlay());
  S.hub = await deck.hubState();
  paintTools();
  if (S.hub.signedIn) refreshTools(true);
}

let toolsBusy = false;
async function refreshTools(quiet) {
  if (toolsBusy) return;
  toolsBusy = true;
  paintTools();
  const r = await deck.hubRefresh();
  toolsBusy = false;
  S.hub = r.state;
  paintTools();
  if (quiet !== true) toast(r.ok ? (r.changed ? 'Tools are up to date: new changes taken from Loop Cloud.' : 'Tools are up to date.') : r.error, !r.ok);
}

const toolCount = (n) => `${n} tool${n === 1 ? '' : 's'}`;

// A tool's initials on a colour of its own, as on the website.
function toolFace(name) {
  const hue = [...String(name)].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 360, 7);
  const w = String(name).trim().split(/[\s._-]+/).filter(Boolean);
  const letters = ((w[0] || '?')[0] + (w[1] ? w[1][0] : (w[0] || '').slice(1, 2))).toUpperCase();
  return h('span.tool-face', { style: `--h:${hue}`, 'aria-hidden': 'true' }, letters);
}

// A service from the list is known by its address, whatever it was named.
const toolUrlKey = (u) => {
  try {
    const x = new URL(u);
    return (x.host + x.pathname).replace(/\/+$/, '').toLowerCase();
  } catch {
    return '';
  }
};
const toolProgKey = (c) => String(c || '').trim().replace(/\s+/g, ' ').toLowerCase();
const catalogOf = (s) =>
  (s && s.kind === 'http' && TOOL_CATALOG.find((c) => toolUrlKey(c.url) === toolUrlKey(s.url))) || (s && s.kind === 'stdio' && s.command && TOOL_PROGRAMS.find((c) => toolProgKey(c.command) === toolProgKey(s.command))) || null;

// A service's own mark on its brand colour. One with no mark gets its initials.
function brandFace(c, name) {
  if (!c || !c.icon) return toolFace(c ? c.name : name);
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(c.color.slice(i, i + 2), 16));
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', c.icon);
  svg.append(path);
  return h('span.tool-face.mark', { style: `background:${c.color};color:${r * 0.299 + g * 0.587 + b * 0.114 > 150 ? '#10161b' : '#fff'}`, 'aria-hidden': 'true' }, svg);
}

const toolBtn = (name, label, run, danger) => h('button.tool-icon', { type: 'button', class: danger ? 'danger' : '', title: label, 'aria-label': label, onclick: run }, icon(name));

// The word "Test" until it has been tried; after that, what came of it.
function testBtn(s) {
  const words = { idle: 'Test', busy: 'Testing…', ok: 'Connected', bad: 'Failed' };
  const set = (state, tip) => {
    b.className = 'tool-test ' + state;
    b.textContent = words[state];
    b.title = tip;
  };
  const b = h('button', {
    type: 'button',
    'aria-label': 'Test ' + s.name,
    onclick: async () => {
      b.disabled = true;
      set('busy', 'Asking ' + s.name + ' for its tools');
      const t = await deck.hubTest(s.key);
      b.disabled = false;
      set(t.ok ? 'ok' : 'bad', t.ok ? toolCount(t.tools.length) + '. Click to test again.' : t.error + '. Click to try again.');
      toast(t.ok ? s.name + ' works: ' + toolCount(t.tools.length) + '.' : s.name + ': ' + t.error, !t.ok);
    },
  });
  if (s.error) set('bad', s.error + '. Click to try again.');
  else if (s.up) set('ok', 'Connected. Click to test again.');
  else set('idle', 'Check that ' + s.name + ' answers');
  return b;
}

// ---------- this PC ----------

function localTab(hub) {
  const list = hub.local || [];
  const row = (s) => {
    const sw = h('input', {
      type: 'checkbox',
      role: 'switch',
      checked: s.on,
      title: s.on ? `Sessions on this PC can use ${s.name}. Switch off to hide it from them.` : `${s.name} is hidden from sessions. Switch on to give it back.`,
      'aria-label': `Use ${s.name}`,
      onchange: () => deck.hubLocalOn(s.key, sw.checked),
    });
    return h(
      'div.tool-row',
      { class: s.on ? '' : 'off' },
      brandFace(catalogOf(s), s.name),
      h(
        'div.grow',
        {},
        h('b', {}, s.name, h('span.tool-dot', { class: s.error ? 'bad' : s.up ? 'ok' : '', title: s.error || (s.up ? 'Connected' : 'Starts when a session first needs it') })),
        h('small', { class: s.error && s.auth !== 'needed' ? 'bad' : 'mono' }, s.auth === 'needed' ? 'It asks you to sign in.' : s.error || (s.kind === 'http' ? s.url : s.command) + (s.tools !== null && !s.error ? ` · ${toolCount(s.tools)}` : '')),
        h('small.tool-notes', {}, [s.kind === 'stdio' ? (s.envNames.length ? `Keys: ${s.envNames.join(', ')}` : '') : s.auth === 'in' ? 'Signed in' : s.headerNames.length ? `Key: ${s.headerNames.join(', ')}` : '', s.dir ? `Only in ${projectByDir(s.dir) ? projectTitle(projectByDir(s.dir)) : 'one project'}` : ''].filter(Boolean).join(' · ')),
      ),
      s.auth === 'needed' ? h('button.btn.small.primary', { type: 'button', title: `Opens ${s.name}'s sign-in page in your browser`, onclick: (e) => signInTool(s, e) }, 'Sign in') : testBtn(s),
      s.auth === 'in' ? toolBtn('key', `Sign out of ${s.name}`, async () => (await deck.hubSignOut(s.key), toast(`Signed out of ${s.name}.`))) : null,
      toolBtn(
        'trash',
        `Remove ${s.name}`,
        async () => {
          const ok = await confirmBox({ title: `Remove ${s.name}?`, body: 'It is removed from Loop on this PC. Nothing else changes: if your agent has it in its own settings, it stays there.', confirm: 'Remove', danger: true });
          if (ok) await deck.hubRemoveLocal(s.key);
          openTools();
        },
        true,
      ),
      sw,
    );
  };
  return [
    h('p.lead', {}, "Tools that stay on this PC. Add one with your agent's own command, such as ", h('code', {}, 'claude mcp add'), ', then bring it in here so every session can use it, whichever agent it runs on. To add a tool with a form, use Loop Cloud.'),
    h(
      'div.tools-scroll',
      {},
      list.length
        ? h('div.tool-list', {}, list.map(row))
        : h('div.tools-empty', {}, h('b', {}, 'No tools on this PC yet'), h('p', {}, 'Bring in the ones Claude Code is already set up with, or add your tools on Loop Cloud.')),
    ),
    h(
      'div.actions.tools-acts',
      {},
      h(
        'button.btn',
        {
          type: 'button',
          title: 'Copies the MCP servers from Claude Code on this PC into this list, so your other agents can use them too. Nothing is removed from Claude Code.',
          onclick: async (e) => {
            const b = e.currentTarget;
            b.disabled = true;
            const r = await deck.hubImportLocal();
            b.disabled = false;
            toast(r.added ? `Brought in ${toolCount(r.added)} from Claude Code.` : 'Every tool Claude Code has on this PC is already here.');
          },
        },
        icon('import'),
        'Bring in from Claude Code',
      ),
      h('span.grow'),
      h('button.btn.primary', { type: 'button', onclick: closeOverlay }, 'Done'),
    ),
  ];
}

// Opens the tool's own sign-in page in the browser. The browser comes back to
// this PC when it is done, and the row turns to Connected by itself.
async function signInTool(s, e) {
  const b = e && e.currentTarget;
  if (b) b.disabled = true;
  const r = await deck.hubSignIn(s.key);
  if (b) b.disabled = false;
  toast(r.ok ? `Your browser is opening ${s.name}'s sign-in page. Come back here when you are done.` : `${s.name}: ${r.error}`, !r.ok);
}

// ---------- Loop Cloud ----------

function cloudTab(hub) {
  if (!hub.signedIn) {
    return [
      h('p.lead', {}, 'Tools set up once on loop.prismaple.com, such as your servers and online services. Every machine you sign in on gets them.'),
      h('div.tools-scroll', {}, h('div.tools-empty', {}, h('b', {}, 'Not signed in to Loop Cloud'), h('p', {}, 'Sign in to use the tools you set up there.'))),
      h('div.actions.tools-acts', {}, h('span.grow'), h('button.btn', { type: 'button', onclick: closeOverlay }, 'Done'), h('button.btn.primary', { type: 'button', onclick: () => (closeOverlay(), cloudSignIn('')) }, 'Sign in to Loop Cloud')),
    ];
  }
  const pick = h(
    'select',
    {
      onchange: async () => {
        await deck.hubDefaultEnv(pick.value);
        toast(pick.value ? `Sessions opened on this PC from now on get the ${hubEnv(pick.value).name} tools.` : 'Sessions opened on this PC from now on get all tools.');
      },
    },
    h('option', { value: '', selected: !hub.defaultEnv }, `All tools (${toolCount(hub.servers.length + (hub.local || []).filter((s) => s.on).length)})`),
    hub.envs.map((e) => h('option', { value: e.id, selected: hub.defaultEnv === e.id }, `${e.name} (${toolCount(e.servers.length)})`)),
  );
  const env = hubEnv(hub.defaultEnv) || allTools();
  const asking = hub.servers.filter((s) => s.ask && s.here);
  const envsOf = (key) => hub.envs.filter((e) => e.servers.includes(key));
  const row = (s) =>
    h(
      'div.tool-row',
      {},
      toolFace(s.name),
      h(
        'div.grow',
        {},
        h('b', {}, s.name, h('span.tool-dot', { class: !s.here ? '' : s.error && !s.ask ? 'bad' : s.up ? 'ok' : '' }), envsOf(s.key).map((e) => h('span.tool-env', { class: env && e.id === env.id ? 'here' : '', title: env && e.id === env.id ? `In ${e.name}, the environment sessions on this PC get` : `In the ${e.name} environment` }, e.name)), envsOf(s.key).length ? null : h('span.tool-env.none', { title: 'No session gets it yet. Put it in an environment on Loop Cloud.' }, 'In no environment')),
        h('small', { class: s.error && !s.ask && s.here ? 'bad' : '' }, !s.here ? `Lives on ${s.on}, so it is skipped on this PC.` : s.ask ? 'A program from Loop Cloud. It runs on this PC only once you allow it.' : s.signIn === 'needed' ? 'It asks you to sign in. The sign-in is kept in Loop Cloud.' : (s.error || (s.up ? toolCount(s.tools) : 'Connects when a session first needs it.')) + (s.git && !s.error ? ' · git in this environment signs in to GitHub through it' : '')),
      ),
      s.here && s.ask
        ? h(
            'button.btn.small.primary',
            {
              type: 'button',
              title: `Runs: ${[s.command, ...s.args].join(' ')}`,
              onclick: async () => {
                await deck.hubApprove(s.key);
                const t = await deck.hubTest(s.key);
                toast(t.ok ? `${s.name} is allowed and works: ${toolCount(t.tools.length)}.` : `${s.name} is allowed, but did not answer: ${t.error}`, !t.ok);
              },
            },
            'Allow on this PC',
          )
        : s.here && s.signIn === 'needed'
          ? h('button.btn.small.primary', { type: 'button', title: `Opens ${s.name}'s sign-in page in your browser. The sign-in is kept in Loop Cloud, for every machine.`, onclick: (e) => signInTool(s, e) }, 'Sign in')
          : s.here
            ? testBtn(s)
            : null,
    );
  return [
    h('p.lead', {}, 'Every tool you connected on Loop Cloud. Sessions get all tools, or only an environment if you choose one.'),
    hub.note ? h('p.tools-warn', {}, `Could not reach Loop Cloud just now (${hub.note}). Showing what this PC had last.`) : null,
    h(
      'div.tools-scroll',
      {},
      h('label.field.tools-pick', {}, h('span', {}, 'Tools for sessions on this PC'), pick, h('small', {}, 'All tools is everything: Loop Cloud, this PC, and what your agent already has. A project can have its own choice: right-click the project and choose Tools.')),
      asking.length ? h('p.tools-warn', {}, `${asking.length} program${asking.length === 1 ? '' : 's'} from Loop Cloud ${asking.length === 1 ? 'is' : 'are'} waiting for your say-so before running on this PC.`) : null,
      hub.servers.length
        ? h('div', {}, h('h3.tools-h', {}, 'Every tool on Loop Cloud', h('span.managed', { title: 'These tools are set up on loop.prismaple.com. To add, change or remove one, or to put one in an environment, use Set up on Loop Cloud.' }, icon('cloud'), 'Managed by Loop Cloud')), h('div.tool-list', {}, hub.servers.map(row)))
        : h('div.tools-empty', {}, h('b', {}, 'No tools on Loop Cloud yet'), h('p', {}, 'Connect your tools on Loop Cloud. Then press Refresh here.')),
    ),
    h('div.actions.tools-acts', {}, h('span.grow'), h('button.btn', { type: 'button', onclick: closeOverlay }, 'Done'), h('button.btn.primary', { type: 'button', onclick: () => deck.hubSite() }, 'Set up on Loop Cloud')),
  ];
}

function paintTools() {
  const box = document.querySelector('.dialog.tools');
  if (!box) return;
  const hub = S.hub || { servers: [], envs: [], projectEnv: {}, local: [] };
  const keep = box.querySelector('.tools-scroll') ? box.querySelector('.tools-scroll').scrollTop : 0;
  const tab = (id, label, n) =>
    h(
      'button',
      {
        type: 'button',
        role: 'tab',
        'aria-selected': String(toolsTab === id),
        class: toolsTab === id ? 'on' : '',
        onclick: () => {
          toolsTab = id;
          paintTools();
        },
      },
      label,
      h('i', {}, String(n)),
    );
  const env = hubEnv(hub.defaultEnv);
  const parts = [
    h(
      'div.tools-head',
      {},
      h('h2', {}, 'Tools'),
      toolsTab === 'cloud' && hub.signedIn
        ? h('button.tools-refresh', { type: 'button', class: toolsBusy ? 'busy' : '', title: 'Get the newest tools and environments from Loop Cloud', 'aria-label': 'Refresh', disabled: toolsBusy, onclick: () => refreshTools() }, icon('refresh'))
        : null,
    ),
    h('div.tools-tabs', { role: 'tablist' }, tab('cloud', 'Loop Cloud', hub.servers.length), tab('pc', 'This PC', (hub.local || []).filter((s) => s.on).length)),
    ...(toolsTab === 'pc' ? localTab(hub) : cloudTab(hub)),
  ];
  box.replaceChildren(...parts.filter(Boolean)); // an absent part is null, which the page would print
  const scroll = box.querySelector('.tools-scroll');
  if (scroll) scroll.scrollTop = keep;
}
