import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'bridge.dart' show Link;
import 'main.dart';
import 'theme.dart';
import 'voice.dart';

/// Talking to one session with your eyes shut.
///
/// The phone listens, sends what you said to that session, waits for the turn
/// to finish, reads the answer out, and then listens again by itself. One
/// session, one conversation: nothing here switches to another.
///
/// Turn taking is strict, and that is on purpose. The phone speaks through its
/// own loudspeaker, a hand's width from its own microphone, so if it listened
/// while it talked it would hear itself and answer that. It listens, then it
/// talks, then it listens - like a walkie-talkie, except you never have to say
/// anything to hand the turn over. A pause ends yours, and a tap anywhere cuts
/// its answer short when you have heard enough.
///
/// The listening and the voice are the phone's own, so the words come out as
/// well as anything else you dictate on it, and no sound leaves the phone.
///
/// The loop below holds every decision and knows nothing about microphones,
/// sockets or widgets, so a whole conversation can be played out in a test.
/// The screen owns the clock: how long to wait for a turn to settle, and how
/// long a voice could still be talking.

/// How a session should answer while it is being listened to rather than read.
/// Sent once per session, with the first thing you say.
const talkRules =
    'Voice mode is on: the user is speaking to you from a phone and your reply '
    'is read out loud by the phone. Answer in one or two short spoken '
    'sentences, the answer first, the way you would say it to someone next to '
    'you. Never read code, file paths, URLs, commands, lists or headings '
    'aloud: leave them in your reply for the screen and say they are on '
    'screen. No markdown, no bullets, no numbering, no emoji in what you say. '
    'Never go quiet: before you read a file, run a command, search, or check '
    'anything at all, first say one short line about what you are going to '
    'look at, then go and do it. Say it before the tool, not after - silence '
    'on a phone sounds like you have gone away. If the work goes on, say a '
    'line as you go. When it is done say what changed in a sentence, not a '
    'report. If you did not catch something, ask for it in one short '
    'question.';

/// Sessions already told the rules, so a second visit does not repeat them.
final _told = <String>{};

/// Past this a reply is a report, not something to listen to.
const spokenMax = 450;

/// How long a session may work without a word read out before the phone says
/// it is still going. With your eyes shut, silence sounds like it has stopped.
const stillWorkingAfter = Duration(seconds: 15);

/// What the phone says then, in turn, so it is not the same line every time.
const stillWorkingLines = [
  'Still working on it.',
  'Still on it.',
  'Still going.',
];

/// What the loop is doing now. The words are the ones shown on screen.
enum Turn { listening, sending, working, speaking, resting }

/// One line of the conversation, as far as the loop cares: assistant words are
/// read out, everything else stays on the screen.
typedef Line = ({String id, String kind, String text});

/// The phone's listening and voice.
abstract class TalkVoice {
  void listen();
  void stopListening();
  void speak(String text);
  void stopSpeaking();
}

/// The session being talked to.
abstract class TalkSession {
  bool get reachable;
  bool get busy;

  /// Sends it, or gives back why it could not.
  Future<String?> send(String text);

  /// Keep it until the session, or the PC, can take it.
  void queue(String text, {bool afterTurn = false});

  /// An option picked on the question on screen.
  void answer(String key, String words, {required bool direct});

  /// Stop what it is doing.
  void stopWork();
}

/// Listening, saying, waiting, reading out, and whose turn it is next.
class TalkLoop extends ChangeNotifier {
  TalkLoop({
    required this.voice,
    required this.session,
    required this.sessionKey,
    Iterable<Line> alreadyThere = const [],
    Map<String, dynamic>? askOnScreen,
  }) {
    // The conversation so far is there to be read, not heard.
    for (final l in alreadyThere) {
      _readOut.add(l.id);
    }
    if (askOnScreen != null) _askRead = askId(askOnScreen);
  }

  final TalkVoice voice;
  final TalkSession session;
  final String sessionKey;

  Turn turn = Turn.resting;
  String said = ''; // the last thing you said
  String reply = ''; // the last thing it read out
  String problem = '';

  /// A question on screen that your next words will answer.
  Map<String, dynamic>? asking;

  final _readOut = <String>{};
  String? _askRead;
  int _quiet = 0; // times in a row nothing was heard
  bool _thenYours = true;
  bool left = false;
  String _saying = ''; // what the voice is saying now
  int _stillSaid = 0; // "still working" said since anything real was read out
  bool _filling = false; // what is being said is only that
  ({List<Line> lines, bool thenYours})? _missed; // words that came meanwhile

  /// True while the screen should keep a watch on a voice that may never say
  /// it has finished.
  bool get speaking => turn == Turn.speaking;

  void _to(Turn t) {
    turn = t;
    notifyListeners();
  }

  // ---- your turn ----

  void start() => listen();

  void listen() {
    if (left) return;
    problem = '';
    _stillSaid = 0;
    _missed = null;
    _to(Turn.listening);
    voice.listen();
  }

  /// The phone stopped listening - after a pause, or because you tapped.
  /// Whatever it has is the whole of what you said.
  void heard(String words) {
    if (left || turn != Turn.listening) return;
    final text = words.trim();
    if (text.isEmpty) {
      _quiet++;
      // Twice with nothing in it is a pocket, a quiet room, or a microphone
      // that is not working. Rather than listen for ever, it waits for a tap.
      if (_quiet >= 2) {
        _to(Turn.resting);
      } else {
        listen();
      }
      return;
    }
    _quiet = 0;
    said = text;
    final ask = asking;
    if (ask != null) {
      _answer(ask, text);
    } else {
      _send(text);
    }
  }

  /// The phone cannot listen: no permission, no microphone, wrong browser.
  void trouble(String why) {
    if (left || why.isEmpty) return;
    problem = why;
    _to(Turn.resting);
  }

  Future<void> _send(String words) async {
    _to(Turn.sending);
    if (!session.reachable) {
      session.queue(words);
      return _say(
        'Your PC is not there. I kept it, and it goes when it answers again.',
      );
    }
    // A session still working is left to finish: the words go the moment it is
    // free, which is what the chat screen does with a message typed too early.
    if (session.busy) {
      session.queue(words, afterTurn: true);
      _to(Turn.working);
      return;
    }
    final first = !_told.contains(sessionKey);
    final why = await session.send(first ? '$talkRules\n\n$words' : words);
    if (left) return;
    if (why == null) {
      _told.add(sessionKey);
      _to(Turn.working);
      return;
    }
    problem = why;
    _say('That did not go through. Tap and say it again.');
  }

  /// A question the session is waiting on, answered by voice. An option is
  /// taken only when it was named plainly - a number, yes or no, or its own
  /// words. Nothing here guesses, because what is being answered may be a
  /// permission to change something.
  void _answer(Map<String, dynamic> ask, String words) {
    final options = ((ask['options'] ?? const []) as List).cast<Map>();
    final direct = ask['direct'] == true;
    final pick = pickOption(options, words);
    if (pick == null && options.isNotEmpty) {
      // Not clearly one of them: read them again rather than send anything.
      return _say('I did not catch which one. ${optionWords(options)}');
    }
    asking = null;
    _to(Turn.working);
    if (pick != null) {
      session.answer(pick['key'] as String? ?? '', '', direct: direct);
    } else {
      // A question with no options takes words of its own.
      session.answer('', words, direct: direct);
    }
  }

  // ---- its turn ----

  /// The question on screen now, or null. Called whenever the session's state
  /// changes; a question that has not been read out yet is read at once,
  /// because it is the one thing worth interrupting for.
  void onAsk(Map<String, dynamic>? ask) {
    if (left) return;
    if (ask == null) {
      if (asking != null) {
        asking = null;
        notifyListeners();
      }
      return;
    }
    if (askId(ask) == _askRead) return;
    _askRead = askId(ask);
    asking = ask;
    final options = ((ask['options'] ?? const []) as List).cast<Map>();
    final q = (ask['question'] as String? ?? 'It is asking something.').trim();
    _say(options.isEmpty ? q : '$q ${optionWords(options)}');
  }

  /// Everything the session has written since it was last read out, read out.
  ///
  /// [thenYours] is false for a line said in the middle of a long job - "I am
  /// going to look at the logs" - where the session is still working and there
  /// is nothing yet to reply to.
  void readNew(Iterable<Line> lines, {bool thenYours = true}) {
    if (left || turn == Turn.listening) return;
    if (turn == Turn.speaking) {
      // "Still working" is short, and cutting a voice off mid-word is not
      // reliable on every phone: what came is read the moment it ends instead.
      if (_filling) {
        _missed = (
          lines: lines.toList(),
          thenYours: thenYours || (_missed?.thenYours ?? false),
        );
      }
      return;
    }
    final fresh = <String>[];
    for (final l in lines) {
      if (l.id.isEmpty || _readOut.contains(l.id)) continue;
      _readOut.add(l.id);
      if (l.kind != 'text') continue; // tool steps and results stay on screen
      final text = l.text.trim();
      if (text.isNotEmpty) fresh.add(text);
    }
    if (fresh.isEmpty) {
      // The turn is over and there was nothing to say: back to listening.
      if (thenYours && turn == Turn.working) listen();
      return;
    }
    _say(fresh.join('. '), thenYours: thenYours);
  }

  /// The session is working and nothing has moved for a while: whatever it has
  /// written is finished, so it can be read out without waiting for the job.
  void stalled(Iterable<Line> lines) => readNew(lines, thenYours: false);

  /// How long the session may now work in silence before [stillQuiet]. It
  /// doubles each time the phone fills the silence, up to a minute, so a long
  /// build is not narrated every fifteen seconds.
  Duration get quietLimit =>
      stillWorkingAfter * (1 << (_stillSaid < 2 ? _stillSaid : 2));

  /// The session has worked for [quietLimit] without a word read out: the
  /// phone says itself that it is still going. Called by the screen's clock.
  void stillQuiet() {
    if (left || turn != Turn.working) return;
    final line = stillWorkingLines[_stillSaid % stillWorkingLines.length];
    _stillSaid++;
    _say(line, thenYours: false, filler: true);
  }

  void _say(String text, {bool thenYours = true, bool filler = false}) {
    final words = sayable(text);
    if (words.isEmpty) return listen();
    _thenYours = thenYours;
    _filling = filler;
    _saying = words;
    if (!filler) {
      // The screen keeps showing the last real answer, not "still working".
      reply = words;
      _stillSaid = 0;
    }
    _to(Turn.speaking);
    voice.speak(words);
  }

  /// It has finished reading: the next turn is taken without a word from you to
  /// claim it. [late] is the screen stepping in because the voice never said.
  void readingDone({bool late = false}) {
    if (left || turn != Turn.speaking) return;
    if (late) voice.stopSpeaking();
    _filling = false;
    final missed = _missed;
    _missed = null;
    if (_thenYours) {
      listen();
    } else {
      _to(Turn.working);
    }
    if (missed != null) readNew(missed.lines, thenYours: missed.thenYours);
  }

  /// How long the voice could still be talking, for the screen's watch.
  Duration get mostItCouldTake =>
      Duration(milliseconds: 3000 + _saying.length * 110);

  // ---- the one tap ----

  /// One tap, wherever it lands, does the obvious thing for what is happening.
  void tap() {
    switch (turn) {
      case Turn.speaking:
        // Heard enough: cut it off and take the turn.
        voice.stopSpeaking();
        listen();
      case Turn.listening:
        // Done talking, without waiting out the pause.
        voice.stopListening();
      case Turn.resting:
        _quiet = 0;
        listen();
      case Turn.sending:
      case Turn.working:
        break; // it is on its way; nothing to take back
    }
  }

  void stopWork() {
    session.stopWork();
    listen();
  }

  void leave() {
    left = true;
    voice.stopListening();
    voice.stopSpeaking();
  }

  @override
  void dispose() {
    leave();
    super.dispose();
  }

  // ---- words ----

  static String askId(Map ask) =>
      '${ask['at']}|${ask['question']}|${(ask['context'] as List?)?.join('|')}';

  /// A long answer is a report: the first part is said and the rest is left on
  /// the screen under it.
  static String sayable(String text) {
    final plain = Voice.plain(text);
    if (plain.length <= spokenMax) return plain;
    final cut = plain.substring(0, spokenMax);
    final end = cut.lastIndexOf('. ');
    return '${end > 80 ? cut.substring(0, end + 1) : cut} The rest is on screen.';
  }

  /// Which option was named, or null when it is not clear: a number, "the
  /// first one", yes or no when there are two ways to go, or enough of the
  /// option's own words.
  static Map? pickOption(List<Map> options, String said) {
    if (options.isEmpty) return null;
    final low = said.toLowerCase().trim();
    // "The third one" is the third, not the first: which one it is has to be
    // settled by the ordinal before the bare "one" in it is looked at.
    const ordinals = {
      1: ['first', 'pehla', 'pehli'],
      2: ['second', 'dusra', 'dusri'],
      3: ['third', 'teesra'],
      4: ['fourth', 'chautha'],
    };
    const digits = {1: ['1'], 2: ['2'], 3: ['3'], 4: ['4']};
    // Bare "one" or "do" counts only in a short answer: in a sentence it is
    // far more likely to be an ordinary word than a choice.
    const counts = {
      1: ['one', 'ek'],
      2: ['two', 'do'],
      3: ['three', 'teen'],
      4: ['four', 'char'],
    };
    final short = low.split(RegExp(r'\s+')).length <= 3;
    for (final words in [ordinals, digits, if (short) counts]) {
      for (final at in words.keys) {
        if (at > options.length) continue;
        if (words[at]!.any((w) => RegExp('\\b$w\\b').hasMatch(low))) {
          return options[at - 1];
        }
      }
    }
    if (options.length == 2) {
      const yes = ['yes', 'yeah', 'yep', 'ok', 'okay', 'sure', 'go ahead', 'haan', 'han', 'theek hai', 'karo'];
      const no = ['no', 'nope', "don't", 'dont', 'stop', 'nahi', 'rehne do'];
      bool named(List<String> words) => words.any(
        (w) => low == w || low.startsWith('$w ') || low.endsWith(' $w'),
      );
      if (named(yes)) return options[0];
      if (named(no)) return options[1];
    }
    // Its own words, when enough of them are there to be sure.
    for (final o in options) {
      final label = (o['label'] as String? ?? '').toLowerCase();
      if (label.length >= 4 && low.contains(label)) return o;
    }
    return null;
  }

  static String optionWords(List<Map> options) {
    const names = ['one', 'two', 'three', 'four', 'five'];
    final parts = <String>[];
    for (var i = 0; i < options.length && i < names.length; i++) {
      parts.add('${names[i]}, ${options[i]['label'] ?? ''}');
    }
    return 'Say ${parts.join('. ')}';
  }
}

// ---------------------------------------------------------------- the screen

Future<void> openTalk(
  BuildContext context, {
  required String dir,
  required String sessionId,
  required String server,
  required String title,
}) {
  return Navigator.of(context).push(
    MaterialPageRoute(
      fullscreenDialog: true,
      builder: (_) => TalkPage(
        dir: dir,
        sessionId: sessionId,
        server: server,
        title: title,
      ),
    ),
  );
}

class TalkPage extends StatefulWidget {
  const TalkPage({
    super.key,
    required this.dir,
    required this.sessionId,
    required this.server,
    required this.title,
  });
  final String dir;
  final String sessionId;
  final String server;
  final String title;

  @override
  State<TalkPage> createState() => _TalkPageState();
}

class _TalkPageState extends State<TalkPage> {
  String get _sid => bridge.current(widget.sessionId);

  late final TalkLoop _loop;
  Timer? _settle; // waits for a turn to be properly over
  Timer? _watch; // in case the voice never says it has finished
  Timer? _still; // a session working in silence for too long
  Turn? _was; // the turn when the silence clock was last set

  @override
  void initState() {
    super.initState();
    // This screen is opened by a tap, so the permission to speak is still
    // warm: take it now rather than when the first answer arrives.
    Voice.I.unlock();
    // The chat under this screen is already this session, but a session that
    // was cleared, or a screen opened from elsewhere, might not be.
    if (bridge.chatOf?['sessionId'] != _sid) {
      bridge.chatOpen(widget.dir, _sid, widget.server);
    }
    _loop = TalkLoop(
      voice: _PhoneVoice(),
      session: _BridgeSession(
        dir: widget.dir,
        sessionId: _sid,
        server: widget.server,
        title: widget.title,
      ),
      sessionKey: _sid,
      alreadyThere: _lines(),
      askOnScreen: (bridge.chatLive['ask'] as Map?)?.cast<String, dynamic>(),
    );
    _loop.addListener(_onLoop);
    bridge.addListener(_onBridge);
    Voice.I.listening.addListener(_onListening);
    Voice.I.speaking.addListener(_onSpeaking);
    Voice.I.problem.addListener(_onTrouble);
    // Nothing is listened for until the screen is up: the first sound a phone
    // browser makes needs a tap behind it, and that tap is the one that opened
    // this screen.
    WidgetsBinding.instance.addPostFrameCallback((_) => _loop.start());
  }

  @override
  void dispose() {
    _settle?.cancel();
    _watch?.cancel();
    _still?.cancel();
    bridge.removeListener(_onBridge);
    Voice.I.listening.removeListener(_onListening);
    Voice.I.speaking.removeListener(_onSpeaking);
    Voice.I.problem.removeListener(_onTrouble);
    _loop.removeListener(_onLoop);
    _loop.dispose();
    super.dispose();
  }

  Iterable<Line> _lines() => [
    for (final it in bridge.chatItems)
      (
        id: it['id'] as String? ?? '',
        kind: it['k'] as String? ?? '',
        text: it['text'] as String? ?? '',
      ),
  ];

  void _onLoop() {
    if (!mounted) return;
    setState(() {});
    // A voice that never reports back must not leave the loop hanging: this is
    // the longest it could still be talking.
    _watch?.cancel();
    if (_loop.speaking) {
      _watch = Timer(
        _loop.mostItCouldTake,
        () => _loop.readingDone(late: true),
      );
    }
    // The silence is counted from when the work, or the last thing read out
    // during it, began - not reset by every change on the screen.
    if (_loop.turn != _was) {
      _was = _loop.turn;
      _still?.cancel();
      if (_loop.turn == Turn.working) {
        _still = Timer(_loop.quietLimit, _loop.stillQuiet);
      }
    }
  }

  void _onListening() {
    if (!mounted || Voice.I.listening.value) return;
    _loop.heard(Voice.I.heard.value);
  }

  void _onSpeaking() {
    if (!mounted || Voice.I.speaking.value != null) return;
    _loop.readingDone();
  }

  void _onTrouble() {
    if (!mounted) return;
    _loop.trouble(Voice.I.problem.value);
  }

  void _onBridge() {
    if (!mounted) return;
    final live = bridge.chatLive;
    _loop.onAsk((live['ask'] as Map?)?.cast<String, dynamic>());
    final busy = (live['lamp'] as String? ?? '') == 'busy';
    _settle?.cancel();
    if (busy) {
      // Mid-answer the words are still arriving in pieces, so nothing is read
      // while they move. A line that has stood still for a few seconds is
      // finished though, and waiting for a long job to end before saying it
      // would leave you listening to silence for minutes.
      final at = bridge.chatVersion;
      _settle = Timer(const Duration(milliseconds: 1500), () {
        if (mounted && bridge.chatVersion == at) _loop.stalled(_lines());
      });
      return;
    }
    _settle = Timer(const Duration(milliseconds: 450), () {
      if (mounted) _loop.readNew(_lines());
    });
  }

  String get _label => switch (_loop.turn) {
    Turn.listening => 'Listening',
    Turn.sending => 'Sending',
    Turn.working => 'Working',
    Turn.speaking => 'Speaking',
    Turn.resting => 'Tap to talk',
  };

  String get _hint => switch (_loop.turn) {
    Turn.listening => 'Stop speaking and it goes by itself. Tap to send now.',
    Turn.sending => '',
    Turn.working => 'It will read the answer out.',
    Turn.speaking => 'Tap anywhere to cut in.',
    Turn.resting => _loop.problem.isEmpty ? 'Tap anywhere.' : '',
  };

  @override
  Widget build(BuildContext context) {
    final problem = _loop.problem;
    return Scaffold(
      backgroundColor: C.well,
      body: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: () {
          HapticFeedback.selectionClick();
          // While a tap is warm the browser will let the page speak; after
          // this it will do so for the rest of the visit.
          Voice.I.unlock();
          _loop.tap();
        },
        child: SafeArea(
          child: Column(
            children: [
              _bar(),
              Expanded(
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 24),
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      _orb(),
                      const SizedBox(height: 22),
                      Text(
                        _label,
                        style: const TextStyle(
                          fontSize: 19,
                          fontWeight: FontWeight.w600,
                          color: C.text,
                        ),
                      ),
                      const SizedBox(height: 6),
                      SizedBox(
                        height: 34,
                        child: Text(
                          problem.isNotEmpty ? problem : _hint,
                          textAlign: TextAlign.center,
                          style: TextStyle(
                            fontSize: 13.5,
                            height: 1.3,
                            color: problem.isNotEmpty ? C.danger : C.text3,
                          ),
                        ),
                      ),
                      // A phone with no voices installed reads nothing out and
                      // says nothing about it, which looks exactly like a
                      // hang. Name it instead.
                      ValueListenableBuilder<int>(
                        valueListenable: Voice.I.voices,
                        builder: (context, n, _) => n != 0
                            ? const SizedBox.shrink()
                            : const Padding(
                                padding: EdgeInsets.only(top: 6),
                                child: Text(
                                  'This browser has no voice to read with. '
                                  'Add a speech voice in the phone settings.',
                                  textAlign: TextAlign.center,
                                  style: TextStyle(
                                    fontSize: 12.5,
                                    height: 1.3,
                                    color: C.danger,
                                  ),
                                ),
                              ),
                      ),
                      const SizedBox(height: 18),
                      // What it heard you say, as you say it.
                      ValueListenableBuilder<String>(
                        valueListenable: Voice.I.heard,
                        builder: (context, heard, _) {
                          final show =
                              _loop.turn == Turn.listening &&
                                  heard.trim().isNotEmpty
                              ? heard
                              : _loop.said;
                          if (show.trim().isEmpty) {
                            return const SizedBox(height: 24);
                          }
                          return Text(
                            show,
                            textAlign: TextAlign.center,
                            maxLines: 3,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                              fontSize: 16.5,
                              height: 1.35,
                              color: C.text2,
                            ),
                          );
                        },
                      ),
                      if (_loop.reply.isNotEmpty) ...[
                        const SizedBox(height: 20),
                        Flexible(
                          child: SingleChildScrollView(
                            child: Text(
                              _loop.reply,
                              textAlign: TextAlign.center,
                              style: const TextStyle(
                                fontSize: 15,
                                height: 1.45,
                                color: C.text,
                              ),
                            ),
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
              ),
              _foot(),
            ],
          ),
        ),
      ),
    );
  }

  Widget _bar() {
    return Padding(
      padding: const EdgeInsets.fromLTRB(6, 6, 10, 0),
      child: Row(
        children: [
          IconButton(
            icon: const Icon(Icons.close, color: C.text2),
            tooltip: 'Leave voice mode',
            onPressed: () => Navigator.of(context).maybePop(),
          ),
          Expanded(
            child: Text(
              widget.title,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                fontSize: 14,
                color: C.text2,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
          ValueListenableBuilder<String>(
            valueListenable: Voice.I.lang,
            builder: (context, lang, _) => InkWell(
              borderRadius: BorderRadius.circular(14),
              onTap: _nextLang,
              child: Container(
                height: 28,
                padding: const EdgeInsets.symmetric(horizontal: 12),
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: C.raised,
                  borderRadius: BorderRadius.circular(14),
                ),
                child: Text(
                  switch (lang) {
                    'hi-IN' => 'हिं',
                    'pa-IN' => 'ਪੰ',
                    _ => 'EN',
                  },
                  style: const TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w700,
                    color: C.text,
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Future<void> _nextLang() async {
    final codes = Voice.langs.map((l) => l[0]).toList();
    final i = codes.indexOf(Voice.I.lang.value);
    await Voice.I.setLang(codes[(i + 1) % codes.length]);
    if (!mounted) return;
    // Pick the new language up now rather than on the next turn.
    if (_loop.turn == Turn.listening) {
      await Voice.I.stop();
      _loop.listen();
    } else {
      setState(() {});
    }
  }

  /// A ring that shows, without words, whose turn it is.
  Widget _orb() {
    final color = switch (_loop.turn) {
      Turn.listening => C.accent,
      Turn.sending => C.accent,
      Turn.working => C.busy,
      Turn.speaking => C.shell,
      Turn.resting => C.off,
    };
    final icon = switch (_loop.turn) {
      Turn.listening => Icons.mic,
      Turn.sending => Icons.arrow_upward_rounded,
      Turn.working => Icons.more_horiz,
      Turn.speaking => Icons.graphic_eq,
      Turn.resting => Icons.mic_none,
    };
    return _Breath(
      on: _loop.turn != Turn.resting,
      color: color,
      child: Container(
        width: 132,
        height: 132,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          color: color.withValues(alpha: 0.14),
          border: Border.all(color: color.withValues(alpha: 0.5), width: 2),
        ),
        child: Icon(icon, size: 48, color: color),
      ),
    );
  }

  Widget _foot() {
    final working =
        _loop.turn == Turn.working || _loop.turn == Turn.sending;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 14),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          // The one thing worth reaching for mid-work: stop what it is doing.
          if (working)
            OutlinedButton.icon(
              onPressed: () {
                HapticFeedback.mediumImpact();
                _loop.stopWork();
              },
              icon: const Icon(Icons.stop, size: 18),
              label: const Text('Stop it'),
            )
          else
            const Text(
              'The conversation is in the chat behind this.',
              style: TextStyle(fontSize: 12, color: C.text3),
            ),
        ],
      ),
    );
  }
}

/// The phone's own listening and voice, which Loop already uses for dictation.
class _PhoneVoice implements TalkVoice {
  @override
  void listen() => Voice.I.listen();
  @override
  void stopListening() => Voice.I.stop();
  @override
  void speak(String text) =>
      Voice.I.speak('talk-${DateTime.now().microsecondsSinceEpoch}', text);
  @override
  void stopSpeaking() => Voice.I.stopSpeaking();
}

/// The session, over the same bridge the chat screen uses, so a message spoken
/// here is a message in that conversation and nothing else.
class _BridgeSession implements TalkSession {
  _BridgeSession({
    required this.dir,
    required this.sessionId,
    required this.server,
    required this.title,
  });
  final String dir;
  final String sessionId;
  final String server;
  final String title;

  @override
  bool get reachable => bridge.link == Link.on;

  @override
  bool get busy =>
      bridge.busyNow(sessionId) || bridge.waitingFor(sessionId).isNotEmpty;

  @override
  Future<String?> send(String text) async {
    // On screen in the conversation now, not after the round trip.
    bridge.addPending(text);
    final r = await bridge.chatSend(text, const []);
    if (r.ok) return null;
    bridge.dropPending(text);
    return r.text ?? 'That did not go through.';
  }

  @override
  void queue(String text, {bool afterTurn = false}) => bridge.queue(
    dir: dir,
    sessionId: sessionId,
    server: server,
    title: title,
    text: text,
    afterTurn: afterTurn,
    why: afterTurn ? '' : 'Your PC could not be reached.',
  );

  @override
  void answer(String key, String words, {required bool direct}) {
    if (direct && key.isNotEmpty) {
      bridge.chatKey(key);
    } else {
      bridge.chatAnswer(key, words);
    }
  }

  @override
  void stopWork() => bridge.chatKey('\x1b');
}

/// A slow swell around the ring, so a glance from across the room says whether
/// it is still alive.
class _Breath extends StatefulWidget {
  const _Breath({required this.on, required this.color, required this.child});
  final bool on;
  final Color color;
  final Widget child;

  @override
  State<_Breath> createState() => _BreathState();
}

class _BreathState extends State<_Breath> with SingleTickerProviderStateMixin {
  late final _beat = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1600),
  );

  @override
  void initState() {
    super.initState();
    if (widget.on) _beat.repeat(reverse: true);
  }

  @override
  void didUpdateWidget(_Breath old) {
    super.didUpdateWidget(old);
    if (widget.on && !_beat.isAnimating) {
      _beat.repeat(reverse: true);
    } else if (!widget.on && _beat.isAnimating) {
      _beat.stop();
      _beat.value = 0;
    }
  }

  @override
  void dispose() {
    _beat.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _beat,
      builder: (context, child) => Container(
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          boxShadow: [
            BoxShadow(
              color: widget.color.withValues(alpha: 0.10 + 0.16 * _beat.value),
              blurRadius: 24 + 30 * _beat.value,
              spreadRadius: 2 + 10 * _beat.value,
            ),
          ],
        ),
        child: child,
      ),
      child: widget.child,
    );
  }
}
