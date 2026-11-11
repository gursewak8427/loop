// Checks that a built phone app still has speech in it.
//
//   node scripts/check-web.js            checks src/web (what `npm run web` builds)
//   node scripts/check-web.js hosted     checks another build folder
//
// Flutter lists the web plugins in a generated "plugin registrant". When that
// file goes stale, an incremental `flutter build web` keeps reusing it, so
// speech_to_text and flutter_tts are resolved but never compiled in. The phone
// then says "No microphone here", which sends you looking in the wrong place.
// Failing the build here points at the real fix instead.

const fs = require('fs');
const path = require('path');

// One browser API from each speech plugin: listening, then reading out.
const NEEDED = [
  ['webkitSpeechRecognition', 'speech_to_text'],
  ['SpeechSynthesisUtterance', 'flutter_tts'],
];

// Returns the plugins whose code is missing from dir/main.dart.js.
function missingSpeech(dir) {
  const file = path.join(dir, 'main.dart.js');
  if (!fs.existsSync(file)) throw new Error(`${file} not found: build the phone app first`);
  const js = fs.readFileSync(file, 'utf8');
  return NEEDED.filter(([api]) => !js.includes(api)).map(([, plugin]) => plugin);
}

if (require.main === module) {
  const dir = path.resolve(__dirname, '..', process.argv[2] || path.join('src', 'web'));
  let missing;
  try {
    missing = missingSpeech(dir);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  if (missing.length) {
    console.error(
      `The phone app was built without ${missing.join(' and ')}, so it would have no speech.\n` +
        'Flutter reused a stale plugin list. Run `cd app && flutter clean`, then build again.',
    );
    process.exit(1);
  }
}

module.exports = { missingSpeech };
