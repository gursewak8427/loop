import 'package:flutter/foundation.dart';
import 'package:flutter_tts/flutter_tts.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:speech_to_text/speech_recognition_error.dart';
import 'package:speech_to_text/speech_recognition_result.dart';
import 'package:speech_to_text/speech_to_text.dart';

/// Speaking to Loop and having it read back, with the phone's own speech:
/// nothing leaves the phone for this, and no tokens are spent on it.
///
/// One language for both directions, chosen once (English, Hindi or Punjabi).
class Voice {
  Voice._();
  static final Voice I = Voice._();

  static const langs = [
    ['en-IN', 'English'],
    ['hi-IN', 'हिन्दी'],
    ['pa-IN', 'ਪੰਜਾਬੀ'],
  ];

  // Made on first use: both talk to the platform, which is not ready while
  // main() is still starting the app.
  late final _stt = SpeechToText();
  late final _tts = FlutterTts();
  bool _sttReady = false;

  /// en-IN, hi-IN or pa-IN.
  final lang = ValueNotifier<String>('en-IN');

  /// Words heard so far, while listening.
  final heard = ValueNotifier<String>('');
  final listening = ValueNotifier<bool>(false);

  /// What went wrong, in words someone can act on; empty when nothing did.
  final problem = ValueNotifier<String>('');

  /// The id of what is being read aloud, or null.
  final speaking = ValueNotifier<String?>(null);

  /// How many voices the phone has to read with: -1 until it has been asked.
  /// Zero is its own kind of broken and worth saying out loud on screen.
  final voices = ValueNotifier<int>(-1);

  bool _unlocked = false;

  /// Let the page speak.
  ///
  /// A browser will not read anything out unless the reading began with
  /// something the person did, and it forgets that within a few seconds - so
  /// by the time an answer comes back from the PC the permission is long gone
  /// and the words are dropped with no error at all. The way through is to say
  /// one silent thing while the tap is still warm, which lifts it for the rest
  /// of the visit. The voices also arrive late on the web, so this is where
  /// they are waited for.
  Future<void> unlock() async {
    if (_unlocked) return;
    _unlocked = true;
    try {
      for (var i = 0; i < 12; i++) {
        final have = await _tts.getVoices;
        final n = have is List ? have.length : 0;
        voices.value = n;
        if (n > 0) break;
        await Future.delayed(const Duration(milliseconds: 150));
      }
      await _tts.setVolume(0);
      await _tts.speak(' ');
      await _tts.stop();
      await _tts.setVolume(1);
    } catch (_) {
      // Nothing here is worth stopping for: the reading is tried anyway.
    }
  }

  Future<void> load() async {
    try {
      final p = await SharedPreferences.getInstance();
      final saved = p.getString('voiceLang');
      if (saved != null && langs.any((l) => l[0] == saved)) lang.value = saved;
    } catch (_) {}
  }

  Future<void> setLang(String code) async {
    lang.value = code;
    try {
      (await SharedPreferences.getInstance()).setString('voiceLang', code);
    } catch (_) {}
  }

  String get _sttLocale => kIsWeb ? lang.value : lang.value.replaceAll('-', '_');

  // ---- listening ----

  Future<bool> _ensure() async {
    if (_sttReady) return true;
    try {
      _sttReady = await _stt.initialize(onError: _onError, onStatus: _onStatus);
    } catch (_) {
      _sttReady = false;
    }
    if (!_sttReady) {
      // On the web this is either a browser with no speech in it or, far more
      // often, a machine with no microphone: say both, since the way out
      // differs.
      problem.value = kIsWeb
          ? 'No microphone here, or this browser will not allow one. Open Loop in Chrome on your phone, or type instead.'
          : 'Loop needs the microphone. Allow it in the phone settings, or type instead.';
    }
    return _sttReady;
  }

  /// Start listening. [heard] fills as words come; it stops by itself after
  /// [pause] without words. Dictation keeps the long default, so a moment of
  /// thought does not cut a message short; voice mode passes a shorter one.
  Future<void> listen({Duration pause = const Duration(seconds: 4)}) async {
    problem.value = '';
    heard.value = '';
    if (!await _ensure()) return;
    await stopSpeaking();
    try {
      await _stt.listen(
        onResult: _onResult,
        listenOptions: SpeechListenOptions(
          localeId: _sttLocale,
          listenFor: const Duration(minutes: 2),
          pauseFor: pause,
          partialResults: true,
          listenMode: ListenMode.dictation,
          cancelOnError: true,
        ),
      );
      listening.value = true;
    } catch (_) {
      listening.value = false;
      problem.value = 'Could not start listening. Try again, or type instead.';
    }
  }

  Future<void> stop() async {
    try {
      await _stt.stop();
    } catch (_) {}
    listening.value = false;
  }

  void _onResult(SpeechRecognitionResult r) {
    heard.value = r.recognizedWords;
    if (r.finalResult) listening.value = false;
  }

  void _onStatus(String s) {
    if (s == 'done' || s == 'notListening') listening.value = false;
  }

  void _onError(SpeechRecognitionError e) {
    listening.value = false;
    final m = e.errorMsg;
    problem.value = m.contains('no_match') || m.contains('speech_timeout')
        ? 'Nothing heard. Tap the mic and speak again.'
        : m.contains('network')
        ? 'Listening needs the internet on this phone. Type instead, or try again.'
        : m.contains('language') || m.contains('not_available')
        ? 'This language is not on the phone. Pick another, or add it in the phone settings.'
        : m.contains('permission') || m.contains('not-allowed')
        ? 'Loop needs the microphone. Allow it, or type instead.'
        : 'Listening stopped. Tap the mic to try again.';
  }

  // ---- reading aloud ----

  /// Read [text] aloud, as plain words: markdown, links and code marks are left out.
  Future<void> speak(String id, String text) async {
    await stop();
    if (speaking.value == id) return stopSpeaking();
    // Anything still half-said is cut off first. On the web a voice that is
    // already talking makes the next line vanish without a word of complaint,
    // which is silence that looks like a hang.
    try {
      await _tts.stop();
    } catch (_) {}
    speaking.value = id;
    try {
      // The voice follows the words: Devanagari is read in Hindi, Gurmukhi in
      // Punjabi, anything else in English.
      final say = RegExp(r'[ऀ-ॿ]').hasMatch(text)
          ? 'hi-IN'
          : RegExp(r'[਀-੿]').hasMatch(text)
          ? 'pa-IN'
          : 'en-IN';
      await _tts.setLanguage(say);
      await _tts.setSpeechRate(kIsWeb ? 1.0 : 0.5);
      await _tts.setVolume(1);
      _tts.setCompletionHandler(() => speaking.value = null);
      _tts.setCancelHandler(() => speaking.value = null);
      _tts.setErrorHandler((_) => speaking.value = null);
      await _tts.speak(plain(text));
    } catch (_) {
      speaking.value = null;
    }
  }

  Future<void> stopSpeaking() async {
    speaking.value = null;
    try {
      await _tts.stop();
    } catch (_) {}
  }

  /// Markdown made sayable: bullets become pauses, marks and links go.
  ///
  /// Addresses, file paths and commands are for the screen. Read out they are
  /// a minute of "h t t p s colon slash slash" that nobody can act on, so they
  /// are dropped here and left in the words on screen.
  static String plain(String md) => md
      .replaceAll(RegExp(r'```[\s\S]*?```'), ' ')
      .replaceAllMapped(RegExp(r'\[([^\]]+)\]\([^)]+\)'), (m) => m[1]!)
      .replaceAll(RegExp(r'https?://\S+'), ' ')
      .replaceAll(RegExp(r'\b[A-Za-z]:\\\S+'), ' ')
      // A path, by the shape of it: parts joined by slashes, or one with a
      // file's ending on it. Not "and/or", not "24/7".
      .replaceAll(RegExp(r'\S+[\\/]\S+[\\/]\S+'), ' ')
      .replaceAll(RegExp(r'\S+[\\/]\S+\.[A-Za-z0-9]{1,5}\b'), ' ')
      .replaceAll(RegExp(r'[`*_#>|]'), '')
      .replaceAll(RegExp(r'^\s*[-•]\s+', multiLine: true), '')
      .replaceAll(RegExp(r'\n+'), '. ')
      .replaceAll(RegExp(r'\s{2,}'), ' ')
      .replaceAll(RegExp(r'\.\s*\.'), '.')
      .trim();
}
