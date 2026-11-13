// Updates. An installed Loop on Windows looks at the newest release on GitHub
// (gursewak8427/loop), fetches a newer version in the background, and puts it
// in place with one click: Loop closes, the installer runs without asking, and
// Loop opens again with the sessions that were open. Quitting Loop also puts a
// fetched version in place.
//
// Copies that were not installed with the installer (built on this PC, or on a
// Mac or Linux for now) cannot update themselves; they say so and point to the
// download page.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const FIRST_CHECK = 20 * 1000;
const EVERY = 4 * 60 * 60 * 1000;
const PAGE = 'https://loop.prismaple.com/#download';

let updater = null;
let send = () => {};
let timer = null;
let state = { status: 'idle', version: app.getVersion(), next: '', percent: 0, error: '', checked: 0, can: false, why: '', page: PAGE };

// Download progress comes many times a percent: pass on only what changed.
function set(change) {
  const next = { ...state, ...change };
  const same = JSON.stringify(next) === JSON.stringify(state);
  state = next;
  if (!same) send(state);
}

// An installed copy carries app-update.yml beside its code; a copy built with
// "pack" does not.
function canUpdate() {
  if (!app.isPackaged) return 'This copy runs from source. Pull and rebuild to update it.';
  if (process.platform !== 'win32') return 'Updates for this system are not ready yet. Download the newest Loop from loop.prismaple.com.';
  if (!fs.existsSync(path.join(process.resourcesPath, 'app-update.yml'))) return 'This copy was built on this PC, not installed, so it updates when you rebuild it.';
  return '';
}

function init({ onState, autoDownload }) {
  send = onState;
  const why = canUpdate();
  if (why) return set({ can: false, why });
  ({ autoUpdater: updater } = require('electron-updater'));
  updater.logger = null;
  updater.autoDownload = autoDownload !== false;
  updater.autoInstallOnAppQuit = true;
  updater.allowPrerelease = false;

  updater.on('checking-for-update', () => set({ status: state.status === 'ready' ? 'ready' : 'checking', error: '' }));
  updater.on('update-not-available', () => set({ status: 'none', checked: Date.now() }));
  updater.on('update-available', (info) => set({ status: updater.autoDownload ? 'downloading' : 'available', next: info.version, percent: 0, checked: Date.now() }));
  updater.on('download-progress', (p) => set({ status: 'downloading', percent: Math.floor(p.percent || 0) }));
  updater.on('update-downloaded', (info) => set({ status: 'ready', next: info.version, percent: 100 }));
  updater.on('error', (e) => set({ status: state.status === 'ready' ? 'ready' : 'error', error: plain(e) }));

  set({ can: true, why: '' });
  timer = setTimeout(function again() {
    check().catch(() => {});
    timer = setTimeout(again, EVERY);
    timer.unref();
  }, FIRST_CHECK);
  timer.unref();
}

// What went wrong, in a line a person can act on.
function plain(e) {
  const m = String((e && e.message) || e || '');
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|net::ERR_/i.test(m)) return 'Could not reach GitHub. Check the connection and try again.';
  if (/sha512 checksum mismatch/i.test(m)) return 'The download did not match the release, so it was thrown away. Try again.';
  if (/404/.test(m)) return 'The newest release has no update file yet.';
  return m.split('\n')[0].slice(0, 200) || 'The update check failed.';
}

async function check() {
  if (!updater) return state;
  if (state.status === 'downloading' || state.status === 'ready') return state;
  try {
    await updater.checkForUpdates();
  } catch (e) {
    set({ status: 'error', error: plain(e) });
  }
  return state;
}

async function download() {
  if (!updater || state.status !== 'available') return state;
  set({ status: 'downloading', percent: 0 });
  try {
    await updater.downloadUpdate();
  } catch (e) {
    set({ status: 'error', error: plain(e) });
  }
  return state;
}

function setAuto(on) {
  if (updater) updater.autoDownload = on !== false;
}

// Closes Loop and runs the installer quietly; it opens Loop again when done.
function install(beforeQuit) {
  if (!updater || state.status !== 'ready') return false;
  beforeQuit();
  setImmediate(() => updater.quitAndInstall(true, true));
  return true;
}

function stop() {
  if (timer) clearTimeout(timer);
}

module.exports = { init, check, download, install, setAuto, stop, get: () => state };
