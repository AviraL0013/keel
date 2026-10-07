import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../auth/data/auth_repository.dart';

class WalletRecoveryScreen extends ConsumerStatefulWidget {
  const WalletRecoveryScreen({super.key});
  @override
  ConsumerState<WalletRecoveryScreen> createState() =>
      _WalletRecoveryScreenState();
}

class _WalletRecoveryScreenState extends ConsumerState<WalletRecoveryScreen> {
  bool busy = false;
  String? message;
  Future<void> verify() async {
    final wallet = ref.read(walletConnectorProvider);
    final address = ref.read(authProvider).address;
    setState(() {
      busy = true;
      message = null;
    });
    try {
      final recovered = await wallet.connect();
      if (address == null ||
          recovered.address.toLowerCase() != address.toLowerCase()) {
        throw StateError('Choose the passkey for your signed-in wallet.');
      }
      if (mounted) {
        setState(() => message =
            'This passkey recovers your signed-in wallet. Check sync and recovery in your passkey provider before funding.');
      }
    } catch (_) {
      if (mounted) {
        setState(() => message =
            'Recovery was not verified. Try again and select the passkey for this wallet.');
      }
    } finally {
      wallet.dispose();
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Your passkey & recovery')),
        body: ListView(padding: const EdgeInsets.all(24), children: [
          const Text('Your passkey is your wallet key.',
              style: TextStyle(fontSize: 28, fontWeight: FontWeight.w700)),
          const SizedBox(height: 16),
          const Text(
              'Keep the EYELER passkey in a provider you can access on a replacement device. Check that provider’s sync, account recovery and device backup settings.'),
          const SizedBox(height: 16),
          const Text(
              'EYELER cannot reset this wallet or restore it if the passkey is lost. There is no seed export or alternative recovery in this release. Creating another passkey creates another wallet; funds do not move automatically.'),
          const SizedBox(height: 16),
          SelectableText(ref.watch(authProvider).address ??
              'Sign in to verify your wallet.'),
          const SizedBox(height: 24),
          FilledButton.icon(
              onPressed: busy ? null : verify,
              icon: const Icon(Icons.fingerprint),
              label: Text(busy ? 'CHECKING PASSKEY…' : 'VERIFY MY PASSKEY')),
          const SizedBox(height: 12),
          const Text(
              'This checks wallet recovery on this device. It cannot prove your provider has synced or backed up the passkey.'),
          if (message != null)
            Padding(
                padding: const EdgeInsets.only(top: 16), child: Text(message!)),
        ]),
      );
}
