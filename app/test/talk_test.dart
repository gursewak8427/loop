// Voice mode on the phone, played out turn by turn: you speak, it goes to the
// session, the answer is read out, and your turn comes back by itself. The
// phone's microphone and voice stand in as fakes, so what is tested here is
// the thing that was getting it wrong - whose turn it is, and what gets sent.
import 'package:flutter_test/flutter_test.dart';
import 'package:loop_app/talk.dart';

/// The phone's listening and voice, written down instead of done.
class FakeVoice implements TalkVoice {
  final events = <String>[];
  final spoken = <String>[];
  bool listening = false;

  @override
  void listen() {
    listening = true;
    events.add('listen');
  }

  @override
  void stopListening() {
    listening = false;
    events.add('stop listening');
  }

  @override
  void speak(String text) {
    spoken.add(text);
    events.add('speak');
  }

  @override
  void stopSpeaking() => events.add('stop speaking');
}

class FakeSession implements TalkSession {
  final sent = <String>[];
  final queued = <({String text, bool afterTurn})>[];
  final answers = <({String key, String words, bool direct})>[];
  int stops = 0;

  @override
  bool reachable = true;
  @override
  bool busy = false;

  /// Set to make the next send fail, as a lost connection would.
  String? refuse;

  @override
  Future<String?> send(String text) async {
    if (refuse != null) return refuse;
    sent.add(text);
    return null;
  }

  @override
  void queue(String text, {bool afterTurn = false}) =>
      queued.add((text: text, afterTurn: afterTurn));

  @override
  void answer(String key, String words, {required bool direct}) =>
      answers.add((key: key, words: words, direct: direct));

  @override
  void stopWork() => stops++;
}

var _n = 0;
TalkLoop make(
  FakeVoice voice,
  FakeSession session, {
  Iterable<Line> alreadyThere = const [],
  Map<String, dynamic>? askOnScreen,
}) => TalkLoop(
  voice: voice,
  session: session,
  // A fresh name each time: the rules are sent once per session, and a test
  // must not be changed by the one before it.
  sessionKey: 'session-${_n++}',
  alreadyThere: alreadyThere,
  askOnScreen: askOnScreen,
);

Line line(String id, String text, {String kind = 'text'}) =>
    (id: id, kind: kind, text: text);

void main() {
  test('what you say reaches the session, with the rules once and only once', () async {
    final v = FakeVoice();
    final s = FakeSession();
    final loop = make(v, s);

    loop.start();
    expect(loop.turn, Turn.listening);
    expect(v.listening, isTrue);

    loop.heard('run the tests and tell me what fails');
    await Future<void>.value();
    expect(s.sent.single, contains('run the tests and tell me what fails'));
    expect(s.sent.single, startsWith(talkRules), reason: 'told how to speak');
    expect(loop.turn, Turn.working);
    expect(loop.said, 'run the tests and tell me what fails');

    // Its answer, read out, and then your turn again.
    loop.readNew([line('a1', 'Two tests fail, both in the login screen.')]);
    expect(loop.turn, Turn.speaking);
    expect(v.spoken.single, 'Two tests fail, both in the login screen.');
    loop.readingDone();
    expect(loop.turn, Turn.listening, reason: 'no word needed to take a turn');

    loop.heard('fix the first one');
    await Future<void>.value();
    expect(s.sent.length, 2);
    expect(s.sent[1], 'fix the first one', reason: 'the rules are not repeated');
  });

  test('the conversation so far is read, not read out', () {
    final v = FakeVoice();
    final s = FakeSession();
    final loop = make(
      v,
      s,
      alreadyThere: [line('old1', 'said long before voice mode'), line('old2', 'and this')],
    );
    loop.start();
    loop.heard('what now');
    loop.readNew([
      line('old1', 'said long before voice mode'),
      line('old2', 'and this'),
      line('new1', 'Only this one is new.'),
    ]);
    expect(v.spoken.single, 'Only this one is new.');
  });

  test('tool steps and your own messages are not read out', () {
    final v = FakeVoice();
    final s = FakeSession();
    final loop = make(v, s);
    loop.start();
    loop.heard('go');
    loop.readNew([
      line('t1', 'Bash', kind: 'tool'),
      line('r1', '122 passed', kind: 'result'),
      line('u1', 'this was typed', kind: 'user'),
      line('a1', 'All of them pass.'),
    ]);
    expect(v.spoken.single, 'All of them pass.');
  });

  test('the same answer arriving twice is said once', () {
    final v = FakeVoice();
    final s = FakeSession();
    final loop = make(v, s);
    loop.start();
    loop.heard('go');
    loop.readNew([line('a1', 'Done.')]);
    loop.readingDone();
    loop.readNew([line('a1', 'Done.')]);
    expect(v.spoken.length, 1);
  });

  test('a tap cuts the answer off and gives you the turn at once', () {
    final v = FakeVoice();
    final s = FakeSession();
    final loop = make(v, s);
    loop.start();
    loop.heard('go');
    loop.readNew([line('a1', 'This is a long answer still being read out.')]);
    expect(loop.turn, Turn.speaking);

    loop.tap();
    expect(v.events, contains('stop speaking'));
    expect(loop.turn, Turn.listening);
  });

  test('a tap while it listens ends your turn instead of waiting for the pause', () {
    final v = FakeVoice();
    final s = FakeSession();
    final loop = make(v, s);
    loop.start();
    loop.tap();
    expect(v.events.last, 'stop listening');
    // The phone hands over what it had; that is what gets sent.
    loop.heard('open the admin panel');
    expect(loop.said, 'open the admin panel');
  });

  test('a voice that never says it has finished does not strand the loop', () {
    final v = FakeVoice();
    final s = FakeSession();
    final loop = make(v, s);
    loop.start();
    loop.heard('go');
    loop.readNew([line('a1', 'Reading this out.')]);
    expect(loop.turn, Turn.speaking);
    expect(loop.mostItCouldTake.inMilliseconds, greaterThan(3000));

    // The screen's watch runs out and steps in.
    loop.readingDone(late: true);
    expect(v.events, contains('stop speaking'));
    expect(loop.turn, Turn.listening);
  });

  test('silence twice over stops it listening for ever', () {
    final v = FakeVoice();
    final s = FakeSession();
    final loop = make(v, s);
    loop.start();
    loop.heard('');
    expect(loop.turn, Turn.listening, reason: 'one empty go is nothing');
    loop.heard('   ');
    expect(loop.turn, Turn.resting, reason: 'it waits for a tap rather than run on');
    expect(s.sent, isEmpty);

    // And a tap starts it again.
    loop.tap();
    expect(loop.turn, Turn.listening);
  });

  test('a line said in the middle of a long job is read out, and the job keeps the turn', () async {
    final v = FakeVoice();
    final s = FakeSession();
    final loop = make(v, s);
    loop.start();
    loop.heard('deploy the admin panel');
    await Future<void>.value();
    expect(loop.turn, Turn.working);

    // Still working: "I am going to…" is finished writing, so it is said now
    // rather than after minutes of silence.
    loop.stalled([line('a1', 'I am going to build it and push it up.')]);
    expect(v.spoken.single, 'I am going to build it and push it up.');
    loop.readingDone();
    expect(loop.turn, Turn.working, reason: 'nothing to answer yet');

    // When the job really ends, the rest is read and the turn comes back.
    loop.readNew([line('a2', 'It is live.')]);
    expect(v.spoken, ['I am going to build it and push it up.', 'It is live.']);
    loop.readingDone();
    expect(loop.turn, Turn.listening);
  });

  test(
    'a long silence while it works is filled, and the job keeps the turn',
    () async {
      final v = FakeVoice();
      final s = FakeSession();
      final loop = make(v, s);
      loop.start();
      loop.heard('run the whole test suite');
      await Future<void>.value();
      expect(loop.turn, Turn.working);
      expect(loop.quietLimit, stillWorkingAfter);

      // The screen's clock runs out with nothing read out.
      loop.stillQuiet();
      expect(v.spoken.single, 'Still working on it.');
      expect(
        loop.reply,
        isEmpty,
        reason: 'the screen does not show the filler as an answer',
      );
      loop.readingDone();
      expect(loop.turn, Turn.working, reason: 'nothing to answer yet');

      // Each time it is said the next wait is longer, up to a minute.
      expect(loop.quietLimit, stillWorkingAfter * 2);
      loop.stillQuiet();
      loop.readingDone();
      expect(loop.quietLimit, stillWorkingAfter * 4);
      loop.stillQuiet();
      loop.readingDone();
      expect(loop.quietLimit, stillWorkingAfter * 4);
      expect(v.spoken, [
        'Still working on it.',
        'Still on it.',
        'Still going.',
      ]);

      // Real words reset it.
      loop.stalled([line('a1', 'Half the tests have run.')]);
      loop.readingDone();
      expect(loop.quietLimit, stillWorkingAfter);
    },
  );

  test('the silence is only filled while the session works', () {
    final v = FakeVoice();
    final s = FakeSession();
    final loop = make(v, s);
    loop.start();
    loop.stillQuiet();
    expect(loop.turn, Turn.listening);
    loop.heard('');
    loop.heard('');
    expect(loop.turn, Turn.resting);
    loop.stillQuiet();
    expect(v.spoken, isEmpty);
  });

  test(
    'words that arrive while it says "still working" are read right after',
    () async {
      final v = FakeVoice();
      final s = FakeSession();
      final loop = make(v, s);
      loop.start();
      loop.heard('build it');
      await Future<void>.value();
      loop.stillQuiet();
      expect(loop.turn, Turn.speaking);

      // The job ends while the filler is being said.
      loop.readNew([line('a1', 'The build passed.')]);
      expect(v.spoken, [
        'Still working on it.',
      ], reason: 'not said over the filler');
      loop.readingDone();
      expect(v.spoken, ['Still working on it.', 'The build passed.']);
      expect(loop.reply, 'The build passed.');
      loop.readingDone();
      expect(
        loop.turn,
        Turn.listening,
        reason: 'the turn was over, so it is yours',
      );
    },
  );

  test(
    'a turn that ends with nothing to say during the filler still hands it back',
    () async {
      final v = FakeVoice();
      final s = FakeSession();
      final loop = make(v, s);
      loop.start();
      loop.heard('tidy up');
      await Future<void>.value();
      loop.stillQuiet();
      loop.readNew(const []);
      loop.readingDone();
      expect(loop.turn, Turn.listening);
    },
  );

  test('a session still working is not interrupted: the words wait for it', () async {
    final v = FakeVoice();
    final s = FakeSession()..busy = true;
    final loop = make(v, s);
    loop.start();
    loop.heard('also update the readme');
    await Future<void>.value();
    expect(s.sent, isEmpty);
    expect(s.queued.single.text, 'also update the readme');
    expect(s.queued.single.afterTurn, isTrue);
    expect(loop.turn, Turn.working);
  });

  test('with the PC away the words are kept, and you are told so out loud', () async {
    final v = FakeVoice();
    final s = FakeSession()..reachable = false;
    final loop = make(v, s);
    loop.start();
    loop.heard('push the branch');
    await Future<void>.value();
    expect(s.sent, isEmpty);
    expect(s.queued.single.text, 'push the branch');
    expect(s.queued.single.afterTurn, isFalse);
    expect(v.spoken.single, contains('not there'));
  });

  test('a send that fails says so instead of going quiet', () async {
    final v = FakeVoice();
    final s = FakeSession()..refuse = 'The PC did not answer.';
    final loop = make(v, s);
    loop.start();
    loop.heard('run it');
    await Future<void>.value();
    await Future<void>.value();
    expect(loop.problem, 'The PC did not answer.');
    expect(v.spoken.single, contains('did not go through'));
  });

  test('a question is read out with its options, and a number answers it', () {
    final v = FakeVoice();
    final s = FakeSession();
    final loop = make(v, s);
    loop.start();
    loop.onAsk({
      'at': 1,
      'question': 'Allow Bash to run the tests?',
      'direct': true,
      'options': [
        {'key': '1', 'label': 'Yes, allow it'},
        {'key': '2', 'label': 'No, stop'},
      ],
    });
    expect(v.spoken.single, contains('Allow Bash to run the tests?'));
    expect(v.spoken.single, contains('one, Yes, allow it'));
    loop.readingDone();
    expect(loop.turn, Turn.listening);

    loop.heard('two');
    expect(s.answers.single.key, '2');
    expect(s.answers.single.direct, isTrue);
    expect(s.sent, isEmpty, reason: 'an answer is not a new message');
  });

  test('words that do not name an option send nothing and ask again', () {
    final v = FakeVoice();
    final s = FakeSession();
    final loop = make(v, s);
    loop.start();
    loop.onAsk({
      'at': 1,
      'question': 'Which one?',
      'options': [
        {'key': '1', 'label': 'Rebase'},
        {'key': '2', 'label': 'Merge'},
      ],
    });
    loop.readingDone();
    loop.heard('hmm I am not sure about that');
    expect(s.answers, isEmpty, reason: 'nothing is guessed on a permission');
    expect(s.sent, isEmpty);
    expect(v.spoken.last, contains('did not catch which one'));

    // Said plainly, it goes.
    loop.readingDone();
    loop.heard('merge');
    expect(s.answers.single.key, '2');
  });

  test('a question already on screen when you arrive is not read out again', () {
    final v = FakeVoice();
    final s = FakeSession();
    final ask = {'at': 1, 'question': 'Allow Write?', 'options': const []};
    final loop = make(v, s, askOnScreen: ask);
    loop.start();
    loop.onAsk(ask);
    expect(v.spoken, isEmpty);
  });

  test('a question with no options takes words of your own', () {
    final v = FakeVoice();
    final s = FakeSession();
    final loop = make(v, s);
    loop.start();
    loop.onAsk({'at': 1, 'question': 'What should the button say?', 'options': const []});
    loop.readingDone();
    loop.heard('say start over');
    expect(s.answers.single.words, 'say start over');
  });

  test('yes and no answer a two-way question in either language', () {
    final options = [
      {'key': '1', 'label': 'Go ahead'},
      {'key': '2', 'label': 'Leave it'},
    ];
    for (final yes in ['yes', 'haan', 'ok', 'go ahead', 'karo']) {
      expect(TalkLoop.pickOption(options, yes)?['key'], '1', reason: yes);
    }
    for (final no in ['no', 'nahi', 'stop', 'rehne do']) {
      expect(TalkLoop.pickOption(options, no)?['key'], '2', reason: no);
    }
    // Three ways out is no longer a yes or no question.
    final three = [...options, {'key': '3', 'label': 'Ask me later'}];
    expect(TalkLoop.pickOption(three, 'yes'), isNull);
    expect(TalkLoop.pickOption(three, 'the third one')?['key'], '3');
  });

  test('a report is cut where it stops being something to listen to', () {
    final long = 'All the tests pass now. ${'The login screen was the problem and it is fixed. ' * 12}';
    final said = TalkLoop.sayable(long);
    expect(said.length, lessThan(spokenMax + 40));
    expect(said, endsWith('The rest is on screen.'));
    expect(said, startsWith('All the tests pass now.'));

    // Code, paths and links are for the screen, not the ear.
    final mixed = TalkLoop.sayable('Fixed it in `src/main/voice.js` - see https://example.com/x');
    expect(mixed, isNot(contains('http')));
    expect(mixed, isNot(contains('`')));
  });

  test('leaving stops the microphone and the voice, and nothing more is sent', () async {
    final v = FakeVoice();
    final s = FakeSession();
    final loop = make(v, s);
    loop.start();
    loop.leave();
    expect(v.events, containsAll(['stop listening', 'stop speaking']));
    loop.heard('this should go nowhere');
    await Future<void>.value();
    expect(s.sent, isEmpty);
    loop.readNew([line('a1', 'and nothing is read out')]);
    expect(v.spoken, isEmpty);
  });

  test('the microphone being refused is said on the screen, not swallowed', () {
    final v = FakeVoice();
    final s = FakeSession();
    final loop = make(v, s);
    loop.start();
    loop.trouble('Loop needs the microphone. Allow it, or type instead.');
    expect(loop.problem, contains('microphone'));
    expect(loop.turn, Turn.resting);
  });

  test('stopping the work hands the turn straight back to you', () {
    final v = FakeVoice();
    final s = FakeSession();
    final loop = make(v, s);
    loop.start();
    loop.heard('build the whole thing');
    loop.stopWork();
    expect(s.stops, 1);
    expect(loop.turn, Turn.listening);
  });
}
