/* global deck, S, h, $, icon, menu, closeOverlay, formDialog, confirmBox, toast, projectTitle */
// Tools and environments. A tool (an MCP server) is connected to Loop once.
// Tools are grouped into environments, and a project is given one: its sessions
// then get those tools through a single entry, "loop". The work is in
// src/main/hub.js; this file is the window onto it.

let toolsEnv = ''; // the environment being looked at

function wireTools() {
  const take = (s) => {
    S.hub = s;
    if (document.querySelector('.dialog.tools')) paintTools();
  };
  deck.onHub(take);
  deck.hubState().then(take);
}

const hubEnv = (id) => ((S.hub && S.hub.envs) || []).find((e) => e.id === id);

// What a project's sessions get: its own choice, or the default.
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
    toast(`Sessions in ${projectTitle(p)} opened from now on ${id === 'none' ? 'get no tool environment' : 'get these tools'}. Open ones can already find them with loop_find_tools.`);
  };
  const def = hubEnv(hub.defaultEnv);
  menu(x, y, [
    { heading: `Tools for ${projectTitle(p)}` },
    ...hub.envs.map((e) => ({ label: e.name, hint: `${e.servers.length} tool${e.servers.length === 1 ? '' : 's'}`, checked: own === e.id, run: () => set(e.id) })),
    hub.envs.length ? '-' : null,
    { label: def ? `Follow the default (${def.name})` : 'Follow the default (none set)', checked: !own, run: () => set('') },
    { label: 'No environment for this project', checked: own === 'none', run: () => set('none') },
    '-',
    { label: 'Tools and environments…', icon: 'gear', run: openTools },
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
}

function paintTools() {
  const box = document.querySelector('.dialog.tools');
  if (!box) return;
  const hub = S.hub || { servers: [], envs: [] };
  if (!hubEnv(toolsEnv)) toolsEnv = hub.envs[0] ? hub.envs[0].id : '';
  const env = hubEnv(toolsEnv);
  const keep = box.querySelector('.tools-scroll') ? box.querySelector('.tools-scroll').scrollTop : 0;

  const toolRow = (s) =>
    h(
      'div.tool-row',
      {},
      h('span.tool-dot', { class: s.error ? 'bad' : s.up ? 'ok' : '', title: s.error || (s.up ? 'Connected' : 'Not started yet. It starts when a session first needs it.') }),
      h(
        'div.grow',
        {},
        h('b', {}, s.name, s.machineOnly ? h('span.tool-tag', { title: 'Its program or address exists on this PC only, so it is not carried to your other machines.' }, 'This PC only') : null),
        h('small', { class: s.error ? 'bad' : '' }, s.error || `${s.kind === 'http' ? s.url : [s.command, ...s.args].join(' ')}${s.tools !== null ? ` · ${s.tools} tool${s.tools === 1 ? '' : 's'}` : ''}`),
      ),
      h(
        'button.btn.small',
        {
          type: 'button',
          onclick: async (e) => {
            const b = e.currentTarget;
            b.disabled = true;
            b.textContent = 'Testing…';
            const r = await deck.hubTest(s.key);
            toast(r.ok ? `${s.name} works: ${r.tools.length} tool${r.tools.length === 1 ? '' : 's'}.` : `${s.name}: ${r.error}`, !r.ok);
          },
        },
        'Test',
      ),
      h('button.btn.small', { type: 'button', onclick: () => editTool(s) }, 'Edit'),
      h(
        'button.btn.small',
        {
          type: 'button',
          onclick: async () => {
            const ok = await confirmBox({ title: `Disconnect ${s.name}?`, body: 'It is removed from Loop and from every environment. Nothing else on this PC changes.', confirm: 'Disconnect', danger: true });
            if (ok) await deck.hubRemoveServer(s.key);
            openTools();
          },
        },
        'Remove',
      ),
    );

  const envPanel = env
    ? h(
        'div.env-panel',
        {},
        h(
          'div.env-tools',
          {},
          hub.servers.length
            ? hub.servers.map((s) => {
                const box2 = h('input', {
                  type: 'checkbox',
                  checked: env.servers.includes(s.key),
                  onchange: () => deck.hubSaveEnv({ id: env.id, name: env.name, servers: box2.checked ? [...env.servers, s.key] : env.servers.filter((k) => k !== s.key) }),
                });
                return h('label.env-tool', {}, box2, h('span', {}, s.name));
              })
            : h('p.dim', {}, 'Connect a tool below, then tick it here.'),
        ),
        h(
          'label.field.inline',
          {},
          (() => {
            const c = h('input', { type: 'checkbox', checked: env.only, onchange: () => deck.hubSaveEnv({ id: env.id, name: env.name, only: c.checked }) });
            return c;
          })(),
          h('span', {}, 'Sessions get only these tools', h('small', {}, "Tools set up in the agent's own settings are left out, so the environment decides. Loop's memory stays.")),
        ),
        h(
          'label.field.inline',
          {},
          (() => {
            const c = h('input', { type: 'checkbox', checked: hub.defaultEnv === env.id, onchange: () => deck.hubDefaultEnv(c.checked ? env.id : '') });
            return c;
          })(),
          h('span', {}, 'Use for every project that has not chosen one'),
        ),
        h(
          'div.env-acts',
          {},
          h(
            'button.btn.small',
            {
              type: 'button',
              onclick: async () => {
                const v = await formDialog({ title: 'Rename environment', fields: [{ key: 'name', label: 'Name', value: env.name }] });
                if (v && v.name.trim()) await deck.hubSaveEnv({ id: env.id, name: v.name.trim() });
                openTools();
              },
            },
            'Rename',
          ),
          h(
            'button.btn.small',
            {
              type: 'button',
              onclick: async () => {
                const ok = await confirmBox({ title: `Delete the ${env.name} environment?`, body: 'Its tools stay connected to Loop. Projects that used it go back to the default.', confirm: 'Delete', danger: true });
                if (ok) await deck.hubRemoveEnv(env.id);
                openTools();
              },
            },
            'Delete',
          ),
        ),
      )
    : h('p.dim', {}, 'An environment is a named set of tools, such as Personal or Client work. Make one, tick its tools, then give it to a project from the project\'s menu.');

  const carry = h('input', {
    type: 'checkbox',
    role: 'switch',
    checked: Boolean(hub.carry),
    disabled: !hub.signedIn,
    onchange: async () => {
      if (carry.checked) {
        const ok = await confirmBox({
          title: 'Carry tools to your other machines?',
          body: 'Your environments, and the tools that work anywhere, are kept in Loop Cloud together with their keys and tokens, sealed so the database alone cannot read them. Every machine signed in to your Loop Cloud account gets them. Tools marked This PC only stay here.',
          confirm: 'Carry them',
        });
        if (!ok) return openTools();
      }
      await deck.hubCarry(carry.checked);
      S.hub = await deck.hubState();
      openTools();
    },
  });

  box.replaceChildren(
    h('h2', {}, 'Tools and environments'),
    h('p.lead', {}, 'Connect a tool to Loop once. Group tools into environments, and give each project one: its sessions get those tools through a single entry, whichever agent or account they run on.'),
    h(
      'div.tools-scroll',
      {},
      h('h3', {}, 'Environments'),
      h(
        'div.env-tabs',
        {},
        hub.envs.map((e) =>
          h(
            'button',
            {
              type: 'button',
              class: e.id === toolsEnv ? 'on' : '',
              onclick: () => {
                toolsEnv = e.id;
                paintTools();
              },
            },
            e.name,
            h('i', {}, String(e.servers.length)),
          ),
        ),
        h(
          'button.add',
          {
            type: 'button',
            onclick: async () => {
              const v = await formDialog({ title: 'New environment', body: 'A named set of tools, such as Personal or Client work.', fields: [{ key: 'name', label: 'Name', value: '', placeholder: 'Personal' }], confirm: 'Create' });
              if (v && v.name.trim()) {
                const r = await deck.hubSaveEnv({ name: v.name.trim(), servers: [] });
                if (r.ok) toolsEnv = r.id;
                else toast(r.error, true);
              }
              openTools();
            },
          },
          icon('plus'),
          'New environment',
        ),
      ),
      envPanel,
      h('h3', {}, 'Connected tools'),
      hub.servers.length ? h('div.tool-list', {}, hub.servers.map(toolRow)) : h('p.dim', {}, 'No tools yet. Connect one, or bring in the ones Claude Code already has on this PC.'),
      h(
        'div.env-acts',
        {},
        h('button.btn.primary.small', { type: 'button', onclick: () => editTool(null) }, icon('plus'), 'Connect a tool'),
        h(
          'button.btn.small',
          {
            type: 'button',
            onclick: async () => {
              const r = await deck.hubImport();
              toast(r.added ? `Brought in ${r.added} tool${r.added === 1 ? '' : 's'} from Claude Code. Tick them in an environment to use them.` : 'Loop already has every tool Claude Code is set up with here.');
            },
          },
          'Bring in the ones Claude Code has',
        ),
      ),
      h('h3', {}, 'Your other machines'),
      h(
        'label.field.inline.carry',
        {},
        carry,
        h(
          'span',
          {},
          'Carry my environments and tools to my other machines',
          h('small', {}, hub.signedIn ? 'Through your Loop Cloud account. Connect a tool here and Laptop 2 and Server 1 have it within half a minute.' : 'Sign in to Loop Cloud first (Memory panel), then turn this on.'),
        ),
      ),
    ),
    h('div.actions', {}, h('button.btn', { type: 'button', onclick: closeOverlay }, 'Done')),
  );
  box.querySelector('.tools-scroll').scrollTop = keep;
}

// Connect a tool, or change one. Keys already stored are shown by name only:
// leaving a name on its own line keeps the value Loop has.
async function editTool(s) {
  const v = await formDialog({
    title: s ? `Edit ${s.name}` : 'Connect a tool',
    body: 'A tool is an MCP server: a program that runs on this PC, or a web address.',
    wide: true,
    confirm: s ? 'Save' : 'Connect',
    fields: [
      { key: 'name', label: 'Name', value: s ? s.name : '', placeholder: 'GitHub' },
      {
        key: 'kind',
        label: 'It is',
        type: 'select',
        value: s ? s.kind : 'stdio',
        options: [
          { value: 'stdio', label: 'A program on this PC' },
          { value: 'http', label: 'A web address' },
        ],
      },
      { key: 'command', label: 'Program: the command that starts it', value: s && s.kind === 'stdio' ? [s.command, ...s.args.map((a) => (/\s/.test(a) ? `"${a}"` : a))].join(' ') : '', mono: true, placeholder: 'npx -y @modelcontextprotocol/server-github' },
      { key: 'env', label: 'Program: its keys, one NAME=value per line', type: 'textarea', value: s ? s.envNames.join('\n') : '', mono: true, placeholder: 'GITHUB_TOKEN=…', hint: s && s.envNames.length ? 'Stored values are not shown. A name on its own keeps its value; NAME=value replaces it.' : '' },
      { key: 'url', label: 'Web address', value: s && s.kind === 'http' ? s.url : '', mono: true, placeholder: 'https://mcp.example.com/mcp' },
      { key: 'headers', label: 'Web address: its headers, one Name: value per line', type: 'textarea', value: s ? s.headerNames.join('\n') : '', mono: true, placeholder: 'Authorization: Bearer …' },
      { key: 'machineOnly', label: 'This PC only: do not carry it to my other machines', type: 'checkbox', value: s ? s.machineOnly : false },
    ],
  });
  if (!v) return openTools();
  const r = await deck.hubSaveServer({ ...v, key: s ? s.key : undefined });
  if (!r.ok) {
    toast(r.error, true);
    return openTools();
  }
  await openTools();
  const t = await deck.hubTest(r.key);
  toast(t.ok ? `${v.name} is connected: ${t.tools.length} tool${t.tools.length === 1 ? '' : 's'}. Tick it in an environment to use it.` : `${v.name} is saved, but did not answer: ${t.error}`, !t.ok);
}
