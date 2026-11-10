// Starts Loop on made-up projects and sessions, for trying it out, working on
// it, or taking screenshots without showing your own work.
//
//   npm run demo                         start Loop on the demo data
//   npm run demo -- --shot desktop.png   save a screenshot of it, then quit
//   npm run demo -- --keep               leave the demo folder behind afterwards
//
// Everything lives in a fresh folder under the system's temp folder: Claude
// Code's data (CLAUDE_CONFIG_DIR) and Loop's own settings (SD_USERDATA). Your
// real ~/.claude and Loop settings are neither read nor changed. Opening a
// session replays its made-up conversation; no Claude Code runs and nothing is sent.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const NOW = Date.now();
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// Workspaces, their projects, and each project's sessions, newest first.
// A step is { u } something you said, { a } Claude's answer, or { t: [tool, input, result] }.
const DEMO = [
  {
    workspace: 'Acme',
    projects: [
      {
        name: 'acme-shop',
        sessions: [
          {
            title: 'Checkout timeouts',
            ago: 4 * MIN,
            steps: [
              { u: 'Big carts time out at checkout. Can you find out why?' },
              { t: ['Grep', { pattern: 'timeout', path: 'src/checkout' }, 'src/checkout/pay.js:14:  timeout: 5000,'] },
              { t: ['Read', { file_path: 'src/checkout/pay.js' }, 'Read 86 lines'] },
              { a: 'Found it. The payment call gives up after **5 seconds**, and a cart with more than 40 items takes the gateway about 7 to price.' },
              { u: 'Make it 30 seconds, with one retry when the gateway answers 504.' },
              { t: ['Edit', { file_path: 'src/checkout/pay.js' }, 'Updated src/checkout/pay.js with 9 additions and 2 removals'] },
              { t: ['Bash', { command: 'npm test -- checkout' }, 'Tests: 212 passed, 212 total'] },
              { a: 'Done: the payment call now waits 30 seconds, with one retry on a 504. All 212 tests pass.\n\nWant me to put it on staging?' },
            ],
          },
          {
            title: 'Pricing page with a yearly toggle',
            ago: 50 * MIN,
            steps: [
              { u: 'Add a monthly / yearly toggle to the pricing page. Yearly is two months free.' },
              { t: ['Read', { file_path: 'src/pages/pricing.tsx' }, 'Read 140 lines'] },
              {
                a: 'Plan: a toggle above the three plans, prices worked out from the monthly ones, and the choice kept in the URL so a shared link opens on it.',
              },
              { t: ['Edit', { file_path: 'src/pages/pricing.tsx' }, 'Updated src/pages/pricing.tsx with 38 additions and 6 removals'] },
              { a: 'The toggle is in. Yearly shows the saving under each price.' },
            ],
          },
          {
            title: 'Flaky cart test',
            ago: 5 * HOUR,
            steps: [
              { u: 'cart.test.js fails about one run in ten on CI. Fix it.' },
              { t: ['Read', { file_path: 'test/cart.test.js' }, 'Read 64 lines'] },
              {
                a: 'The test reads the total before the discount has been applied; it depends on which promise settles first. I made it wait for the cart to settle.',
              },
              { t: ['Bash', { command: 'for i in $(seq 50); do npm test -- cart -s || break; done' }, '50 runs, 0 failures'] },
              { a: 'Done: 50 runs in a row pass.' },
            ],
          },
          {
            title: 'Weekly dependency update',
            ago: 2 * DAY,
            steps: [
              { u: 'Update the dependencies that have patch releases, and run the tests.' },
              { t: ['Bash', { command: 'npm outdated' }, '6 packages have patch releases'] },
              { a: 'Done: six patch updates, tests pass. Nothing needed a code change.' },
            ],
          },
        ],
      },
      {
        name: 'acme-api',
        sessions: [
          {
            title: 'Rate limits for the public API',
            ago: 25 * MIN,
            steps: [
              { u: 'Add rate limits to the public API: 100 requests a minute per key.' },
              { t: ['Read', { file_path: 'src/middleware/index.ts' }, 'Read 52 lines'] },
              { a: 'Plan: a sliding window per API key in Redis, a 429 with Retry-After when it is used up, and the limits in the response headers.' },
              { a: 'Need from you: should internal keys be limited too, or left out?' },
            ],
          },
          {
            title: 'Move order ids to UUIDs',
            ago: 1 * DAY,
            steps: [
              { u: 'Write the migration that moves orders to UUID ids, without downtime.' },
              { a: 'Plan: add the new column, fill it in batches of 10,000, switch reads, then writes, then drop the old id a release later.' },
              { t: ['Write', { file_path: 'migrations/0042_order_uuid.sql' }, 'Wrote 31 lines'] },
            ],
          },
        ],
      },
      {
        name: 'acme-mobile',
        sessions: [
          {
            title: 'Ask for notifications after the first order',
            ago: 3 * HOUR,
            steps: [
              { u: 'Only ask for notification permission after someone places their first order.' },
              { t: ['Grep', { pattern: 'requestPermission', path: 'lib' }, 'lib/startup.dart:22'] },
              { a: 'Done: the question moved from startup to the order confirmation screen, once.' },
            ],
          },
        ],
      },
    ],
  },
  {
    workspace: 'Personal',
    projects: [
      {
        name: 'blog',
        sessions: [
          {
            title: 'Draft: what caching taught me',
            ago: 6 * HOUR,
            steps: [
              { u: 'Turn my notes in drafts/caching.md into a first draft. Keep my voice.' },
              { t: ['Read', { file_path: 'drafts/caching.md' }, 'Read 48 lines'] },
              { a: 'A first draft is in drafts/caching-post.md: about 1,200 words, three sections, your examples kept as they were.' },
            ],
          },
        ],
      },
      {
        name: 'dotfiles',
        sessions: [
          {
            title: 'Shell takes 2 seconds to start',
            ago: 3 * DAY,
            steps: [
              { u: 'My shell takes two seconds to start. Find what is slow.' },
              { t: ['Bash', { command: 'zsh -i -c exit -x 2>&1 | ts -i | sort -r | head' }, 'nvm.sh accounts for 1.6s'] },
              { a: 'Done: nvm now loads the first time you use node, not at startup. A new shell opens in 0.2 seconds.' },
            ],
          },
        ],
      },
    ],
  },
];

const WS_COLORS = ['#7cc4f0', '#f0b24a'];

// Claude Code names a project folder after its path, every other character a dash.
const encodePath = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');

// A made-up id that still looks like Claude Code's own.
function idFor(text) {
  let h = 2166136261;
  for (const c of text) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;

  const hex = (n) => (Math.imul(h, n) >>> 0).toString(16).padStart(8, '0');
  const all = hex(1) + hex(3) + hex(5) + hex(7);

  return `${all.slice(0, 8)}-${all.slice(8, 12)}-4${all.slice(13, 16)}-8${all.slice(17, 20)}-${all.slice(20, 32)}`;
}

// One session as Claude Code writes it: a line per record, oldest first.
function transcript(session, sessionId, cwd) {
  const lines = [];
  const base = { isSidechain: false, userType: 'external', cwd, sessionId, version: '2.1.0', gitBranch: 'main' };
  const start = NOW - session.ago - session.steps.length * 40 * 1000;
  let parentUuid = null;
  let n = 0;

  const add = (type, message, extra = {}) => {
    const uuid = idFor(`${sessionId}:${n}`);
    const timestamp = new Date(start + n * 40 * 1000).toISOString();
    lines.push({ parentUuid, ...base, type, message, uuid, timestamp, ...extra });
    parentUuid = uuid;
    n++;
  };

  for (const step of session.steps) {
    if (step.u) add('user', { role: 'user', content: step.u });
    if (step.a) add('assistant', { role: 'assistant', model: 'claude-opus-4-5', content: [{ type: 'text', text: step.a }] });
    if (step.t) {
      const [name, input, result] = step.t;
      const id = 'toolu_' + idFor(`${sessionId}:tool:${n}`).replace(/-/g, '');
      add('assistant', { role: 'assistant', model: 'claude-opus-4-5', content: [{ type: 'tool_use', id, name, input }] });
      add('user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: result }] });
    }
  }

  const firstPrompt = session.steps.find((s) => s.u).u;
  lines.push({ type: 'ai-title', aiTitle: session.title, sessionId });
  lines.push({ type: 'last-prompt', lastPrompt: firstPrompt, sessionId });

  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

// Writes the demo into dir and returns where Claude Code's data, Loop's settings
// and the stand-in for Claude Code are.
function writeDemo(dir) {
  const claudeDir = path.join(dir, 'claude');
  const userData = path.join(dir, 'loop');
  const binDir = path.join(dir, 'bin');
  const workspaces = [];
  fs.mkdirSync(path.join(claudeDir, 'projects'), { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });

  DEMO.forEach((ws, i) => {
    const root = path.join(dir, 'work', ws.workspace);
    workspaces.push({ id: 'ws' + (i + 1), name: ws.workspace, color: WS_COLORS[i % WS_COLORS.length], roots: [root] });

    for (const project of ws.projects) {
      const cwd = path.join(root, project.name);
      const folder = path.join(claudeDir, 'projects', encodePath(cwd));
      fs.mkdirSync(cwd, { recursive: true });
      fs.mkdirSync(folder, { recursive: true });

      for (const session of project.sessions) {
        const sessionId = idFor(`${project.name}/${session.title}`);
        const file = path.join(folder, sessionId + '.jsonl');
        fs.writeFileSync(file, transcript(session, sessionId, cwd));

        const at = new Date(NOW - session.ago);
        fs.utimesSync(file, at, at);
      }
    }
  });

  // Opening a session runs claude-demo instead of Claude Code: see replay() below.
  // It is found on the PATH, so no path from this computer shows in Loop.
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(binDir, 'claude-demo.cmd'), `@"${process.execPath}" "${__filename}" --replay %*\r\n`);
  } else {
    fs.writeFileSync(path.join(binDir, 'claude-demo'), `#!/bin/sh\nexec "${process.execPath}" "${__filename}" --replay "$@"\n`, { mode: 0o755 });
  }

  const config = { workspaces, settings: { claudeCmd: 'claude-demo', flags: '', memoryEnabled: false } };
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify(config, null, 2));

  return { claudeDir, userData, binDir };
}

// ---- standing in for Claude Code in a terminal ----

const dim = (s) => `\x1b[2m${s}\x1b[22m`;
const bold = (s) => s.replace(/\*\*(.+?)\*\*/g, '\x1b[1m$1\x1b[22m');
const toolLine = (name, input) => `${name}(${input.file_path || input.command || input.pattern || ''})`;

// Prints a made-up session the way a terminal would show it, then waits like an idle session.
function replay(args) {
  const at = args.findIndex((a) => a === '--resume' || a === '--session-id');
  const sessionId = at >= 0 ? args[at + 1] : '';
  const projects = path.join(process.env.CLAUDE_CONFIG_DIR || '', 'projects');
  const out = [dim('Loop demo: a replay of a made-up session. No Claude Code runs here.'), ''];
  let found = null;

  try {
    for (const p of fs.readdirSync(projects)) {
      const file = path.join(projects, p, sessionId + '.jsonl');
      if (fs.existsSync(file)) found = file;
    }
  } catch {
    // no demo data; say so below
  }

  const records = found
    ? fs
        .readFileSync(found, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

  for (const r of records) {
    const c = r.message && r.message.content;
    if (r.type === 'user' && typeof c === 'string') out.push(`\x1b[90m>\x1b[0m ${c}`, '');
    if (r.type === 'user' && Array.isArray(c)) out.push(dim(`  ⎿  ${c[0].content}`), '');
    if (r.type === 'assistant') {
      for (const part of c) {
        if (part.type === 'text')
          out.push(
            ...bold(part.text)
              .split('\n')
              .map((l, i) => (i ? `  ${l}` : `\x1b[37m⏺\x1b[0m ${l}`)),
            '',
          );
        if (part.type === 'tool_use') out.push(`\x1b[32m⏺\x1b[0m \x1b[1m${toolLine(part.name, part.input)}\x1b[22m`);
      }
    }
  }

  if (!records.length) out.push('A new session. In the demo there is no Claude Code to talk to.', '');

  // Drawn to the width of the pane, and again whenever the pane changes size.
  const draw = () => {
    const width = Math.max(40, (process.stdout.columns || 80) - 2);
    const lines = out.flatMap((l) => wrap(l, width));
    lines.push(dim('─'.repeat(width)), '\x1b[90m>\x1b[0m ', dim('─'.repeat(width)));
    process.stdout.write('\x1b[2J\x1b[3J\x1b[H' + lines.join('\r\n'));
  };
  setTimeout(draw, 300);
  process.stdout.on('resize', draw);

  // Stay open like an idle session; closing the tab ends it.
  setInterval(() => {}, 1 << 30);
}

// Breaks a line between words, continuing under its text rather than its marker.
function wrap(line, width) {
  const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
  const marker = /^\s*(⎿\s+|[>⏺] )?/.exec(plain(line))[0];
  const indent = ' '.repeat(marker.length);
  const lines = [];
  let cur = null;

  // Splitting on single spaces keeps a line's leading spaces as empty words.
  for (const word of line.split(' ')) {
    if (cur !== null && plain(cur).trim() && plain(cur).length + 1 + plain(word).length > width) {
      lines.push(cur);
      cur = indent + word;
    } else cur = cur === null ? word : cur + ' ' + word;
  }
  lines.push(cur);

  return lines;
}

// ---- starting Loop ----

// Run in Loop's window before the screenshot. A change to the window's code
// that breaks it only costs the open sessions; the picture is taken anyway.
const SHOT_SCRIPT = `(async () => {
  try {
    const open = (name, i) => {
      const p = S.projects.find((x) => x.name === name);
      return openSession(p, p.sessions[i]);
    };
    await open('acme-shop', 0);
    await open('acme-api', 0);
    await open('acme-shop', 1);
    await open('blog', 0);
    setLayout('grid');
    // The same picture on every system: no room kept for the Mac's window buttons, which it cannot show.
    document.body.classList.remove('mac');
    await new Promise((r) => setTimeout(r, 1500));
    activate(S.order[0]);
    // Bringing a session into view can scroll the list's frame too, even later
    // on. Until the picture is taken, whatever scrolled outside the terminals goes back.
    setInterval(() => {
      for (const el of document.querySelectorAll('*')) if (el.scrollTop && !el.closest('.xterm')) el.scrollTop = 0;
    }, 100);
    // The load meters are this computer's own, not the demo's.
    const usage = document.querySelector('#usage');
    if (usage) usage.style.visibility = 'hidden';
  } catch (e) {
    return 'could not open the sessions: ' + e.message;
  }
})()`;

function main(args) {
  const keep = args.includes('--keep');
  const shotAt = args.indexOf('--shot');
  const shotFile = shotAt >= 0 && args[shotAt + 1] && !args[shotAt + 1].startsWith('--') ? args[shotAt + 1] : 'loop-demo.png';
  const shot = shotAt >= 0 ? path.resolve(shotFile) : null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-demo-'));
  const { claudeDir, userData, binDir } = writeDemo(dir);
  const env = { ...process.env, CLAUDE_CONFIG_DIR: claudeDir, SD_USERDATA: userData };
  delete env.ELECTRON_RUN_AS_NODE;

  // claude-demo comes first on the PATH. Windows spells it Path, and a second spelling would be a second variable.
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  env[pathKey] = binDir + path.delimiter + (env[pathKey] || '');

  // The test hook in main.js: wait, save a picture of the window, quit.
  // The picture shows a few sessions side by side, as Loop is meant to be used.
  if (shot) {
    env.SD_SMOKE = shot;
    env.SD_SMOKE_WAIT = env.SD_SMOKE_WAIT || '2500';
    env.SD_SMOKE_JS = path.join(dir, 'shot.js');
    fs.writeFileSync(env.SD_SMOKE_JS, SHOT_SCRIPT);
  }

  console.log(`Demo data in ${dir}`);
  const loop = spawn(require('electron'), [ROOT], { cwd: ROOT, env, stdio: 'inherit' });

  // Ctrl+C here closes Loop first, so the folder is still removed below.
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => loop.kill());

  loop.on('exit', (code) => {
    if (!keep) {
      try {
        // On Windows a terminal Loop started can hold the folder for a moment after Loop quits.
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
      } catch {
        console.log(`Could not remove ${dir}; it is safe to delete by hand.`);
      }
    }

    if (shot) console.log(`Screenshot saved to ${shot}`);
    process.exit(code || 0);
  });
}

// Loop also runs the command on its own, without a terminal: to see who is
// signed in, and for one-off questions. Those get an answer, or nothing, at once.
function standIn(args) {
  if (args.includes('auth') && args.includes('status')) {
    console.log(JSON.stringify({ loggedIn: true, email: 'you@acme.example', orgName: 'Acme', subscriptionType: 'max' }));
  } else if (!args.includes('-p') && (args.includes('--resume') || args.includes('--session-id'))) {
    return replay(args);
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--replay')) standIn(args);
  else main(args);
}

module.exports = { writeDemo, transcript, idFor, DEMO };
