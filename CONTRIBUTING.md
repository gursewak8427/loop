# Contributing to Loop

Thanks for helping. Small fixes are as welcome as features: a clearer sentence, a test for a case nobody covered, a bug you hit yourself.

## Find something to work on

- Issues labelled [good first issue](https://github.com/gursewak8427/loop/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) are scoped to be done in one sitting and say which files to start from.
- [help wanted](https://github.com/gursewak8427/loop/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22) issues are bigger.
- Found a bug? Open an issue with what you did, what you expected and what happened instead.

Before starting on something large, comment on the issue so no two people build the same thing.

## Set up

You need Windows 10 or 11 or macOS (Linux should work, but is untested), Node 24, and the Flutter SDK (stable channel). Claude Code installed and signed in lets you try Loop on real sessions.

```
git clone https://github.com/gursewak8427/loop
cd loop
npm ci
npm run web      # builds the phone app into src/web
npm start        # runs Loop from source
```

Loop keeps its settings in `%APPDATA%\Loop` (`~/Library/Application Support/Loop` on macOS). To try a change without touching your own setup, start it with a scratch folder: `set SD_USERDATA=%TEMP%\loop-dev` before `npm start`, or `SD_USERDATA=/tmp/loop-dev npm start` on macOS and Linux.

On macOS, `npm run pack:mac` builds an unsigned `Loop.app` into `release/`.

To work on Loop without real Claude Code sessions, `npm run demo` starts it on made-up projects and sessions in a temp folder, which is removed when Loop closes. Opening a session there replays its made-up conversation; no Claude Code runs. `npm run demo -- --shot desktop.png` saves a screenshot and quits, which is how `docs/screenshots/desktop.png` is made.

## How the code is laid out

| Where | What |
| --- | --- |
| `src/main/` | The desktop app's main process: sessions, terminals, memory, the phone server, voice |
| `src/renderer/` | The desktop interface, plain JavaScript and xterm.js, no build step |
| `app/` | The phone app, in Flutter. `lib/bridge.dart` is the only part that talks to the PC |
| `relay/` | An optional relay so a browser can reach a PC that is not on the internet |
| `test/` | Desktop tests (`node --test`) |
| `app/test/` | Phone tests |

## Check your change

```
npm test                         # desktop
cd app && flutter analyze        # no warnings expected
cd app && flutter test           # phone
```

CI runs all three on every pull request. If you changed what a phone screen looks like, regenerate the README pictures with `npm run screenshots`.

Write a test for what you changed when you can. The phone tests show the pattern: a fake PC is fed through `bridge.hear(...)`, and the screen is checked for what a person would see.

## Keep private data out

This repository is public, and anything committed stays findable even after it is deleted. In tests, docs and screenshots:

- Use made-up names, projects and numbers (`Acme`, `919800000001`), never real people, clients or contacts.
- Never commit a screenshot of your own sessions. Use `npm run screenshots`, which draws the app from made-up data.
- Never commit tokens, keys, IP addresses, machine names or paths from your own computer.

## Pull requests

- One change per pull request, with a title that says what it does.
- Say how you tested it, and include a screenshot or a short recording for anything visible.
- Keep the style of the code around you. Comments explain why, in plain words.

## Be kind

Assume good intent, keep feedback about the code, and help people who are new. Harassment or personal attacks are not welcome here.

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE).
