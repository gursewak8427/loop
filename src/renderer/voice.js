/* global deck, MOD, S, toast, sessionTitle, sessionById, renderTools, tabFor, sayTo, projectTitle */
'use strict';

// ---------- voice mode ----------
// Talking to one session while still reading and typing to it: the bar sits
// inside that session's pane, so the terminal stays in front of you.
//
// It works like a walkie-talkie, because the microphone is open in a room with
// other people in it:
//   - Nothing is sent until you call it by name: "hey Loop".
//   - After that you talk for as long as you like. Saying "over" sends it.
//   - While it is speaking, calling it by name again stops it and starts a
//     new message.
// Anything else said in the room is read on this PC to see whether the name
// was in it, and then dropped. Nothing is sent anywhere, and nothing leaves
// this PC at any point: both the ear and the voice are models running here.
//
// The window holds the microphone and plays the voice because Chromium only
// cancels the echo of sound it played itself. That is what lets this work on
// speakers, with no headphones, without the session hearing itself.

const FRAME_MS = 20;
const SPEECH_ON = 7; // ~140 ms of sound before it counts as talking
const SPEECH_OFF = 35; // ~700 ms of quiet ends one stretch of talking
const BARGE_ON = 5; // while it speaks, ~100 ms is enough to start listening closely
const LONGEST = 1500; // 30 s, so a stuck microphone cannot run forever
const SHORTEST = 18; // under ~360 ms is a cough, a click or a door
const OVER_FLOOR = 3.2; // how far above the room's own noise counts as speech
const QUIET = 0.004; // a silent room still has some number in it
const PRE_ROLL = 12; // ~240 ms kept back, so the start of the first word is there
const SETTLE = 150; // 3 s of a steady, louder room before it becomes the floor
const WARM = 25; // half a second of listening to the room before deciding anything
const FLOOR_MAX = 0.05; // louder than this is somebody talking, never the room
const RECENT_MS = 45000; // how far back the voice's own words are remembered
const ECHO_SHARE = 0.7; // share of heard words that must be the voice's own

const newEar = () => ({ floor: QUIET, settling: 0, warm: WARM, loud: 0, quiet: 0, on: false, frames: 0 });

/**
 * One frame of sound, and what it means. Returns 'start' when someone began
 * talking, 'end' when they stopped, 'barge' while the voice is speaking and
 * somebody started talking over it, 'drop' for something too short to be
 * words, or '' for nothing yet.
 */
function earStep(ear, rms, speaking) {
  // Half a second of only listening first: whatever is already playing when
  // voice mode opens is the room, not the first thing said. Anything loud in
  // that half second is somebody talking, so it is left out of the floor
  // rather than raising it and making them inaudible.
  if (ear.warm > 0) {
    ear.warm--;
    if (rms < FLOOR_MAX) ear.floor = Math.max(QUIET, ear.floor, rms);
    return '';
  }
  // The room's own noise is the quietest thing heard lately. A drop is taken
  // at once; a louder room is accepted only after a few seconds of it, and
  // never in the middle of something being said. Followed as an average
  // instead, a fan that is already running would be part of the average from
  // the start and so count as speech, and the whole fan would be one long
  // thing said, with nothing after it ever heard.
  if (rms < ear.floor) {
    ear.floor = Math.max(QUIET, rms);
    ear.settling = 0;
  } else if (!ear.on && ++ear.settling > SETTLE) {
    ear.floor = Math.max(QUIET, Math.min(rms, ear.floor * 2));
    ear.settling = 0;
  }
  const over = rms > Math.max(QUIET, ear.floor * OVER_FLOOR);
  ear.loud = over ? ear.loud + 1 : 0;
  ear.quiet = over ? 0 : ear.quiet + 1;
  if (!ear.on) {
    if (ear.loud >= (speaking ? BARGE_ON : SPEECH_ON)) {
      ear.on = true;
      ear.frames = ear.loud;
      return speaking ? 'barge' : 'start';
    }
    return '';
  }
  ear.frames++;
  if (ear.quiet >= SPEECH_OFF || ear.frames >= LONGEST) {
    const long = ear.frames - ear.quiet >= SHORTEST;
    ear.on = false;
    ear.loud = 0;
    ear.quiet = 0;
    ear.frames = 0;
    return long ? 'end' : 'drop';
  }
  return '';
}

const words = (t) => String(t).toLowerCase().match(/[a-z0-9']+/g) || [];

/**
 * Safety net for echo the canceller lets through: words that are mostly the
 * voice's own, heard while it was speaking or just after, are its own sound
 * coming back and not something anybody said.
 */
function isEcho(text, spoken, speaking, lastEnd, now) {
  if (!speaking && now - lastEnd > 3000) return false;
  const recent = new Set();
  for (const s of spoken) if (now - s.at <= RECENT_MS) words(s.text).forEach((w) => recent.add(w));
  const heard = words(text);
  if (!heard.length) return false;
  return heard.filter((w) => recent.has(w)).length / heard.length >= ECHO_SHARE;
}

/** Sounds that are not words: a cough, a door, a note the ear wrote about noise. */
const tooLittle = (text) => {
  const t = String(text || '').trim();
  const w = words(t);
  if (!w.length) return true;
  if (/^[([]/.test(t) && /[)\]]$/.test(t)) return true;
  return w.length === 1 && w[0].length < 3;
};

// ---------- the state of it ----------

const V = {
  on: false,
  p: null,
  s: null,
  look: 'off', // off | starting | listening | hearing | thinking | speaking
  note: '',
  lastHeard: '', // the last thing it heard, shown in the bar
  spoken: [], // { text, at } the voice's own words, for the echo net
  lastEnd: 0,
  queue: [],
  playing: null,
  fetching: 0,
  turn: 0, // bumped by every interruption, so late sound is dropped
  told: false, // whether this session has the voice rules yet
  level: 0,
  ear: newEar(),
  frames: [],
  before: [], // the moments just before speech started, kept so no word is clipped
  rate: 16000, // what the microphone frames actually come in at
  ctx: null,
  stream: null,
  node: null,
  el: null,
  pane: null,
  busy: false,
  started: false,
  quietTimer: null,
  spokenIds: new Set(),
};

const speaking = () => !!V.playing || V.queue.length > 0 || V.fetching > 0;

function look(name, note) {
  V.look = name;
  if (note !== undefined) V.note = note;
  paint();
}

// ---------- the bar, inside the session's own pane ----------

const LOOKS = {
  starting: 'Getting ready',
  listening: 'Listening',
  hearing: 'Hearing you',
  thinking: 'Working',
  speaking: 'Speaking — talk over it to stop it',
};

function paint() {
  if (!V.el) return;
  const orb = V.el.querySelector('.voice-orb');
  orb.className = 'voice-orb is-' + V.look;
  orb.style.setProperty('--level', String(Math.min(1, V.level).toFixed(3)));
  V.el.querySelector('.voice-state').textContent = LOOKS[V.look] || 'Voice';
  V.el.querySelector('.voice-heard').textContent = V.note || V.lastHeard || '';
  V.el.classList.toggle('has-note', Boolean(V.note));
  V.el.querySelector('.voice-mute').hidden = !speaking();
}

function voiceView() {
  const el = document.createElement('div');
  el.className = 'voice-bar';
  el.innerHTML = [
    '<span class="voice-orb is-starting"><span class="voice-ring"></span><span class="voice-core"></span></span>',
    '<span class="voice-words"><span class="voice-state">Voice</span><span class="voice-heard"></span></span>',
    '<button class="voice-mute" tabindex="-1" hidden>Stop talking</button>',
    `<button class="voice-close" tabindex="-1" title="Leave voice mode (${MOD}+Shift+V)">Leave</button>`,
  ].join('');
  // The terminal keeps the keyboard: a click on the bar must not take focus
  // away from what you are typing.
  el.addEventListener('mousedown', (e) => e.preventDefault());
  el.querySelector('.voice-close').onclick = () => {
    closeVoice();
    if (typeof renderTools === 'function') renderTools();
  };
  el.querySelector('.voice-mute').onclick = () => {
    interrupt();
    look('listening', '');
  };
  return el;
}

// ---------- speaking ----------

function interrupt() {
  V.turn++;
  V.queue.length = 0;
  if (V.playing) {
    try {
      V.playing.stop();
    } catch {
      /* already finished */
    }
    V.playing = null;
  }
  V.lastEnd = Date.now();
  V.level = 0;
}

function playNext() {
  if (V.playing || !V.queue.length || !V.ctx) return;
  const { pcm, rate, turn } = V.queue.shift();
  if (turn !== V.turn) return playNext();
  const buf = V.ctx.createBuffer(1, pcm.length, rate);
  buf.getChannelData(0).set(pcm);
  const src = V.ctx.createBufferSource();
  src.buffer = buf;
  src.connect(V.ctx.destination);
  V.playing = src;
  look('speaking');
  let at = 0;
  const step = Math.max(1, Math.floor(rate / 50));
  const timer = setInterval(() => {
    if (V.playing !== src) return clearInterval(timer);
    let sum = 0;
    for (let i = at; i < Math.min(at + step, pcm.length); i++) sum += pcm[i] * pcm[i];
    V.level = Math.min(1, Math.sqrt(sum / step) * 6);
    at += step;
    paint();
  }, FRAME_MS);
  src.onended = () => {
    clearInterval(timer);
    if (V.playing !== src) return;
    V.playing = null;
    V.lastEnd = Date.now();
    V.level = 0;
    if (V.queue.length) return playNext();
    look(V.busy ? 'thinking' : 'listening', '');
  };
  src.start();
}

/** Say what the session wrote, sentence by sentence so the first words come quickly. */
async function sayOut(text) {
  let plan = null;
  try {
    plan = await deck.voicePlan(text);
  } catch (e) {
    return look(V.look, e.message);
  }
  if (!plan || !plan.spoken || !plan.parts.length) return;
  V.spoken.push({ text: plan.spoken, at: Date.now() });
  V.spoken = V.spoken.filter((s) => Date.now() - s.at <= RECENT_MS);
  const turn = V.turn;
  for (const part of plan.parts) {
    if (turn !== V.turn) return;
    V.fetching++;
    try {
      const sound = await deck.voiceSay(part);
      if (turn !== V.turn) return;
      V.queue.push({ pcm: sound.pcm, rate: sound.rate, turn });
      playNext();
    } catch (e) {
      return look(V.look, e.message);
    } finally {
      V.fetching--;
    }
  }
}

// ---------- hearing ----------

async function heardSomething(frames) {
  const total = frames.reduce((n, f) => n + f.length, 0);
  if (!total) return;
  const pcm = new Float32Array(total);
  let at = 0;
  for (const f of frames) {
    pcm.set(f, at);
    at += f.length;
  }
  const was = V.look;
  if (!speaking()) look('hearing');
  let text = '';
  try {
    text = (await deck.voiceHear(pcm, V.rate || 16000, ourNames())).text || '';
  } catch (e) {
    return look(was, e.message);
  }
  if (!V.on) return;
  if (!text || tooLittle(text) || isEcho(text, V.spoken, speaking(), V.lastEnd, Date.now())) return settle();
  takeIt(text);
}

/**
 * What this user's things are called: project names, servers, and the names
 * of the sessions themselves. A general ear has never heard "Venli" and
 * writes "Benny"; given the list, the name can be put back afterwards.
 */
function ourNames() {
  const out = new Set();
  for (const p of S.projects || []) {
    out.add(projectTitle(p));
    for (const bit of String(p.name || '').split(/[^A-Za-z0-9]+/)) if (bit.length >= 4) out.add(bit);
    for (const sn of p.sessions || []) out.add(sessionTitle(sn));
  }
  for (const srv of (S.config && S.config.servers) || []) out.add(srv.name);
  return [...out].filter((n) => n && n.length >= 4 && n.length <= 24).slice(0, 120);
}

/** Back to whichever quiet state we were in before listening closely. */
const settle = () => look(V.busy ? 'thinking' : 'listening', '');

/**
 * One stretch of speech, once it is words. The mic button is the whole of the
 * switch: while voice mode is on, what you say goes to the session, and if it
 * was talking, it stops first.
 */
function takeIt(text) {
  if (speaking()) interrupt();
  V.lastHeard = text;
  sendOn(text);
}

async function sendOn(text) {
  V.busy = true;
  look('thinking', '');
  // The session is told how to answer out loud once, when voice mode starts.
  const say = V.told ? text : (await deck.voiceRules()) + '\n\n' + text;
  V.told = true;
  // Loop's own way of reaching a session: typed into its terminal when one is
  // open, started in the background when none is. Sending it straight to the
  // background runner instead leaves a session that is open in a terminal
  // waiting for a message that never arrives.
  const r = await sayTo(V.p, V.s, say);
  if (r && r.ok === false) {
    V.busy = false;
    look('listening', r.text || 'That could not be sent.');
  }
}

// ---------- what the session writes ----------

function onChat(msg) {
  if (!V.on || !msg || !Array.isArray(msg.items)) return;
  // The first read brings the whole conversation; those were written before
  // voice mode started, so they are remembered rather than read out.
  const quiet = msg.reset && !V.started;
  for (const item of msg.items) {
    if (item.k !== 'text' || item.command || !item.text) continue;
    if (V.spokenIds.has(item.id)) continue;
    V.spokenIds.add(item.id);
    if (!quiet) sayOut(item.text);
  }
  if (msg.reset) V.started = true;
  clearTimeout(V.quietTimer);
  V.quietTimer = setTimeout(() => {
    V.busy = false;
    if (V.on && !speaking() && V.look === 'thinking') settle();
  }, 1500);
}

// ---------- starting and leaving ----------

async function openVoice(p, s) {
  if (V.on) closeVoice();
  if (!p || !s) return;
  if (p.server) return toast('Voice mode runs on the PC that holds the session.', true);
  const tab = typeof tabFor === 'function' ? tabFor(s.id) : null;
  const pane = tab && tab.pane;
  if (!pane) return toast('Open the session first: the voice sits in its terminal.', true);
  V.on = true;
  V.p = p;
  V.s = s;
  V.lastHeard = '';
  V.spoken = [];
  V.spokenIds = new Set();
  V.told = false;
  V.started = false;
  V.ear = newEar();
  V.frames = [];
  V.before = [];
  V.pane = pane;
  V.el = voiceView();
  pane.appendChild(V.el);
  look('starting', 'Loading the voice');

  const state = await deck.voiceState();
  if (!state.node) return look('starting', state.why || 'Voice needs Node on this PC.');
  try {
    V.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (e) {
    return look('starting', 'No microphone: ' + e.message);
  }
  V.ctx = new AudioContext();
  // Started before the page has had a click, it can come up held: then every
  // answer would be made and queued and never heard.
  if (V.ctx.state === 'suspended') await V.ctx.resume().catch(() => {});
  await V.ctx.audioWorklet.addModule('voice-worklet.js');
  const src = V.ctx.createMediaStreamSource(V.stream);
  V.node = new AudioWorkletNode(V.ctx, 'voice-frames');
  src.connect(V.node);
  // Read, not played: connecting this to the output would put the microphone
  // through the speakers.
  V.node.port.onmessage = (e) => onFrame(e.data);

  deck.voiceFollow({ dir: p.dir, sessionId: s.id, server: p.server || '' });
  try {
    await deck.voiceWarm('hear');
    await deck.voiceWarm('say');
  } catch (e) {
    return look('starting', e.message);
  }
  look('listening', '');
}

function onFrame(f) {
  if (!V.on) return;
  if (f.rate) V.rate = f.rate;
  const was = speaking();
  const event = earStep(V.ear, f.rms, was);
  if (!was) {
    V.level = Math.min(1, f.rms * 8);
    if (V.look === 'listening') paint();
  }
  // Talking over it stops it on the sound itself, not on the words: waiting
  // for what was said to be read first would leave it talking for a second
  // after being cut off.
  if (event === 'barge') {
    interrupt();
    look('listening', '');
  }
  // The ear only knows someone is talking about 140 ms in. Without the frames
  // from just before that, the first word arrives with its beginning cut off,
  // and a clipped first word is read as a different word.
  if (event === 'start' || event === 'barge') V.frames = V.before.concat([f.pcm]);
  else if (V.ear.on) V.frames.push(f.pcm);
  if (!V.ear.on) {
    V.before.push(f.pcm);
    if (V.before.length > PRE_ROLL) V.before.shift();
  } else {
    V.before = [];
  }
  if (event === 'end') {
    const frames = V.frames;
    V.frames = [];
    heardSomething(frames);
  }
  if (event === 'drop') V.frames = [];
}

function closeVoice() {
  if (!V.on) return;
  V.on = false;
  interrupt();
  clearTimeout(V.quietTimer);
  try {
    deck.voiceUnfollow();
  } catch {
    /* nothing was being followed */
  }
  if (V.node) V.node.port.onmessage = null;
  if (V.stream) V.stream.getTracks().forEach((t) => t.stop());
  if (V.ctx) V.ctx.close();
  V.ctx = null;
  V.stream = null;
  V.node = null;
  if (V.el) V.el.remove();
  V.el = null;
  V.pane = null;
  V.look = 'off';
}

/** Whether voice mode is on, for the button in the bar. */
const voiceOn = () => V.on;

/** The button, and Ctrl+Shift+V (Cmd on a Mac): talk to whichever session is in front. */
function toggleVoice() {
  if (V.on) {
    closeVoice();
    if (typeof renderTools === 'function') renderTools();
    return;
  }
  const tab = S.tabs.get(S.active);
  const { p, s } = sessionById((tab && tab.sessionId) || '');
  if (!p || !s) return toast('Open a session first, then talk to it.', true);
  openVoice(p, s).then(() => typeof renderTools === 'function' && renderTools());
  if (typeof renderTools === 'function') renderTools();
}

// ---------- choosing the voice ----------

/**
 * The voice to answer in, for Settings. Which voices there are comes from the
 * speech process, so this is empty when this PC cannot run it at all.
 */
async function voiceField() {
  let list = [];
  try {
    const st = await deck.voiceState();
    if (!st.node) return [];
    list = await deck.voiceVoices();
  } catch {
    return []; // Settings should still open
  }
  if (!list.length) return [];
  const value = (S.config.settings && S.config.settings.voiceName) || 'af_heart';
  return [
    {
      key: 'voiceName',
      label: 'Voice to answer in',
      type: 'select',
      value: list.some((v) => v.id === value) ? value : list[0].id,
      options: list.map((v) => ({ value: v.id, label: `${v.name || v.id}${v.gender ? ' · ' + v.gender : ''}` })),
      hint: `Used by voice mode (${MOD}+Shift+V). Pick one and Loop says a line in it so you can hear it.`,
    },
  ];
}

/** One line in a voice, so a choice can be made by ear rather than by name. */
async function hearVoice() {
  try {
    const sound = await deck.voiceSay('Hello. This is how I sound in voice mode.');
    const ctx = new AudioContext();
    const buf = ctx.createBuffer(1, sound.pcm.length, sound.rate);
    buf.getChannelData(0).set(sound.pcm);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.onended = () => ctx.close();
    src.start();
  } catch (e) {
    toast(e.message, true);
  }
}

if (typeof deck !== 'undefined' && deck.onVoiceChat) {
  deck.onVoiceChat((msg) => onChat(msg));
  deck.onVoiceEvent((e) => {
    if (V.on && e.t === 'gone') look(V.look, e.why || 'The voice stopped.');
  });
  // A question the session is waiting on is read out: in voice mode nobody is
  // watching for it. Answering stays on the keyboard, because picking an
  // option by mishearing would be worse than turning to the terminal.
  deck.onDirectAsk((sessionId, ask) => {
    if (!V.on || !V.s || sessionId !== V.s.id || !ask || !ask.question) return;
    if (V.spokenIds.has('ask:' + ask.key)) return;
    V.spokenIds.add('ask:' + ask.key);
    V.busy = false;
    sayOut(ask.question + ' Answer it on screen.');
  });
}
