// What the PC is doing right now, for the bar at the bottom of the window:
// processor, memory, graphics card, and how much of each is Loop itself.
const os = require('os');
const { spawn, execFile } = require('child_process');

let lastCpu = null;
let gpu = null; // { load, used, total } from the NVIDIA tool, when there is one
let gpuProc = null;
let macUsed = null; // bytes in use on macOS, from vm_stat
let macReading = false;

function cpuLoad() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    for (const v of Object.values(c.times)) total += v;
    idle += c.times.idle;
  }
  const prev = lastCpu;
  lastCpu = { idle, total };
  if (!prev || total === prev.total) return 0;
  return Math.round(100 * (1 - (idle - prev.idle) / (total - prev.total)));
}

// One long-lived reader that prints a line every few seconds; far cheaper than
// starting a tool for every sample. PCs without an NVIDIA card just show no GPU figure.
function watchGpu() {
  if (gpuProc) return;
  try {
    gpuProc = spawn('nvidia-smi', ['--query-gpu=utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits', '-l', '5'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return;
  }
  gpuProc.on('error', () => (gpu = null));
  gpuProc.on('exit', () => (gpu = null));
  gpuProc.stdout.on('data', (d) => {
    const line = String(d).trim().split(/\r?\n/).pop();
    const [load, used, total] = line.split(',').map((x) => Number(x));
    if (Number.isFinite(load)) gpu = { load, used, total };
  });
}

// macOS counts only never-touched pages as free, so total - freemem() reads near
// full on any Mac that has run for a while: the cache fills the rest, and the
// system hands it back the moment an app needs it. This is the figure Activity
// Monitor calls "Memory Used": app memory, wired, and what the compressor holds.
// Returns null when the text is not what vm_stat prints.
function macMemUsed(text) {
  const size = Number((/page size of (\d+) bytes/.exec(text) || [])[1]);
  const pages = (name) => {
    const m = new RegExp(`^${name}:\\s+(\\d+)`, 'm').exec(text);
    return m ? Number(m[1]) : null;
  };
  const anonymous = pages('Anonymous pages');
  const purgeable = pages('Pages purgeable') || 0;
  const wired = pages('Pages wired down');
  const compressed = pages('Pages occupied by compressor') || 0;
  if (!size || anonymous === null || wired === null) return null;
  return (anonymous - purgeable + wired + compressed) * size;
}

// vm_stat is read in the background, like the GPU, so a sample never waits on it;
// each sample shows the figure from the read before.
function readMacMem() {
  if (macReading) return;
  macReading = true;
  execFile('vm_stat', { timeout: 5000 }, (err, out) => {
    macReading = false;
    macUsed = err ? null : macMemUsed(String(out));
  });
}

function memUsed(total, platform = process.platform) {
  if (platform !== 'darwin') return total - os.freemem();
  readMacMem();
  return macUsed ?? total - os.freemem();
}

function stop() {
  if (gpuProc) gpuProc.kill();
  gpuProc = null;
}

// metrics: Electron's app.getAppMetrics()
function sample(metrics) {
  watchGpu();
  const total = os.totalmem();
  let appCpu = 0;
  let appMem = 0;
  for (const m of metrics || []) {
    appCpu += m.cpu.percentCPUUsage;
    appMem += m.memory.workingSetSize * 1024;
  }
  return {
    cpu: cpuLoad(),
    memUsed: memUsed(total),
    memTotal: total,
    gpu,
    appCpu: Math.round(appCpu / Math.max(1, os.cpus().length)), // share of the whole processor, like Task Manager
    appMem,
  };
}

module.exports = { sample, stop, macMemUsed };
