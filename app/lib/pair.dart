import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'bridge.dart';
import 'main.dart';
import 'shell.dart';
import 'theme.dart';

/// Pairing: the three things Loop shows under "Your phone" on the PC.
class PairPage extends StatefulWidget {
  const PairPage({super.key, this.first = false});
  final bool first;

  @override
  State<PairPage> createState() => _PairPageState();
}

class _PairPageState extends State<PairPage> {
  // Where this page came from decides how much is left to type.
  //
  // Loop itself serves the app over a plain connection on your own network, so
  // the PC is the address in the address bar: only the code is left. A page
  // served from the web (loop.prismaple.com) is not the PC, and a secure page
  // may only open secure connections, so it needs the PC's own name on your
  // tailnet — which a link or QR code can carry in the part after the #.
  static final _at = Uri.base;
  static final _web =
      kIsWeb && _at.host.isNotEmpty && _at.scheme.startsWith('http');
  static final _https = _web && _at.scheme == 'https';
  static final _frag = _web ? _at.fragment.trim() : '';

  /// A page from a relay carries the way in after the #. Which PC it belongs
  /// to is the relay's business, so only the pairing code is left to type.
  static final _relayKey =
      RegExp(r'(?:^|[&#])k=([A-Za-z0-9_-]{20,})').firstMatch(_frag)?.group(1) ??
      '';

  /// The PC's own address, carried alongside the key so the page can try the
  /// short way first.
  static final _relayDirect =
      RegExp(r'[&#]d=([A-Za-z0-9_.:-]+)').firstMatch(_frag)?.group(1) ?? '';
  static final _told = _relayKey.isEmpty ? _frag.split('/').first.trim() : '';

  /// Opened from Loop Cloud: the PC handed this browser a key of its own,
  /// after the #, so nothing is left to type.
  static final _visitor =
      RegExp(r'[/&]v=([a-f0-9]{64})').firstMatch(_frag)?.group(1) ?? '';

  /// A build made for hosting elsewhere says so; Loop's own copy does not.
  static const _hosted = bool.fromEnvironment('LOOP_HOSTED');
  static final _loopServed =
      (_web && !_hosted && _told.isEmpty) || _relayKey.isNotEmpty;
  static final _toldHost = _told.contains(':') ? _told.split(':').first : _told;
  static final _toldPort = _told.contains(':') ? _told.split(':').last : '';

  bool get _secure => _https;

  final _name = TextEditingController(
    text: _relayKey.isNotEmpty
        ? 'My PC'
        : _loopServed
        ? _at.host
        : _toldHost.isNotEmpty
        ? _toldHost.split('.').first
        : 'My PC',
  );
  final _host = TextEditingController(text: _loopServed ? _at.host : _toldHost);
  final _port = TextEditingController(
    text: _loopServed
        ? '${_at.hasPort ? _at.port : 8787}'
        : _toldPort.isNotEmpty
        ? _toldPort
        : (_https ? '8788' : '8787'),
  );
  final _code = TextEditingController(text: _visitor);
  bool _trying = false;
  String _problem = '';

  @override
  void initState() {
    super.initState();
    if (_visitor.isNotEmpty) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _pair());
    }
  }

  @override
  void dispose() {
    for (final c in [_name, _host, _port, _code]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _pair() async {
    final host = _host.text.trim();
    final code = _code.text.trim().toLowerCase();
    if (host.isEmpty || code.isEmpty) {
      setState(
        () =>
            _problem = 'Fill in the address and the pairing code from the PC.',
      );
      return;
    }
    setState(() {
      _trying = true;
      _problem = '';
    });
    final c = Conn(
      name: _name.text.trim().isEmpty ? host : _name.text.trim(),
      host: host,
      port: int.tryParse(_port.text.trim()) ?? (_secure ? 8788 : 8787),
      code: code,
      secure: _secure,
      key: _relayKey,
      direct: _relayDirect,
    );
    bridge.connect(c);
    // Wait for the PC to accept or refuse the code.
    for (var i = 0; i < 40 && mounted; i++) {
      await Future.delayed(const Duration(milliseconds: 250));
      if (bridge.link == Link.on) {
        await bridge.remember(c);
        if (mounted) {
          Navigator.of(context).pushReplacement(
            MaterialPageRoute(builder: (_) => const LoopShell()),
          );
        }
        return;
      }
      if (bridge.link == Link.denied) break;
    }
    if (!mounted) return;
    setState(() {
      _trying = false;
      // Say what actually went wrong, rather than guessing at the cause.
      _problem = bridge.lastError.isNotEmpty
          ? bridge.lastError
          : bridge.problem.isNotEmpty
          ? bridge.problem
          : bridge.link == Link.denied
          ? bridge.problem
          : 'No answer from $host. Check Tailscale is on, and that "Your phone" is turned on in Loop.';
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: widget.first ? null : AppBar(title: const Text('Add a PC')),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(20, 28, 20, 24),
          children: [
            Row(
              children: [
                Container(
                  width: 44,
                  height: 44,
                  decoration: BoxDecoration(
                    color: C.accent,
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: const Icon(Icons.all_inclusive, color: C.accentInk),
                ),
                const SizedBox(width: 14),
                const Text(
                  'Loop',
                  style: TextStyle(fontSize: 26, fontWeight: FontWeight.w700),
                ),
              ],
            ),
            const SizedBox(height: 10),
            const Text(
              'Your sessions on your PC and your servers, from here. On the PC open Loop, then Your phone, and turn it on: it shows an address, a port and a pairing code.',
              style: TextStyle(color: C.text2, height: 1.45),
            ),
            const SizedBox(height: 24),
            if (!_loopServed) ...[
              _field('Name for this PC', _name, hint: 'Desk'),
              _field(
                'Address',
                _host,
                hint: _https ? 'desktop-abc.tailxxxx.ts.net' : '100.64.0.1',
                keyboard: TextInputType.url,
              ),
              _field('Port', _port, keyboard: TextInputType.number),
            ],
            _field('Pairing code', _code, hint: 'abcd-efgh-jkmn', mono: true),
            if (_problem.isNotEmpty) ...[
              const SizedBox(height: 4),
              Text(
                _problem,
                style: const TextStyle(color: C.danger, height: 1.4),
              ),
            ],
            const SizedBox(height: 18),
            FilledButton(
              onPressed: _trying ? null : _pair,
              child: _trying
                  ? const SizedBox(
                      height: 18,
                      width: 18,
                      child: CircularProgressIndicator(
                        strokeWidth: 2,
                        color: C.accentInk,
                      ),
                    )
                  : const Text('Pair'),
            ),
            const SizedBox(height: 18),
            const Text(
              'The app reaches your PC over your own Tailscale network, nothing else. It is not the Remote Control switch inside Claude: that is a separate thing with its own switch on each session.',
              style: TextStyle(color: C.text3, fontSize: 12, height: 1.45),
            ),
          ],
        ),
      ),
    );
  }

  Widget _field(
    String label,
    TextEditingController c, {
    String? hint,
    TextInputType? keyboard,
    bool mono = false,
  }) => Padding(
    padding: const EdgeInsets.only(bottom: 14),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: const TextStyle(color: C.text2, fontSize: 12)),
        const SizedBox(height: 6),
        TextField(
          controller: c,
          keyboardType: keyboard,
          autocorrect: false,
          style: mono
              ? const TextStyle(
                  fontFamily: 'monospace',
                  fontSize: 17,
                  letterSpacing: 1,
                )
              : null,
          decoration: InputDecoration(hintText: hint),
        ),
      ],
    ),
  );
}

/// The list of PCs this phone knows, on the More tab.
class ConnectionsCard extends StatelessWidget {
  const ConnectionsCard({super.key});

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: bridge,
      builder: (context, _) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (final c in bridge.saved)
            ListTile(
              leading: Icon(
                Icons.computer,
                color: bridge.conn?.where == c.where && bridge.link == Link.on
                    ? C.idle
                    : C.text3,
              ),
              title: Text(c.name),
              subtitle: Text(
                bridge.conn?.where == c.where
                    ? _linkWord(bridge.link)
                    : c.where,
                style: const TextStyle(color: C.text3),
              ),
              trailing: PopupMenuButton<String>(
                color: C.panel,
                onSelected: (v) async {
                  if (v == 'use') bridge.connect(c);
                  if (v == 'copy') {
                    await Clipboard.setData(ClipboardData(text: c.where));
                  }
                  if (v == 'forget') await bridge.forget(c);
                },
                itemBuilder: (_) => const [
                  PopupMenuItem(
                    value: 'use',
                    child: Text('Connect to this one'),
                  ),
                  PopupMenuItem(value: 'copy', child: Text('Copy address')),
                  PopupMenuItem(value: 'forget', child: Text('Forget')),
                ],
              ),
              onTap: () => bridge.connect(c),
            ),
          const SizedBox(height: 6),
          OutlinedButton.icon(
            onPressed: () => Navigator.of(
              context,
            ).push(MaterialPageRoute(builder: (_) => const PairPage())),
            icon: const Icon(Icons.add),
            label: const Text('Add another PC'),
          ),
        ],
      ),
    );
  }

  static String _linkWord(Link l) => switch (l) {
    Link.on => 'Connected',
    Link.connecting => 'Connecting…',
    Link.denied => 'The pairing code was refused',
    Link.lost => 'Cannot reach it — trying again',
    Link.off => 'Not connected',
  };
}
