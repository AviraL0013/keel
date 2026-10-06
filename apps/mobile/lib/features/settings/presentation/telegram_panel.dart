import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../core/networking/api_client.dart';
import '../../../shared/widgets/eyeler_widgets.dart';
import '../../auth/data/auth_repository.dart';

final telegramStatusProvider =
    FutureProvider.autoDispose<Map<String, dynamic>>((ref) {
  ref.watch(authProvider.select((state) => state.address));
  return ref.watch(apiClientProvider).get('/connections/telegram',
      (value) => Map<String, dynamic>.from(value as Map));
});

class TelegramPanel extends ConsumerStatefulWidget {
  const TelegramPanel({super.key});
  @override
  ConsumerState<TelegramPanel> createState() => _TelegramPanelState();
}

class _TelegramPanelState extends ConsumerState<TelegramPanel> {
  bool busy = false;
  String? error;
  Uri? link;

  @override
  Widget build(BuildContext context) => EyelerPanel(
          child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(children: [
            const Expanded(child: Text('Telegram alerts')),
            IconButton(
                onPressed:
                    busy ? null : () => ref.invalidate(telegramStatusProvider),
                tooltip: 'Refresh Telegram connection',
                icon: const Icon(Icons.refresh))
          ]),
          const Text(
              'Receive your Book action and safety updates in a private chat.'),
          ref.watch(telegramStatusProvider).when(
                loading: () => const Padding(
                    padding: EdgeInsets.all(12),
                    child: LinearProgressIndicator()),
                error: (_, __) => const Text(
                    'Telegram unavailable. Could not read connection status.'),
                data: (value) {
                  final status = value['status'];
                  if (status == 'UNAVAILABLE') {
                    return const Text(
                        'Telegram unavailable. The bot is not configured.');
                  }
                  if (status == 'LINKED') {
                    return Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Text(
                              'Connected to your private Telegram chat.'),
                          TextButton(
                              onPressed: busy ? null : _unlink,
                              child: const Text('DISCONNECT TELEGRAM')),
                        ]);
                  }
                  return Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Text(
                            'Not connected. Open Telegram and press Start, then refresh here.'),
                        FilledButton.icon(
                            onPressed: busy ? null : _connect,
                            icon: const Icon(Icons.notifications_outlined),
                            label: const Text('CONNECT TELEGRAM')),
                        if (link != null)
                          TextButton(
                              onPressed: () => _open(link!),
                              child: const Text('OPEN TELEGRAM AGAIN')),
                      ]);
                },
              ),
          if (busy) const LinearProgressIndicator(),
          if (error != null)
            Text(error!,
                style: TextStyle(color: Theme.of(context).colorScheme.error)),
        ],
      ));

  Future<void> _open(Uri url) async {
    try {
      if (!await launchUrl(url, mode: LaunchMode.externalApplication) &&
          mounted) {
        setState(() => error =
            'Telegram could not open. Install Telegram, then try again.');
      }
    } catch (_) {
      if (mounted) {
        setState(() => error = 'Telegram could not open. Try again.');
      }
    }
  }

  Future<void> _connect() async {
    setState(() {
      busy = true;
      error = null;
      link = null;
    });
    try {
      final result = await ref.read(apiClientProvider).post(
          '/connections/telegram/link',
          decode: (value) => Map<String, dynamic>.from(value as Map));
      final url = Uri.parse(result['url'] as String);
      if (url.scheme != 'https' || url.host != 't.me') {
        throw const FormatException();
      }
      if (mounted) {
        setState(() => link = url);
        await _open(url);
      }
    } catch (_) {
      if (mounted) {
        setState(() => error =
            'Could not create Telegram link. Refresh status and try again.');
      }
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> _unlink() async {
    setState(() {
      busy = true;
      error = null;
    });
    try {
      await ref
          .read(apiClientProvider)
          .post('/connections/telegram/unlink', decode: (_) => true);
      link = null;
      ref.invalidate(telegramStatusProvider);
    } catch (_) {
      if (mounted) {
        setState(() => error = 'Could not disconnect Telegram. Try again.');
      }
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }
}
