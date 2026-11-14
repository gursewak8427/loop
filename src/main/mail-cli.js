// loop-mail: the Loop mailbox as a shell command, for a session on any agent.
//
// Every coding agent can run a command, whatever tools it takes. Loop puts this
// on the PATH of each agent session it starts and tells it which session it is
// through LOOP_MAIL, so the same two things work everywhere:
//
//   loop-mail list                         who is in this project
//   loop-mail send "Session name" "text"   send one a message (it is woken if closed)
//
// The text can also come on standard input:  some-command | loop-mail send "Name" -
const http = require('http');

const HELP = [
  'Loop mailbox: reach the other sessions of this project.',
  '  loop-mail list                          every session here, and who is the boss',
  '  loop-mail send "Session name" "text"    send one a message; a closed session is woken',
  'Keep double quotes out of the text, or pass it on standard input:',
  '  echo your text | loop-mail send "Session name" -',
].join('\n');

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let all = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (all += d));
    process.stdin.on('end', () => resolve(all));
    process.stdin.on('error', () => resolve(all));
  });
}

function post(base, what, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(`${base}/${what}`);
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: u.hostname,
        port: u.port,
        path: u.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, Connection: 'close' },
        agent: false,
        timeout: 150000,
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (d) => (text += d));
        res.on('end', () => resolve({ ok: res.statusCode === 200, text }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('Loop did not answer in time.')));
    req.on('error', reject);
    req.end(data);
  });
}

async function main(argv, env) {
  const [what, to, ...rest] = argv;
  if (!what || what === 'help' || what === '--help' || what === '-h') return { code: 0, text: HELP };
  if (what !== 'list' && what !== 'send') return { code: 1, text: `loop-mail does not know "${what}".\n${HELP}` };
  const base = String(env.LOOP_MAIL || '');
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}\/mail\//.test(base))
    return { code: 1, text: 'loop-mail works inside a session that Loop started. Open this session from Loop and try again.' };
  let body = {};
  if (what === 'send') {
    if (!to) return { code: 1, text: `Say who it is for.\n${HELP}` };
    let text = rest.join(' ');
    if (!text.trim() || text.trim() === '-') text = await readStdin();
    if (!text.trim()) return { code: 1, text: `Say what you need.\n${HELP}` };
    body = { to, text };
  }
  try {
    const r = await post(base, what, body);
    return { code: r.ok ? 0 : 1, text: r.text || (r.ok ? '' : 'Loop refused that.') };
  } catch (e) {
    return {
      code: 1,
      text: /ECONNREFUSED|ECONNRESET/.test(String(e.code || e.message))
        ? 'Loop is not running, so the mailbox cannot be reached. Start Loop and open this session from it.'
        : `The mailbox could not be reached: ${e.message}`,
    };
  }
}

if (require.main === module) {
  main(process.argv.slice(2), process.env).then((r) => {
    if (r.text) process.stdout.write(r.text.replace(/\s+$/, '') + '\n');
    process.exitCode = r.code;
  });
}

module.exports = { main, HELP };
