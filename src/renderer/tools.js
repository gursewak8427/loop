/* global deck, S, h, $, icon, menu, closeOverlay, toast, projectTitle, cloudSignIn */
// Tools. Tools and environments are set up in one place, the Loop Cloud
// website. Here there is only: which environment this PC's sessions use, a
// Refresh button, and a say-so before a program the cloud names runs on this PC.
// The work is in src/main/hub.js.

function wireTools() {
  const take = (s) => {
    S.hub = s;
    if (document.querySelector('.dialog.tools')) paintTools();
  };
  deck.onHub(take);
  deck.hubState().then(take);
}

const hubEnv = (id) => ((S.hub && S.hub.envs) || []).find((e) => e.id === id);

// What a project's sessions get: its own choice, or this PC's default.
function toolsEnvOf(dir) {
  const hub = S.hub || { projectEnv: {}, envs: [] };
  const own = hub.projectEnv[dir];
  if (own === 'none') return null;
  return hubEnv(own) || hubEnv(hub.defaultEnv) || null;
}

function toolsLabel(dir) {
  const e = toolsEnvOf(dir);
  return e ? e.name : 'none';
}

// From a project's menu: which environment its sessions work in.
function projectToolsMenu(x, y, p) {
  const hub = S.hub || { envs: [], projectEnv: {} };
  const own = hub.projectEnv[p.dir] || '';
  const set = async (id) => {
    await deck.hubProjectEnv(p.dir, id);
    toast(id === 'none' ? `Sessions in ${projectTitle(p)} get no tools from Loop.` : `Sessions opened in ${projectTitle(p)} from now on get these tools.`);
  };
  const def = hubEnv(hub.defaultEnv);
  menu(x, y, [
    { heading: `Tools for ${projectTitle(p)}` },
    ...hub.envs.map((e) => ({ label: e.name, hint: `${e.servers.length} tool${e.servers.length === 1 ? '' : 's'}`, checked: own === e.id, run: () => set(e.id) })),
    hub.envs.length ? '-' : null,
    { label: def ? `Same as this PC (${def.name})` : 'Same as this PC (none)', checked: !own, run: () => set('') },
    { label: 'No tools for this project', checked: own === 'none', run: () => set('none') },
    '-',
    { label: 'Tools…', icon: 'gear', run: openTools },
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
  refreshTools(true);
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

function paintTools() {
  const box = document.querySelector('.dialog.tools');
  if (!box) return;
  const hub = S.hub || { servers: [], envs: [], projectEnv: {} };
  const tool = (key) => hub.servers.find((s) => s.key === key);

  const head = h(
    'div.tools-head',
    {},
    h('h2', {}, 'Tools'),
    h('button.tools-refresh', { type: 'button', class: toolsBusy ? 'busy' : '', title: 'Get the newest tools and environments from Loop Cloud', 'aria-label': 'Refresh', disabled: toolsBusy, onclick: () => refreshTools() }, icon('refresh')),
  );

  if (!hub.signedIn) {
    box.replaceChildren(
      head,
      h('p.lead', {}, 'Tools and environments are set up once, on loop.prismaple.com, and every machine you sign in on gets them. Sign in to Loop Cloud to start.'),
      h('div.actions', {}, h('button.btn', { type: 'button', onclick: closeOverlay }, 'Close'), h('button.btn.primary', { type: 'button', onclick: () => (closeOverlay(), cloudSignIn('')) }, 'Sign in to Loop Cloud')),
    );
    return;
  }

  const pick = h(
    'select',
    {
      onchange: async () => {
        await deck.hubDefaultEnv(pick.value);
        toast(pick.value ? `Sessions opened on this PC from now on get the ${hubEnv(pick.value).name} tools.` : 'Sessions on this PC get no tools from Loop.');
      },
    },
    h('option', { value: '', selected: !hub.defaultEnv }, 'None'),
    hub.envs.map((e) => h('option', { value: e.id, selected: hub.defaultEnv === e.id }, `${e.name} (${e.servers.length} tool${e.servers.length === 1 ? '' : 's'})`)),
  );
  const env = hubEnv(hub.defaultEnv);
  const asking = hub.servers.filter((s) => s.ask && hub.envs.some((e) => e.servers.includes(s.key)));

  const row = (s) =>
    h(
      'div.tool-row',
      {},
      h('span.tool-dot', { class: !s.here ? '' : s.error && !s.ask ? 'bad' : s.up ? 'ok' : '' }),
      h(
        'div.grow',
        {},
        h('b', {}, s.name),
        h(
          'small',
          { class: s.error && !s.ask && s.here ? 'bad' : '' },
          !s.here ? `Lives on ${s.on}, so it is skipped on this PC.` : s.ask ? 'A program. It runs on this PC only once you allow it.' : s.error || (s.up ? `Connected · ${s.tools} tool${s.tools === 1 ? '' : 's'}` : 'Starts when a session first needs it.'),
        ),
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
                toast(t.ok ? `${s.name} is allowed and works: ${t.tools.length} tools.` : `${s.name} is allowed, but did not answer: ${t.error}`, !t.ok);
              },
            },
            'Allow on this PC',
          )
        : s.here
          ? h(
              'button.btn.small',
              {
                type: 'button',
                onclick: async (e) => {
                  e.currentTarget.disabled = true;
                  const t = await deck.hubTest(s.key);
                  toast(t.ok ? `${s.name} works: ${t.tools.length} tool${t.tools.length === 1 ? '' : 's'}.` : `${s.name}: ${t.error}`, !t.ok);
                },
              },
              'Test',
            )
          : null,
    );

  const parts = [
    head,
    h('p.lead', {}, 'Set up tools and environments once on Loop Cloud. Here you only choose which environment this PC uses.'),
    hub.note ? h('p.tools-warn', {}, `Could not reach Loop Cloud just now (${hub.note}). Showing what this PC had last.`) : null,
    h(
      'div.tools-scroll',
      {},
      hub.envs.length
        ? h('label.field.tools-pick', {}, h('span', {}, 'Environment for sessions on this PC'), pick, h('small', {}, 'A project can have its own: right-click the project and choose Tools.'))
        : h('div.tools-empty', {}, h('b', {}, 'No environments yet'), h('p', {}, 'Open Loop Cloud, connect your tools, and group them into an environment such as Personal or Client work. Then press Refresh here.')),
      asking.length ? h('p.tools-warn', {}, `${asking.length} program${asking.length === 1 ? '' : 's'} from Loop Cloud ${asking.length === 1 ? 'is' : 'are'} waiting for your say-so before running on this PC.`) : null,
      env
        ? h('div', {}, h('h3', {}, `In ${env.name}`), env.servers.length ? h('div.tool-list', {}, env.servers.map(tool).filter(Boolean).map(row)) : h('p.dim', {}, 'This environment has no tools yet. Tick some on Loop Cloud.'))
        : null,
      !env && asking.length ? h('div', {}, h('h3', {}, 'Waiting for you'), h('div.tool-list', {}, asking.map(row))) : null,
    ),
    h(
      'div.actions.tools-acts',
      {},
      h(
        'button.btn',
        {
          type: 'button',
          title: 'Sends the MCP servers Claude Code is set up with on this PC to your Loop Cloud, so you do not type them again',
          onclick: async (e) => {
            const b = e.currentTarget;
            b.disabled = true;
            const r = await deck.hubImport();
            b.disabled = false;
            toast(r.ok ? (r.added ? `Sent ${r.added} tool${r.added === 1 ? '' : 's'} from this PC to Loop Cloud. Group them into an environment there.` : 'Loop Cloud already has every tool this PC is set up with.') : r.error, !r.ok);
          },
        },
        "Send this PC's tools to Loop Cloud",
      ),
      h('span.grow'),
      h('button.btn', { type: 'button', onclick: closeOverlay }, 'Done'),
      h('button.btn.primary', { type: 'button', onclick: () => deck.hubSite() }, 'Set up on Loop Cloud'),
    ),
  ];
  box.replaceChildren(...parts.filter(Boolean)); // an absent part is null, which the page would print
}
