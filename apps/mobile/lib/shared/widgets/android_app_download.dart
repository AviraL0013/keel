import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

const androidAppDownloadUrl =
    'https://github.com/AviraL0013/keel/releases/download/android-v1.0.0-45b214b/eyeler-android.apk';

Future<bool> _openAndroidDownload(Uri uri) => launchUrl(uri,
    mode: LaunchMode.externalApplication, webOnlyWindowName: '_blank');

/// Public APK download. No wallet, session or trading access is required.
class AndroidAppDownload extends StatelessWidget {
  const AndroidAppDownload(
      {super.key, this.compact = false, this.launcher = _openAndroidDownload});

  final bool compact;
  final Future<bool> Function(Uri) launcher;

  @override
  Widget build(BuildContext context) {
    if (compact) {
      return IconButton.outlined(
        tooltip: 'Download Android app',
        onPressed: () => _showInstructions(context),
        icon: const Icon(Icons.android, size: 20),
      );
    }
    return OutlinedButton.icon(
      onPressed: () => _showInstructions(context),
      icon: const Icon(Icons.android, size: 20),
      label: const Text('Download Android app'),
    );
  }

  Future<void> _showInstructions(BuildContext context) => showDialog<void>(
      context: context,
      builder: (_) => _AndroidInstallDialog(launcher: launcher));
}

class _AndroidInstallDialog extends StatefulWidget {
  const _AndroidInstallDialog({required this.launcher});
  final Future<bool> Function(Uri) launcher;

  @override
  State<_AndroidInstallDialog> createState() => _AndroidInstallDialogState();
}

class _AndroidInstallDialogState extends State<_AndroidInstallDialog> {
  bool _opening = false;
  bool _failed = false;

  Future<void> _download() async {
    if (_opening) return;
    setState(() {
      _opening = true;
      _failed = false;
    });
    var opened = false;
    try {
      opened = await widget.launcher(Uri.parse(androidAppDownloadUrl));
    } catch (_) {
      // Do not expose transport diagnostics in the public installation flow.
    }
    if (!mounted) return;
    if (opened) {
      Navigator.of(context).pop();
    } else {
      setState(() {
        _opening = false;
        _failed = true;
      });
    }
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
        title: const Text('Install Eyeler on Android'),
        content: SizedBox(
          width: 400,
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                    'Android phones only. Download the signed APK from our GitHub release. No wallet sign-in is required to download.'),
                const SizedBox(height: 16),
                const Text('1. Download the APK and open it on your phone.'),
                const SizedBox(height: 8),
                const Text(
                    '2. If Android asks, allow installation from your browser, then tap Install.'),
                const SizedBox(height: 8),
                const Text(
                    '3. Open Eyeler to create a Mera wallet or sign in with your existing passkey.'),
                const SizedBox(height: 16),
                const Text(
                    'Mainnet trading currently requires operator approval of your public wallet address.'),
                if (_failed) ...[
                  const SizedBox(height: 16),
                  Text('Could not open the Android download. Please retry.',
                      style: TextStyle(
                          color: Theme.of(context).colorScheme.error)),
                ],
              ],
            ),
          ),
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.of(context).pop(),
              child: const Text('Cancel')),
          FilledButton.icon(
              onPressed: _opening ? null : _download,
              icon: const Icon(Icons.download, size: 18),
              label: Text(_opening ? 'Opening...' : 'Download APK')),
        ],
      );
}
