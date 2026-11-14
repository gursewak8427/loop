/* global deck, S, h, icon, put, menu, closeOverlay, toast, save, openPanel, ago, slash */
/* global projectTitle, sessionTitle, visibleSessions, tabFor, renderList, focusActive, createTab, closeTab, renderTabs, projectByDir */
'use strict';

// ---------- a project's team and its board ----------
// A team is a set of roles for one project on this PC, each held by one or more
// of its sessions. The board is the project's tickets in columns. With a project
// manager on the team, only that session adds, assigns and edits tickets; the
// others comment and move their own. You can always do everything.

// The roles Loop starts with. A role is global: its duty, its playbook ("guide")
// and who it hands work to ("next") are the same in every project. A project's
// team only says which roles it uses and which sessions hold them. The team is
// lean: the user talks to the CEO (business) and the CTO (tech), each hands
// tickets straight to the member who does the work, and nothing is relayed.
const ROLE_LIBRARY = [
  {
    key: 'ceo',
    title: 'CEO',
    duty: 'Front door for business: pricing, sales, marketing and priorities. Reports to the user.',
    guide:
      'Take business goals from the user. Do small jobs yourself. Give marketing and SEO work straight to those members as short tickets, and anything technical to the CTO as one ticket. Do not read code or manage technical tickets. Report to the user in the company report format.',
    next: ['marketing', 'seo', 'cto'],
    on: true,
  },
  {
    key: 'cto',
    title: 'CTO',
    duty: 'Front door for tech: architecture, technical decisions and the technical tickets. Reports to the user.',
    guide:
      'Take technical goals from the user. Read only the code you need and decide the approach. Do small jobs yourself; break bigger work into short tickets and give each straight to the developer, designer, QA or DevOps member. Review changes that touch data, security, payments or architecture. Report to the user in the company report format.',
    next: ['dev', 'design', 'qa', 'devops'],
    on: true,
  },
  {
    key: 'pm',
    title: 'Project manager',
    duty: 'Optional. Keeps the board tidy when the CEO or CTO asks; never relays work between members.',
    guide:
      'Act only when the CEO or CTO asks: tidy tickets, chase ones that sit still, and reply in 3 lines. Do not take goals from the user and do not pass work between members.',
    next: [],
    on: false,
  },
  {
    key: 'dev',
    title: 'Developer',
    duty: 'Builds what their tickets describe and replies with the commit.',
    guide:
      'Take your tickets one at a time. Follow the conventions already in the code and run the tests before you call it finished. Move the ticket to review with a one-line comment, then reply to whoever gave it to you in 3 lines plus the commit link. If blocked, mark it blocked with the reason and ask whoever gave it to you.',
    next: [],
    on: true,
  },
  {
    key: 'devops',
    title: 'DevOps engineer',
    duty: 'Owns builds, deployments, environments and monitoring.',
    guide:
      "Deploy through the project's normal path (git, then pull and build on the server), never by copying files. Ask the user before any production deploy. Check the service after every deploy and reply to whoever gave you the ticket in 3 lines: what went out and how you verified it.",
    next: [],
    on: false,
  },
  {
    key: 'qa',
    title: 'QA engineer',
    duty: 'Tests tickets in review and reports what failed and how to reproduce it.',
    guide:
      'Test what the ticket promises and the obvious ways it could break. Reply to whoever gave you the ticket in 3 lines: pass, or the exact steps that fail.',
    next: [],
    on: false,
  },
  {
    key: 'design',
    title: 'Designer',
    duty: 'Owns the look and the flows: layouts, components and copy on screen.',
    guide:
      'Work out the flow and layout before any detail, reuse the components the project already has, and write the on-screen copy. Leave the result where the developer can use it and reply in 3 lines.',
    next: [],
    on: false,
  },
  {
    key: 'seo',
    title: 'SEO specialist',
    duty: 'Owns search visibility: keywords, page structure, metadata and technical SEO checks.',
    guide:
      'Work from real search demand. Write each finding as a specific change to a specific page. Changes that need code go back to the CEO as one short ticket for the CTO. Reply in 3 lines.',
    next: [],
    on: false,
  },
  {
    key: 'marketing',
    title: 'Marketing',
    duty: 'Owns positioning, campaigns and launch copy.',
    guide:
      'Start from who the customer is and what they get. Write copy that matches what the product does today. Never send anything to customers without the user saying yes. Reply to the CEO in 3 lines plus the file link.',
    next: [],
    on: true,
  },
];

const COLUMNS = [
  ['todo', 'To do'],
  ['doing', 'In progress'],
  ['review', 'Review'],
  ['blocked', 'Blocked'],
  ['done', 'Done'],
];

const roleLib = () => S.config.roles || [];
const roleDef = (key) => roleLib().find((r) => r.key === key) || null;
const cleanRole = ({ key, title, duty, guide, next, manages, edited }) => ({
  key,
  title,
  duty: duty || '',
  guide: guide || '',
  next: next || [],
  ...(manages ? { manages: true } : {}),
  ...(edited ? { edited: true } : {}),
});

// Roles you have not edited follow Loop's own wording; the ones you edited or added stay yours.
function seedRoles() {
  const saved = S.config.roles || [];
  const fromTeams = Object.values(S.config.projectTeam || {}).flatMap((t) => t.roles || []);
  const out = ROLE_LIBRARY.map((d) => {
    const mine = saved.find((r) => r.key === d.key);
    return mine && mine.edited ? cleanRole(mine) : cleanRole(d);
  });
  for (const r of [...saved, ...fromTeams]) if (!out.some((x) => x.key === r.key)) out.push(cleanRole({ ...r, edited: true }));
  S.config.roles = out;
  // Sessions read the roles from the saved settings, so new wording has to be saved, not only shown.
  if (JSON.stringify(out) !== JSON.stringify(saved.map(cleanRole))) {
    refreshRoleTexts();
    save();
  }
}

// A project's team, with each role as it is defined globally.
const teamOf = (dir) => {
  const t = (S.config.projectTeam || {})[dir];
  return t ? { ...t, roles: t.roles.map((r) => roleDef(r.key) || r) } : null;
};
const roleOf = (dir, sessionId) => {
  const t = teamOf(dir);
  return t ? t.roles.find((r) => r.key === t.members[sessionId]) || null : null;
};
const managerOf = (p) => {
  const t = teamOf(p.dir);
  if (!t) return null;
  const id = Object.keys(t.members).find((sid) => t.roles.some((r) => r.key === t.members[sid] && r.manages));
  return (id && p.sessions.find((s) => s.id === id)) || null;
};

// The one line teammates see next to a session. The full playbook reaches the
// session itself through role_brief.
function roleText(role, hasManager) {
  const rule = role.manages
    ? ''
    : hasManager
      ? ' The project manager maintains the board: comment on any ticket, move the ones assigned to you, and ask the manager for anything else.'
      : '';
  return `${role.title}: ${role.duty}${rule}`.slice(0, 600);
}

// Bring every member's line up to date after a role or a team changed.
function refreshRoleTexts() {
  for (const dir of Object.keys(S.config.projectTeam || {})) {
    const t = teamOf(dir);
    const hasManager = Object.values(t.members).some((k) => t.roles.some((r) => r.key === k && r.manages));
    // The names go along, so a member that is not running can still be named to the others.
    const stored = S.config.projectTeam[dir];
    const p = projectByDir(dir);
    const names = {};
    for (const id of Object.keys(t.members)) {
      const role = t.roles.find((r) => r.key === t.members[id]);
      if (role) S.config.sessionRole[id] = roleText(role, hasManager);
      const s = p && p.sessions.find((x) => x.id === id);
      names[id] = s ? sessionTitle(s) : (stored.names || {})[id] || (role ? role.title : '');
    }
    stored.names = names;
  }
}

// A member renamed or first seen since the team was saved: keep the team's names current.
function syncTeamNames() {
  if (!S.config || !S.config.sessionRole) return;
  const teams = S.config.projectTeam || {};
  const before = JSON.stringify(Object.values(teams).map((t) => t.names));
  refreshRoleTexts();
  if (JSON.stringify(Object.values(teams).map((t) => t.names)) !== before) save();
}

// Say something to a session as soon as it is free to hear it.
async function tellWhenIdle(sessionId, text) {
  for (let i = 0; i < 300; i++) {
    const tab = tabFor(sessionId);
    if (!tab || tab.exited) return; // closed: it gets the current team when it next starts
    const lv = S.live.get(sessionId);
    if (lv && lv.status === 'idle') return slash(tab, text.replace(/\s+/g, ' '));
    await new Promise((r) => setTimeout(r, 2000));
  }
}

const ROLE_TOLD = 'Call role_brief for how the role works and who you hand work to, then team_info and task_list, and carry on in that role.';

// ---------- what a role knows, for every project ----------

function openRoleEdit(key, back) {
  const role = roleDef(key);
  if (!role) return;
  const builtIn = ROLE_LIBRARY.find((r) => r.key === key);
  const title = h('input', { type: 'text', value: role.title });
  const duty = h('input', { type: 'text', value: role.duty });
  const guide = h('textarea', { value: role.guide, placeholder: 'How this role works: what it does first, what it never does, what it checks before it calls something done.' });
  const next = new Set(role.next);
  const others = roleLib().filter((r) => r.key !== key);
  const leave = () => {
    closeOverlay();
    if (back) back();
    else focusActive();
  };
  const store = (r) => {
    S.config.roles = roleLib().map((x) => (x.key === key ? r : x));
    refreshRoleTexts();
    save();
    renderList();
    leave();
  };
  const box = h(
    'form.dialog.wide.team',
    {
      onsubmit: (e) => {
        e.preventDefault();
        const name = title.value.trim().slice(0, 40);
        if (!name) return toast('The role needs a name.', true);
        if (others.some((r) => r.title.toLowerCase() === name.toLowerCase())) return toast('Another role already has that name.', true);
        store(cleanRole({ ...role, title: name, duty: duty.value.trim().slice(0, 300), guide: guide.value.trim().slice(0, 2000), next: others.filter((r) => next.has(r.key)).map((r) => r.key), edited: true }));
        toast(`${name} saved. It applies in every project; sessions pick it up when they next look at their role.`);
      },
    },
    h('h3', {}, `Role: ${role.title}`),
    h('p', {}, 'What this role knows is the same in every project. A session holding it reads this when it starts and whenever it is given a goal.'),
    h('label.field', {}, h('span', {}, 'Name'), title),
    h('label.field', {}, h('span', {}, 'Responsible for'), duty),
    h('label.field', {}, h('span', {}, 'How it works'), guide),
    h('h4', {}, 'Hands work to'),
    h(
      'div.role-next',
      {},
      others.map((r) =>
        h(
          'label',
          {},
          h('input', { type: 'checkbox', checked: next.has(r.key), onchange: (e) => (e.target.checked ? next.add(r.key) : next.delete(r.key)) }),
          h('span', {}, r.title),
        ),
      ),
    ),
    h('p.field-note', {}, 'When this role gets a goal or finishes its part, it passes the work to these teammates by itself. Roles the project does not use are skipped.'),
    h(
      'div.dialog-actions',
      {},
      builtIn && role.edited
        ? h(
            'button.btn',
            {
              type: 'button',
              style: 'margin-right:auto',
              onclick: () => {
                store(cleanRole(builtIn));
                toast(`${builtIn.title} is back to Loop's own wording.`);
              },
            },
            'Reset to default',
          )
        : null,
      h('button.btn', { type: 'button', onclick: leave }, 'Cancel'),
      h('button.btn.primary', { type: 'submit' }, 'Save role'),
    ),
  );
  closeOverlay();
  const scrim = h('div.scrim.dim', { onmousedown: (e) => e.target === scrim && leave() }, box);
  box.addEventListener('keydown', (e) => e.key === 'Escape' && leave());
  document.querySelector('#overlay').append(scrim);
  title.focus();
}

// ---------- create or change the team ----------

// Words in a session's name that point at a role, for "Match by name".
const ROLE_HINTS = {
  ceo: /\b(ceo|boss|founder|leadership)\b/i,
  cto: /\b(cto|architect)\b/i,
  pm: /\b(pm|project manager|product manager|manager|planner)\b/i,
  devops: /\b(devops|infra|deploy|sre|ops)\b/i,
  qa: /\b(qa|tester|testing|quality)\b/i,
  design: /\b(design|designer|ui|ux)\b/i,
  seo: /\bseo\b/i,
  marketing: /\b(marketing|growth|content|social|linkedin|campaign)\b/i,
  dev: /\b(dev|developer|engineer|engineering|backend|frontend|fullstack)\b/i,
};

function guessRole(name, roles) {
  const byTitle = roles.find((r) => name.toLowerCase().includes(r.title.toLowerCase()));
  if (byTitle) return byTitle.key;
  const key = Object.keys(ROLE_HINTS).find((k) => roles.some((r) => r.key === k) && ROLE_HINTS[k].test(name));
  return key || '';
}

function openTeamSetup(p, back, draft) {
  const old = (S.config.projectTeam || {})[p.dir] || null;
  const on = draft ? draft.on : new Set(old ? old.roles.map((r) => r.key) : ROLE_LIBRARY.filter((r) => r.on).map((r) => r.key));
  const members = draft ? draft.members : { ...(old ? old.members : {}) };
  const sessions = [...visibleSessions(p), ...p.sessions.filter((s) => members[s.id])].filter((s, i, all) => all.findIndex((x) => x.id === s.id) === i);

  const pool = h('div.team-pool');
  // How the user wants this team to work, in their own words. Every member is
  // told it when it starts, and it outranks the habits they came with.
  const policy = h('textarea.team-policy', {
    placeholder: 'How this team works. For example: never deploy on a Friday. Ask before touching the database. Keep pull requests under 400 lines.',
    value: draft ? draft.policy : (old && old.policy) || '',
  });
  // The company above the project: the rules every team on this PC works by,
  // and how long the CEO leaves a quiet team alone. The CEO may rewrite these
  // too; nobody else may.
  const co = S.config.company || {};
  const house = h('pre.team-house', {}, 'Loading the rules Loop ships with...');
  deck.houseRules().then((t) => (house.textContent = t));
  const coRules = h('textarea.team-policy', {
    placeholder: 'Leave this empty to use the rules Loop ships with, shown below.',
    value: draft ? draft.coRules : co.rules || '',
  });
  const mins = h('input.team-mins', {
    type: 'number',
    min: '0',
    max: '720',
    step: '5',
    value: String(draft ? draft.mins : Number.isFinite(Number(co.checkMins)) ? Number(co.checkMins) : 0),
  });
  const startRow = h('label.team-start');
  const side = h('div.team-side');
  // In the order they were added, so a role you add lands at the end.
  const chosen = () => [...on].map(roleDef).filter(Boolean);
  let startEmpty = draft ? draft.startEmpty : true;
  const again = () => openTeamSetup(p, back, { on, members, startEmpty, policy: policy.value, coRules: coRules.value, mins: mins.value });
  const assign = (id, key) => {
    if (key) members[id] = key;
    else delete members[id];
    paint();
  };

  // A drop target: a role, or the list of sessions without one.
  const dropZone = (el, key) => {
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      el.classList.add('over');
    });
    el.addEventListener('dragleave', (e) => el.contains(e.relatedTarget) || el.classList.remove('over'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('over');
      const id = e.dataTransfer.getData('text/plain');
      if (sessions.some((s) => s.id === id)) assign(id, key);
    });
    return el;
  };

  // A session you can drag; a click offers the same choices for when dragging is awkward.
  const chip = (s) =>
    h(
      'div.team-chip',
      {
        draggable: true,
        title: `${sessionTitle(s)}\nDrag it onto a role, or click to choose`,
        ondragstart: (e) => {
          e.dataTransfer.setData('text/plain', s.id);
          e.dataTransfer.effectAllowed = 'move';
        },
        onclick: (e) =>
          menu(e.clientX, e.clientY, [
            { heading: `Role of ${sessionTitle(s)}` },
            ...chosen().map((r) => ({ label: r.title, checked: members[s.id] === r.key, run: () => assign(s.id, r.key) })),
            members[s.id] ? '-' : null,
            members[s.id] ? { label: 'No role', run: () => assign(s.id, '') } : null,
          ]),
      },
      h('i', { class: S.live.has(s.id) ? 'live' : '' }),
      h('span', {}, sessionTitle(s)),
      members[s.id]
        ? h(
            'button.mini',
            {
              type: 'button',
              title: 'Take this role away',
              onclick: (e) => {
                e.stopPropagation();
                assign(s.id, '');
              },
            },
            icon('x'),
          )
        : null,
    );

  function paint() {
    // Redrawing must not move either list from where you had scrolled it.
    const at = [pool, side].map((col) => (col.querySelector('.team-list') || {}).scrollTop || 0);
    draw();
    [pool, side].forEach((col, i) => (col.querySelector('.team-list').scrollTop = at[i]));
  }

  function draw() {
    const empty = chosen().filter((r) => !Object.values(members).includes(r.key));
    startRow.hidden = !empty.length || !p.exists;
    put(
      startRow,
      h('input', { type: 'checkbox', checked: startEmpty, onchange: (e) => (startEmpty = e.target.checked) }),
      h('span', {}, `Start a new session for each role that has none (${empty.length}: ${empty.map((r) => r.title).join(', ')})`),
    );
    const free = sessions.filter((s) => !members[s.id]);
    const matches = free.filter((s) => guessRole(sessionTitle(s), chosen()));
    put(
      pool,
      h(
        'div.team-col-head',
        {},
        h('h4', {}, 'Sessions without a role'),
        h('span', {}, String(free.length)),
        matches.length
          ? h(
              'button.btn.small',
              {
                type: 'button',
                title: 'Give each session the role its name points at. You can still move any of them.',
                onclick: () => {
                  for (const s of matches) members[s.id] = guessRole(sessionTitle(s), chosen());
                  paint();
                  toast(`${matches.length} session${matches.length === 1 ? '' : 's'} placed by name. Check them, then save.`);
                },
              },
              'Match by name',
            )
          : null,
      ),
      dropZone(
        h(
          'div.team-list',
          {},
          free.length
            ? free.map(chip)
            : h('div.side-empty', {}, sessions.length ? 'Every session has a role. Drag one back here to take its role away.' : 'This project has no sessions yet. Start some, then give them roles here.'),
        ),
        '',
      ),
    );

    const unused = roleLib().filter((r) => !on.has(r.key));
    put(
      side,
      h('div.team-col-head', {}, h('h4', {}, 'Team'), h('span', {}, `${Object.keys(members).length} of ${sessions.length} placed`)),
      h(
        'div.team-list',
        {},
        chosen().map((r) => {
          const held = sessions.filter((s) => members[s.id] === r.key);
          return dropZone(
            h(
              'div.team-slot',
              { class: held.length ? 'held' : '' },
              h(
                'div.team-slot-head',
                { title: r.duty },
                h('b', {}, r.title),
                r.manages ? h('em', {}, 'maintains the board') : null,
                h('span', {}, held.length ? String(held.length) : ''),
                h('button.mini', { type: 'button', title: `What a ${r.title} knows and who it hands work to, in every project`, onclick: () => openRoleEdit(r.key, again) }, icon('pencil')),
                h(
                  'button.mini',
                  {
                    type: 'button',
                    title: 'This project does not need this role',
                    onclick: () => {
                      on.delete(r.key);
                      for (const id of Object.keys(members)) if (members[id] === r.key) delete members[id];
                      paint();
                    },
                  },
                  icon('x'),
                ),
              ),
              held.length ? held.map(chip) : h('div.team-drop', {}, 'Drop a session here'),
            ),
            r.key,
          );
        }),
        unused.length
          ? h(
              'div.team-unused',
              {},
              unused.map((r) =>
                h(
                  'button.btn.small',
                  {
                    type: 'button',
                    title: r.duty,
                    onclick: () => {
                      on.add(r.key);
                      paint();
                    },
                  },
                  icon('plus'),
                  r.title,
                ),
              ),
            )
          : null,
        h('div.with-button.team-add', {}, newTitle, newDuty, h('button.btn', { type: 'button', onclick: addRole }, icon('plus'), 'New role')),
      ),
    );
  }

  const newTitle = h('input', { type: 'text', placeholder: 'A role of your own, for example Data analyst' });
  const newDuty = h('input', { type: 'text', placeholder: 'What it is responsible for' });
  const addRole = () => {
    const title = newTitle.value.trim().slice(0, 40);
    if (!title) return newTitle.focus();
    if (roleLib().some((r) => r.title.toLowerCase() === title.toLowerCase())) return toast('That role is already in the list.', true);
    const key = 'r' + Date.now().toString(36);
    const manager = roleLib().find((r) => r.manages);
    S.config.roles = [
      ...roleLib(),
      cleanRole({ key, title, duty: newDuty.value.trim().slice(0, 300) || `Owns the ${title.toLowerCase()} work.`, next: manager ? [manager.key] : [], edited: true }),
    ];
    save();
    on.add(key);
    newTitle.value = '';
    newDuty.value = '';
    paint();
  };

  const leave = () => {
    closeOverlay();
    if (back) back();
    else focusActive();
  };

  async function saveTeam() {
    const kept = chosen().map(({ key, title, duty, manages }) => ({ key, title, duty, ...(manages ? { manages: true } : {}) }));
    if (!kept.length) return toast('Add at least one role, or remove the team.', true);
    for (const id of Object.keys(members)) if (!kept.some((r) => r.key === members[id])) delete members[id];
    // A role nobody holds gets a new session of its own, named after the role.
    const fresh = [];
    if (startEmpty && p.exists) {
      for (const r of kept.filter((x) => !Object.values(members).includes(x.key))) {
        const id = crypto.randomUUID();
        members[id] = r.key;
        fresh.push({ id, role: r });
      }
    }
    const before = old ? old.members : {};
    S.config.projectTeam = S.config.projectTeam || {};
    S.config.projectTeam[p.dir] = { ...(old || {}), roles: kept, members, policy: policy.value.trim().slice(0, 4000) };
    S.config.company = {
      ...(S.config.company || {}),
      rules: coRules.value.trim().slice(0, 6000),
      checkMins: Math.max(0, Math.min(720, Math.round(Number(mins.value) || 0))),
    };
    const was = { ...S.config.sessionRole };
    for (const s of p.sessions) if (before[s.id] && !members[s.id]) delete S.config.sessionRole[s.id];
    refreshRoleTexts();
    // Every member that is open hears about it: its own role if that changed, and that
    // the team is different now. Closed ones get the current team when they next start.
    const changed = JSON.stringify([old && old.roles.map((r) => r.key), before]) !== JSON.stringify([kept.map((r) => r.key), members]);
    const policyChanged = ((old && old.policy) || '') !== policy.value.trim();
    const told = [];
    for (const s of p.sessions) {
      const text = members[s.id] && S.config.sessionRole[s.id];
      const tab = tabFor(s.id);
      if (!text || !tab || tab.exited) continue;
      if (was[s.id] !== text) told.push([s.id, `Your role on this project's team is now ${text} ${ROLE_TOLD}`]);
      else if (changed || policyChanged) told.push([s.id, 'The user changed the team of this project in Loop. Call team_info and role_brief now: they replace what you knew about the team, who does what, and the rules you work by.']);
    }
    save();
    renderList();
    leave();
    for (const [id, text] of told) tellWhenIdle(id, text);
    for (const f of fresh) startMember(p, f.id, f.role);
    const n = Object.keys(members).length;
    if (fresh.length) return toast(`Team saved. Starting ${fresh.length} new session${fresh.length === 1 ? '' : 's'}: ${fresh.map((f) => f.role.title).join(', ')}.`);
    toast(
      n
        ? `Team saved: ${n} session${n === 1 ? ' has a role' : 's have roles'}.${told.length ? ` ${told.length} open session${told.length === 1 ? ' is' : 's are'} being told.` : ''} Closed ones get the team when they next start.`
        : 'Team saved. Give sessions their roles to put it to work.',
    );
  }

  const box = h(
    'div.dialog.team.team-two',
    { tabIndex: -1 },
    h('h3', {}, `Team for ${projectTitle(p)}`),
    h(
      'p',
      {},
      'Drag each session onto its role. Several sessions can share a role. The pencil on a role opens what it knows and who it hands work to, which is the same in every project.',
    ),
    h('div.team-cols', {}, pool, side),
    h(
      'label.field.team-rules',
      {},
      h('span', {}, 'Rules for this project', h('em', {}, 'On top of the company rules below, for this project only')),
      policy,
    ),
    h(
      'details.team-company',
      {},
      h('summary', {}, 'The company: rules every team works by'),
      h(
        'label.field.team-rules',
        {},
        h('span', {}, 'Company rules', h('em', {}, 'Set by you and by the CEO. Nobody else may change them')),
        coRules,
      ),
      h(
        'label.field.team-mins',
        {},
        h('span', {}, 'The CEO asks for an update after', h('em', {}, 'Minutes of quiet while work is in hand. 0 turns it off')),
        mins,
      ),
      h('div.team-house-wrap', {}, h('span', {}, 'The rules Loop ships with, used while the box above is empty:'), house),
    ),
    startRow,
    h(
      'div.dialog-actions',
      {},
      old
        ? h(
            'button.btn',
            {
              type: 'button',
              style: 'margin-right:auto',
              title: 'The sessions and the tickets stay; only the roles go',
              onclick: () => {
                for (const id of Object.keys(old.members)) delete S.config.sessionRole[id];
                delete S.config.projectTeam[p.dir];
                save();
                renderList();
                leave();
                toast('Team removed. The board is open to every session again.');
              },
            },
            'Remove team',
          )
        : null,
      h('button.btn', { type: 'button', onclick: leave }, 'Cancel'),
      h('button.btn.primary', { type: 'button', onclick: saveTeam }, old ? 'Save team' : 'Create team'),
    ),
  );
  paint();
  closeOverlay();
  const scrim = h('div.scrim.dim', { onmousedown: (e) => e.target === scrim && leave() }, box);
  box.addEventListener('keydown', (e) => e.key === 'Escape' && leave());
  document.querySelector('#overlay').append(scrim);
  box.focus();
}

// Start a new session that holds a role from its first moment, and have it read its brief.
// A new member is started by its first message, the way a teammate wakes one:
// Loop runs it in the background and nothing has to be typed anywhere.
async function startMember(p, id, role, name) {
  const first = `You are the ${role.title} on this project's team. ${ROLE_TOLD} Then say in one line what you will take care of, and wait for work.`.replace(/\s+/g, ' ');
  const why = await deck.directSend({ dir: p.dir, cwd: p.path, sessionId: id, text: first, account: accountFor(p.dir, id), fresh: true });
  if (why) toast(`${name || role.title} could not be started: ${why}`, true);
  renderList();
}

// Give one session a role from the project's team, or take it away (key empty).
async function setMemberRole(p, s, key) {
  const stored = (S.config.projectTeam || {})[p.dir];
  if (!stored) return;
  if (key) stored.members[s.id] = key;
  else delete stored.members[s.id];
  // Whether there is a manager changes what every member is told about the board.
  refreshRoleTexts();
  if (!key) delete S.config.sessionRole[s.id];
  save();
  renderList();
  const role = roleOf(p.dir, s.id);
  if (!role) return toast(`${sessionTitle(s)} has no role now.`);
  const told = await nudge(p, s, `Your role on this project's team is now ${S.config.sessionRole[s.id]} ${ROLE_TOLD}`);
  if (told) toast(`${sessionTitle(s)} is now ${role.title}, and has been told.`);
  else toast(`${sessionTitle(s)} is now ${role.title}. It learns this when it next starts here.`);
}

// Rules for one member on top of the company's and the project's: what this one
// session must do differently from everybody holding the same role.
async function openMemberRules(p, s) {
  const t = teamOf(p.dir);
  if (!t) return;
  const now = (t.memberRules || {})[s.id] || '';
  const v = await formDialog({
    title: `Rules for ${sessionTitle(s)}`,
    body: "Only this session reads them, on top of the company's rules and the project's. For example: never touch the database directly; ask the CTO before adding a dependency.",
    fields: [{ key: 'rules', label: 'Rules', type: 'textarea', value: now, placeholder: 'One rule a line.' }],
    confirm: 'Save',
  });
  if (!v) return;
  const text = String(v.rules || '').trim().slice(0, 2000);
  if (text === now.trim()) return;
  t.memberRules = { ...(t.memberRules || {}) };
  if (text) t.memberRules[s.id] = text;
  else delete t.memberRules[s.id];
  save();
  const told = await nudge(p, s, RULES_CHANGED);
  toast(told ? `Saved, and ${sessionTitle(s)} has been told.` : `Saved. ${sessionTitle(s)} reads them when it next starts.`);
}

function roleMenu(x, y, p, s) {
  const t = teamOf(p.dir);
  menu(x, y, [
    { heading: `Role of ${sessionTitle(s)}` },
    ...t.roles.map((r) => ({ label: r.title, checked: t.members[s.id] === r.key, run: () => setMemberRole(p, s, r.key) })),
    t.members[s.id] ? { label: 'No role', run: () => setMemberRole(p, s, '') } : null,
    '-',
    t.members[s.id] ? { label: `What a ${roleOf(p.dir, s.id).title} knows`, icon: 'book', run: () => openRoleEdit(t.members[s.id]) } : null,
    t.members[s.id] ? { label: 'Rules for this member only', icon: 'book', run: () => openMemberRules(p, s) } : null,
    { label: 'Edit the team', icon: 'team', run: () => openTeamSetup(p) },
  ]);
}

// The sessions of a project under their roles, in the team's order. Every role
// in use gets its own branch, with one session or many; the rest come last.
function roleGroups(p, sessions) {
  const t = teamOf(p.dir);
  if (!t) return null;
  const groups = t.roles.map((r) => ({ key: r.key, title: r.title, sessions: sessions.filter((s) => t.members[s.id] === r.key) })).filter((g) => g.sessions.length);
  if (!groups.length) return null;
  const rest = sessions.filter((s) => !groups.some((g) => g.sessions.includes(s)));
  if (rest.length) groups.push({ key: '', title: 'External members', sessions: rest });
  return groups;
}

// Open a saved session of this PC in a tab without asking anything; true when it is open.
// Open a teammate's terminal here, taking it back first if Loop was running it
// in the background for a phone.
function openHere(p, s) {
  const lv = S.live.get(s.id);
  if (lv && lv.bg) deck.directStop(s.id);
  else if (lv) return false; // running somewhere that is not ours to move
  return Boolean(createTab({ kind: 'resume', dir: p.dir, cwd: p.path, sessionId: s.id, name: sessionTitle(s) }));
}

function openMember(p, s) {
  if (tabFor(s.id)) return true;
  if (!p.exists || S.order.length >= 16) return false;
  return openHere(p, s);
}

// Where a goal from you enters the project: the session you made boss, else
// the team's CEO, else the CTO, else the project manager.
function goalTaker(p) {
  const boss = bossOf(p);
  const marked = boss && boss.marked && p.sessions.find((s) => s.id === boss.id);
  if (marked) return marked;
  const t = teamOf(p.dir);
  if (!t) return null;
  const order = ['ceo', 'cto', ...t.roles.filter((r) => r.manages).map((r) => r.key)];
  for (const key of order) {
    const held = p.sessions.filter((s) => t.members[s.id] === key);
    if (held.length) return held.find((s) => tabFor(s.id)) || held[0];
  }
  return null;
}

// Hand a goal to the team: it goes to one session as a message, and the roles
// pass it on from there.
async function giveGoal(p, s, goal) {
  const r = await sayTo(p, s, goalWords(p, s, goal));
  if (!r.ok) return toast(`${sessionTitle(s)} did not take the goal: ${r.text || 'Loop could not reach it.'}`, true);
  toast(`Goal given to ${sessionTitle(s)}. ${roleOf(p.dir, s.id) ? 'Watch the board for the tickets.' : 'Watch the mailbox for who it gives the work to.'}`);
}

// A boss that holds no team role has no role brief to read: it works from the mailbox.
const BOSS_GOAL_WORDS = (goal) =>
  `New goal from the user for the team: ${goal} | Call mailbox_list. Do small jobs yourself; hand the rest to the session you choose with mailbox_send (to its name, text a ticket of 150 words or fewer): that wakes it if it is closed. Reply first with the plan in 3 bullets, then report back here when it is done.`;
const goalWords = (p, s, goal) => (roleOf(p.dir, s.id) ? GOAL_WORDS(goal) : BOSS_GOAL_WORDS(goal));

const GOAL_WORDS = (goal) =>
  `New goal from the user for the team: ${goal} | Call role_brief. Do small jobs yourself; hand bigger work straight to the teammate who does it with team_manage (action tell, session their name, text a ticket of 150 words or fewer): that reaches a teammate whether or not it is running. Reply first with the plan in 3 bullets, then report back here in the company report format when it is done.`;

// Say something to a session the way the phone does: as a message into the
// session itself. One that is not running is started by the message; one
// running somewhere else is brought into Loop first.
async function sayTo(p, s, text) {
  return phoneSend(0, { dir: p.dir, sessionId: s.id, text });
}

// Tell a member something only if it is already running: one that is not
// running reads the same thing in its brief the moment it starts, and waking it
// to hear news costs a turn for nothing.
async function nudge(p, s, text) {
  const tab = tabFor(s.id);
  const lv = S.live.get(s.id);
  if (tab && !tab.exited && lv && lv.status === 'idle') {
    await slash(tab, text.replace(/\s+/g, ' '));
    return true;
  }
  if (lv && lv.bg) return (await sayTo(p, s, text)).ok;
  return false;
}

const RULES_CHANGED = 'The rules this team works by have changed. Call role_brief now: it has them in full, and they outrank anything you were told before.';

// Everyone who is running, told once. The rest get it from their brief.
async function tellMembers(p, text) {
  const t = teamOf(p.dir);
  if (!t) return 0;
  let n = 0;
  for (const s of p.sessions) if (t.members[s.id] && (await nudge(p, s, text))) n++;
  return n;
}

// ---------- changes a session asks for (the team_manage tool) ----------

// One request from a session, answered in a sentence it can act on. The CEO and
// the project manager run the team; any session may rename itself; while a
// project has no team, anyone may start one. `q.user` marks a request the user
// made themselves (the phone), which no role may refuse.
async function teamCommand(q) {
  if (String(q.action || '').startsWith('subsession_')) return subCommand(q);
  if (String(q.action || '').startsWith('mail_')) return mailCommand(q);
  const p = projectByDir(q.dir);
  if (!p || p.server) return 'This project is not one Loop can manage a team for.';
  const stored = () => (S.config.projectTeam || {})[p.dir];
  const mine = roleOf(p.dir, q.me);
  // The user is always the boss: a request from the phone is theirs, not a session's.
  const boss = q.user === true || !stored() || Boolean(mine && (mine.manages || mine.key === 'ceo' || mine.key === 'cto'));
  const nameOf = (s) => sessionTitle(s);
  const find = (text) => {
    if (!text || text.toLowerCase() === 'me') return p.sessions.find((s) => s.id === q.me) || { id: q.me, title: (S.live.get(q.me) || {}).name || 'this session' };
    const t = text.toLowerCase();
    const names = (s) => [nameOf(s), s.title, (S.live.get(s.id) || {}).name || ''].map((x) => String(x).toLowerCase());
    return p.sessions.find((s) => names(s).includes(t)) || p.sessions.find((s) => s.id.startsWith(t)) || p.sessions.find((s) => names(s).some((x) => x.includes(t)));
  };
  const findRole = (text) => {
    const t = String(text).toLowerCase();
    return roleLib().find((r) => r.title.toLowerCase() === t || r.key === t) || roleLib().find((r) => r.title.toLowerCase().includes(t));
  };
  const ensureTeam = () => {
    S.config.projectTeam = S.config.projectTeam || {};
    if (!stored()) S.config.projectTeam[p.dir] = { roles: [], members: {} };
    return stored();
  };
  const useRole = (role) => {
    const t = ensureTeam();
    if (!t.roles.some((r) => r.key === role.key)) t.roles.push({ key: role.key, title: role.title, duty: role.duty, ...(role.manages ? { manages: true } : {}) });
  };
  const done = (text) => {
    refreshRoleTexts();
    save();
    renderList();
    return text;
  };
  const only = 'Only the CEO and the CTO change the team. Ask one of them, or the user.';

  if (q.action === 'rename') {
    const s = find(q.session);
    if (!s) return `No session called "${q.session}" in this project.`;
    if (s.id !== q.me && !boss) return 'You may rename yourself; renaming another session is for the CEO and the CTO.';
    const name = q.name.replace(/["&|<>^%!\r\n]/g, '').trim().slice(0, 60);
    if (!name) return 'Give the new name in "name".';
    const was = nameOf(s);
    S.config.sessionAlias[s.id] = name;
    if (tabFor(s.id)) {
      tabFor(s.id).name = name;
      renderTabs();
    }
    // The name teammates message it by changes when the session itself is free to take it.
    tellWhenIdle(s.id, `/rename ${name}`);
    return done(`"${was}" is now called "${name}" in Loop. Teammates reach it under the new name once it is idle.`);
  }
  // Hand work to a teammate, running or not. A session that is not running is
  // started by the message itself, the way a phone call wakes someone up: the
  // same path a message from the phone takes, so no terminal is needed.
  if (q.action === 'tell') {
    const s = find(q.session);
    const text = String(q.text || '').trim();
    if (!s || s.id === q.me) return `No other session called "${q.session}" in this project. Call team_info for the names.`;
    if (!mine && stored()) return 'Only team members hand work to teammates.';
    if (!text) return 'Say what the teammate should do, in "text".';
    const from = nameOf(p.sessions.find((x) => x.id === q.me) || { id: q.me, title: 'a teammate' });
    // The teammate answers through Loop too; a reply left in its own chat never reaches the sender.
    // A message from one session to another, by name, as Claude Code's own
    // session messages read; the chat shows it as from that session, not the user.
    const said = `Session message from "${from}": ${text} | If this is work for you: when it is done, reply to ${from} with team_manage (action tell, session "${from}", text: 3 lines or fewer plus the commit, PR or file link). If it is a reply, an acknowledgement or thanks: do not answer it.`;
    // Work handed over goes in as a message to the session itself, not as
    // keystrokes into a terminal: it arrives whole, it arrives whether or not
    // the teammate is running, and nothing depends on what is on a screen.
    const wasUp = S.live.has(s.id) || Boolean(tabFor(s.id));
    const r = await sayTo(p, s, said);
    // A hand-over between teammates is mailbox traffic too: it shows in the project's mailbox panel.
    mailLog(p, { kind: 'send', from, to: nameOf(s), text, result: r.ok ? (wasUp ? 'delivered' : 'woken') : 'failed', note: r.ok ? '' : r.text || 'Loop could not reach it.' });
    if (!r.ok) return `"${nameOf(s)}" did not take it: ${r.text || 'Loop could not reach it.'}`;
    return `Sent to "${nameOf(s)}" as a message; it is working on it now. It reports back to you when it is done. Carry on with your own part meanwhile, and read the board for progress rather than asking.`;
  }
  if (q.action === 'wake') {
    const s = find(q.session);
    if (!s || s.id === q.me) return `No other session called "${q.session}" in this project.`;
    if (!mine && stored()) return 'Only team members wake teammates.';
    if (S.live.has(s.id)) return `"${nameOf(s)}" is already running (${S.live.get(s.id).status === 'idle' ? 'idle' : 'busy'}). Message it with SendMessage.`;
    if (!openMember(p, s)) return `"${nameOf(s)}" could not be opened. Tell the user.`;
    return `Opening "${nameOf(s)}". It takes a few seconds: when team_info shows it idle, message it with SendMessage.`;
  }
  // The rules are the CEO's to set, not the board manager's and not a member's.
  // "company" is every team on this machine, "project" this project only,
  // "member" one session. The user, asking from the app, is always allowed.
  if (q.action === 'rules') {
    const ceo = q.user === true || Boolean(mine && mine.key === 'ceo');
    if (!ceo) return 'The rules are the CEO’s to set. Send the CEO what you think should change, with team_manage (action tell), and the CEO decides.';
    const scope = (q.scope || 'project').toLowerCase();
    const text = String(q.text || '').trim().slice(0, 6000);
    if (scope === 'company') {
      S.config.company = { ...(S.config.company || {}), rules: text };
      save();
      const n = await tellMembers(p, RULES_CHANGED);
      return text
        ? `Written as the company rules. Every team on this machine works by them from now on, and every member reads them in its brief${n ? `; ${n} running member${n === 1 ? ' was' : 's were'} told now` : ''}.`
        : 'Cleared. Every team is back to the rules Loop ships with.';
    }
    if (scope === 'member') {
      const s = find(q.session);
      if (!s) return `No session called "${q.session}" in this project.`;
      const t = ensureTeam();
      t.memberRules = { ...(t.memberRules || {}) };
      if (text) t.memberRules[s.id] = text;
      else delete t.memberRules[s.id];
      save();
      await nudge(p, s, RULES_CHANGED);
      return text ? `Written as the rules for "${nameOf(s)}" alone, on top of the company's.` : `Cleared the rules written for "${nameOf(s)}" alone.`;
    }
    ensureTeam().policy = text;
    save();
    const n = await tellMembers(p, RULES_CHANGED);
    return text
      ? `Written as this project's rules, on top of the company's${n ? `; ${n} running member${n === 1 ? ' was' : 's were'} told now` : ''}.`
      : "Cleared. This project is back to the company's rules alone.";
  }

  if (!boss) return only;

  if (q.action === 'assign') {
    const s = find(q.session);
    const role = findRole(q.role);
    if (!s) return `No session called "${q.session}" in this project.`;
    if (!role) return `No role called "${q.role}". Roles: ${roleLib().map((r) => r.title).join(', ')}. Add a new one with add_role.`;
    useRole(role);
    await setMemberRole(p, s, role.key);
    return done(`"${nameOf(s)}" is now ${role.title}.`);
  }
  if (q.action === 'unassign') {
    const s = find(q.session);
    if (!s || !stored() || !stored().members[s.id]) return `"${q.session}" holds no role.`;
    await setMemberRole(p, s, '');
    return done(`"${nameOf(s)}" has no role now and is an external member.`);
  }
  if (q.action === 'add_role') {
    if (!q.role) return 'Give the role name in "role".';
    let role = findRole(q.role);
    if (!role) {
      const manager = roleLib().find((r) => r.manages);
      role = cleanRole({ key: 'r' + Date.now().toString(36), title: q.role.slice(0, 40), duty: q.duty || `Owns the ${q.role.toLowerCase()} work.`, next: manager ? [manager.key] : [], edited: true });
      S.config.roles = [...roleLib(), role];
    }
    useRole(role);
    return done(`${role.title} is on the team. Nobody holds it yet: assign a session, or start one with that role.`);
  }
  if (q.action === 'drop_role') {
    const role = findRole(q.role);
    const t = stored();
    if (!role || !t || !t.roles.some((r) => r.key === role.key)) return `The team has no role called "${q.role}".`;
    t.roles = t.roles.filter((r) => r.key !== role.key);
    for (const id of Object.keys(t.members)) {
      if (t.members[id] !== role.key) continue;
      delete t.members[id];
      delete S.config.sessionRole[id];
    }
    return done(`${role.title} is off the team. The sessions that held it are external members now.`);
  }
  if (q.action === 'start') {
    const role = q.role ? findRole(q.role) : null;
    if (q.role && !role) return `No role called "${q.role}". Add it with add_role first.`;
    const name = (q.name || (role && role.title) || '').replace(/["&|<>^%!\r\n]/g, '').trim().slice(0, 60);
    if (!name) return 'Give the new session a name in "name".';
    if (!p.exists) return 'The project folder is missing, so no session can start there.';
    if (S.order.length >= 16) return 'Loop already has 16 tabs open. Close some before starting more.';
    const id = crypto.randomUUID();
    if (role) {
      useRole(role);
      stored().members[id] = role.key;
      stored().names = { ...(stored().names || {}), [id]: name };
      done('');
      startMember(p, id, role, name);
      return `Started "${name}" as ${role.title}. It reads its brief first; message it once team_info shows it idle.`;
    }
    createTab({ kind: 'new', dir: p.dir, cwd: p.path, sessionId: id, name });
    return `Started "${name}" with no role (an external member). It is ready once team_list shows it idle.`;
  }
  if (q.action === 'close') {
    const s = find(q.session);
    if (!s) return `No session called "${q.session}" in this project.`;
    if (s.id === q.me) return 'A session cannot close itself this way.';
    const tab = tabFor(s.id);
    if (!tab) return `"${nameOf(s)}" is not open in Loop.`;
    if ((S.live.get(s.id) || {}).status !== 'idle') return `"${nameOf(s)}" is busy. Wait until it is idle, or ask the user.`;
    await closeTab(tab.id, true);
    return `Closed "${nameOf(s)}". Its conversation is kept and it can be opened again.`;
  }
  return 'Unknown action. Use tell, assign, unassign, add_role, drop_role, start, wake, rename or close.';
}

// ---------- the board ----------

let boardLive = null; // { dir, reload } while a board is open

function openBoard(p) {
  if (p.server) return toast('Boards and teams are for projects on this PC.', true);
  const cols = h('div.board-cols');
  const head = h('div.board-head');
  let tasks = [];

  const names = () => {
    const t = teamOf(p.dir);
    return p.sessions
      .filter((s) => (t && t.members[s.id]) || tabFor(s.id) || S.live.has(s.id))
      .map((s) => ({ id: s.id, name: (S.live.get(s.id) || {}).name || s.title, label: sessionTitle(s), role: roleOf(p.dir, s.id) }));
  };
  // Show a session the way the list names it; the ticket keeps the name sessions use for each other.
  const shownName = (x) => {
    const s = x.assigneeId && p.sessions.find((y) => y.id === x.assigneeId);
    return s ? sessionTitle(s) : x.assignee;
  };

  function paint() {
    const pm = managerOf(p);
    const t = teamOf(p.dir);
    paintGoal();
    put(
      head,
      h('h3', {}, `${projectTitle(p)} board`),
      h(
        'span.board-who',
        {},
        t ? (pm ? `Maintained by ${sessionTitle(pm)}, the project manager` : 'No session is the project manager yet, so every session can change the board') : 'No team yet: every session can change the board',
      ),
      h('button.btn.small', { onclick: () => openTeamSetup(p, () => openBoard(p)) }, icon('team'), t ? 'Team' : 'Create team'),
      h('button.btn.small.primary', { onclick: () => openTicket(p, null, names()) }, icon('plus'), 'Ticket'),
      h('button.mini', { title: 'Close', onclick: () => close() }, icon('x')),
    );
    put(
      cols,
      COLUMNS.map(([status, label]) => {
        const mine = tasks.filter((x) => x.status === status);
        const shown = status === 'done' ? mine.slice(0, 30) : mine;
        const col = h(
          'div.board-col',
          {
            class: status,
            ondragover: (e) => {
              e.preventDefault();
              col.classList.add('over');
            },
            ondragleave: () => col.classList.remove('over'),
            ondrop: async (e) => {
              e.preventDefault();
              col.classList.remove('over');
              const id = e.dataTransfer.getData('text/plain');
              const task = tasks.find((x) => x.id === id);
              if (task && task.status !== status) await deck.taskUpdate(p.dir, id, { status });
            },
          },
          h('div.board-col-head', {}, h('b', {}, label), h('span', {}, String(mine.length))),
          h(
            'div.board-cards',
            {},
            shown.map((x, i) => {
              const done = Math.max(0, Math.min(100, Number(x.progress) || 0));
              const card = h(
                'button.card',
                {
                  draggable: true,
                  ondragstart: (e) => e.dataTransfer.setData('text/plain', x.id),
                  // Dropping onto a card puts the dragged one above it: the top
                  // of a column is what the next free teammate takes.
                  ondragover: (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    card.classList.add('over');
                  },
                  ondragleave: () => card.classList.remove('over'),
                  ondrop: async (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    card.classList.remove('over');
                    const id = e.dataTransfer.getData('text/plain');
                    if (!id || id === x.id) return;
                    const mark = (t, n) => (typeof t.rank === 'number' ? t.rank : (n + 1) * 1000);
                    const here = mark(x, i);
                    const above = i > 0 ? mark(shown[i - 1], i - 1) : here - 2;
                    await deck.taskUpdate(p.dir, id, { status, rank: (above + here) / 2 });
                  },
                  onclick: () => openTicket(p, x, names()),
                  title: x.details || x.title,
                },
                h('span.card-title', {}, x.title),
                h(
                  'span.card-meta',
                  {},
                  h('i', {}, x.id),
                  x.assignee ? h('em', {}, shownName(x)) : h('em.none', {}, 'Unassigned'),
                  x.notes.length ? h('u', { title: `${x.notes.length} comment${x.notes.length === 1 ? '' : 's'}` }, String(x.notes.length)) : null,
                  done && status !== 'done' ? h('b.card-pc', {}, `${done}%`) : null,
                ),
                done && status !== 'done' ? h('span.card-bar', {}, h('i', { style: `width:${done}%` })) : null,
              );
              return card;
            }),
            mine.length > shown.length ? h('div.board-more', {}, `${mine.length - shown.length} older not shown`) : null,
          ),
        );
        return col;
      }),
    );
  }

  async function reload() {
    if (!box.isConnected) return (boardLive = null);
    tasks = await deck.taskList(p.dir);
    paint();
  }

  const goalBar = h('form.board-goal');
  const goalInput = h('input', { type: 'text', placeholder: 'A goal, for example: add a dark mode to the settings page' });
  const paintGoal = () => {
    const taker = goalTaker(p);
    goalBar.hidden = !taker;
    if (!taker) return;
    goalBar.onsubmit = (e) => {
      e.preventDefault();
      const goal = goalInput.value.trim();
      if (!goal) return goalInput.focus();
      giveGoal(p, taker, goal);
      goalInput.value = '';
    };
    put(
      goalBar,
      goalInput,
      h('button.btn.primary', { type: 'submit', title: 'It goes to this session; the roles pass the work on from there, and the tickets show up here' }, `Give to ${sessionTitle(taker)}`),
    );
  };
  const box = h('div.dialog.board', { tabIndex: -1 }, head, goalBar, cols);
  const close = openPanel(box);
  boardLive = { dir: p.dir, reload };
  reload();
  box.focus();
}

// ---------- one ticket ----------

function openTicket(p, task, people) {
  const back = () => openBoard(p);
  const title = h('input', { type: 'text', value: task ? task.title : '', placeholder: 'Add rate limiting to the public API' });
  const details = h('textarea', { value: task ? task.details : '', placeholder: 'What done looks like, and anything the assignee needs to know' });
  const who = [...people];
  if (task && task.assignee && !who.some((x) => (task.assigneeId ? x.id === task.assigneeId : x.name === task.assignee))) who.push({ id: task.assigneeId || '', name: task.assignee, role: null });
  const current = task ? who.findIndex((x) => (task.assigneeId ? x.id === task.assigneeId : x.name === task.assignee)) : -1;
  const assignee = h(
    'select',
    {},
    h('option', { value: '-1' }, 'Unassigned'),
    who.map((x, i) => h('option', { value: String(i), selected: i === current }, x.role ? `${x.label || x.name}, ${x.role.title}` : x.label || x.name)),
  );
  const status = h(
    'select',
    {},
    COLUMNS.map(([value, label]) => h('option', { value, selected: (task ? task.status : 'todo') === value }, label)),
  );
  const comment = h('input', { type: 'text', placeholder: 'Add a comment' });
  // Whoever holds a ticket says how far along it is; the board shows it to you.
  const progress = h('input', { type: 'range', min: '0', max: '100', step: '5', value: String(task ? Number(task.progress) || 0 : 0) });
  progress.oninput = () => {
    const out = progress.parentElement && progress.parentElement.querySelector('output');
    if (out) out.textContent = `${progress.value}%`;
  };

  async function submit(e) {
    e.preventDefault();
    const name = title.value.trim();
    if (!name) return toast('Give the ticket a title.', true);
    const pick = who[Number(assignee.value)] || null;
    const change = { title: name, details: details.value, status: status.value, assignee: pick ? pick.name : '', assigneeId: pick ? pick.id : '', progress: Number(progress.value) };
    if (comment.value.trim()) change.note = comment.value.trim();
    if (task) await deck.taskUpdate(p.dir, task.id, change);
    else {
      const made = await deck.taskAdd(p.dir, change);
      if (change.status !== 'todo' || change.note) await deck.taskUpdate(p.dir, made.id, { status: change.status, note: change.note });
    }
    back();
  }

  const box = h(
    'form.dialog.wide.ticket',
    { onsubmit: submit },
    h('h3', {}, task ? `Ticket ${task.id}` : 'New ticket'),
    h('label.field', {}, h('span', {}, 'Title'), title),
    h('div.ticket-two', {}, h('label.field', {}, h('span', {}, 'Assigned to'), assignee), h('label.field', {}, h('span', {}, 'Status'), status)),
    h('label.field', {}, h('span', {}, 'How far along'), h('div.ticket-pc', {}, progress, h('output', {}, `${progress.value}%`))),
    h('label.field', {}, h('span', {}, 'Details'), details),
    task
      ? h(
          'p.ticket-when',
          {},
          [task.created ? `Made ${ago(task.created)}${task.createdBy ? ` by ${task.createdBy}` : ''}` : '', task.updated ? `last change ${ago(task.updated)}` : '']
            .filter(Boolean)
            .join(' · '),
        )
      : null,
    task && task.notes.length
      ? h(
          'div.ticket-notes',
          {},
          // What was said and what was done, newest last, told apart at a glance.
          task.notes.map((n) =>
            n.kind
              ? h('div.ticket-move', {}, h('b', {}, n.by || 'Someone'), ' ', n.text, h('em', {}, ago(n.at)))
              : h('div.ticket-note', {}, h('b', {}, n.by || 'Someone'), h('em', {}, ago(n.at)), h('p', {}, n.text)),
          ),
        )
      : null,
    h('label.field', {}, h('span', {}, 'Comment'), comment),
    h(
      'div.dialog-actions',
      {},
      task
        ? h(
            'button.btn',
            {
              type: 'button',
              style: 'margin-right:auto',
              onclick: async () => {
                await deck.taskRemove(p.dir, task.id);
                back();
              },
            },
            icon('trash'),
            'Delete ticket',
          )
        : null,
      h('button.btn', { type: 'button', onclick: back }, 'Back to the board'),
      h('button.btn.primary', { type: 'submit' }, task ? 'Save ticket' : 'Add ticket'),
    ),
  );
  closeOverlay();
  const scrim = h('div.scrim.dim', { onmousedown: (e) => e.target === scrim && back() }, box);
  box.addEventListener('keydown', (e) => e.key === 'Escape' && back());
  document.querySelector('#overlay').append(scrim);
  title.focus();
  const notes = box.querySelector('.ticket-notes');
  if (notes) notes.scrollTop = notes.scrollHeight;
}

// ---------- the check-in nobody has to remember ----------
// The rules say no member goes quiet and the CEO chases an update when none has
// come in. This is that clock: when the board has not moved for the agreed
// number of minutes while work is in hand, the CEO is asked to chase it.
const lastPing = new Map(); // project -> { at, tries } since the board last moved
const GIVE_UP = 3; // chasing a board that never moves costs tokens for nothing

function checkEvery(dir) {
  const t = teamOf(dir);
  const own = t && Number(t.checkMins);
  if (Number.isFinite(own) && own >= 0) return own;
  const c = Number((S.config.company || {}).checkMins);
  return Number.isFinite(c) && c >= 0 ? c : 0;
}

async function checkIns() {
  for (const p of S.projects) {
    if (p.server || !p.exists) continue;
    const t = teamOf(p.dir);
    if (!t) continue;
    const mins = checkEvery(p.dir);
    if (!mins) continue;
    const ceo = p.sessions.filter((s) => t.members[s.id] === 'ceo');
    const pms = p.sessions.filter((s) => t.members[s.id] && (roleDef(t.members[s.id]) || {}).manages);
    if (!ceo.length || !pms.length) continue;
    const tasks = (await deck.taskList(p.dir)) || [];
    const inHand = tasks.filter((x) => x.status === 'doing' || x.status === 'review');
    if (!inHand.length) continue; // nothing is in hand, so nobody owes anyone a word
    const moved = tasks.reduce((n, x) => Math.max(n, x.updated || 0), 0);
    const last = lastPing.get(p.dir) || { at: 0, tries: 0 };
    // Anything moving on the board answers the question, so the count starts again.
    const tries = moved > last.at ? 0 : last.tries;
    if (tries >= GIVE_UP) continue; // asked three times and nothing moved: the user can see that
    const quiet = Date.now() - Math.max(moved, last.at);
    if (quiet < mins * 60000) continue;
    lastPing.set(p.dir, { at: Date.now(), tries: tries + 1 });
    const who = pms.map((s) => `"${sessionTitle(s)}"`).join(' or ');
    await sayTo(
      p,
      ceo[0],
      `Nothing has moved on the board for ${mins} minutes and ${inHand.length} ticket${inHand.length === 1 ? ' is' : 's are'} in hand (${inHand
        .slice(0, 4)
        .map((x) => x.id)
        .join(', ')}). Ask ${who} for a one-line status with team_manage (action tell), then tell the user where things stand and whether to stop or set the next goal. Keep it to a line.`,
    );
  }
}

setInterval(() => checkIns().catch(() => {}), 60000);

// A session changed the board: redraw it if it is the one on screen.
function wireBoard() {
  seedRoles();
  deck.onTeamDo(async (id, req) => {
    let text;
    try {
      text = await teamCommand(req);
    } catch (e) {
      text = `Loop could not do that: ${e.message}`;
    }
    deck.teamDone(id, text);
  });
  deck.onBoard((dir) => {
    if (boardLive && boardLive.dir === dir) boardLive.reload();
  });
}
