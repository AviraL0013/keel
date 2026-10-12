import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'mera_wallet_connector.dart';

const _secureDisplay = MethodChannel('xyz.eyeler.app/secure_display');

/// Reveals this wallet's private key only after another passkey verification.
/// No secret leaves the device except when the user explicitly copies it.
Future<void> showMeraPrivateKeyExport(
    BuildContext context, MeraWalletConnector wallet, String address,
    {MethodChannel secureDisplay = _secureDisplay}) async {
  final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
            title: const Text('Export to MetaMask?'),
            content: const Text(
                'Anyone with this private key can take this wallet’s funds. Verify your passkey, import the key into MetaMask, then return here and tap Done to clear the copied key. EYELER never sends the key to its server.'),
            actions: [
              TextButton(
                  onPressed: () => Navigator.pop(context, false),
                  child: const Text('CANCEL')),
              FilledButton(
                  onPressed: () => Navigator.pop(context, true),
                  child: const Text('VERIFY PASSKEY')),
            ],
          ));
  if (confirmed != true || !context.mounted) return;
  await secureDisplay.invokeMethod<void>('enable');
  try {
    final key = await wallet.exportPrivateKey(address);
    if (!context.mounted) return;
    try {
      await showDialog<void>(
          context: context,
          barrierDismissible: false,
          builder: (context) => AlertDialog(
                title: const Text('Your private key'),
                content: SingleChildScrollView(child: Column(mainAxisSize: MainAxisSize.min, children: [
                  const Text(
                    'Copy, switch to MetaMask and import as an account. Return here and tap Done; EYELER then clears the copied key. Check the full address matches.'),
                  const SizedBox(height: 12),
                  SelectableText(key, key: const Key('mera-private-key')),
                ])),
                actions: [
                  TextButton.icon(
                      onPressed: () =>
                          Clipboard.setData(ClipboardData(text: key)),
                      icon: const Icon(Icons.copy),
                      label: const Text('COPY KEY')),
                  FilledButton(
                      onPressed: () => Navigator.pop(context),
                      child: const Text('DONE')),
                ],
              ));
    } finally {
      final clipboard = await Clipboard.getData('text/plain');
      if (clipboard?.text == key) {
        await Clipboard.setData(const ClipboardData(text: ''));
      }
    }
  } catch (_) {
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('Export failed. Verify the passkey for this wallet.')));
    }
  } finally {
    await secureDisplay.invokeMethod<void>('disable');
  }
}
