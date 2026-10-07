import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/theme/app_theme.dart';
import '../../core/wallet/mera_transaction.dart';
import 'activation_coordinator.dart';
import 'perpl_activation.dart';

class ActivatePerplScreen extends StatefulWidget {
  const ActivatePerplScreen(
      {super.key,
      required this.coordinator,
      this.connectPanel,
      this.onReceive});
  final PerplActivationCoordinator coordinator;
  final Widget? connectPanel;
  final VoidCallback? onReceive;

  @override
  State<ActivatePerplScreen> createState() => _ActivatePerplScreenState();
}

class _ActivatePerplScreenState extends State<ActivatePerplScreen> {
  ActivationProgress? progress;
  String? error;
  bool busy = false;

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  Future<void> _refresh() async {
    if (busy) return;
    setState(() {
      busy = true;
      error = null;
    });
    try {
      final next = await widget.coordinator.refresh();
      if (mounted) setState(() => progress = next);
    } catch (caught) {
      if (mounted) setState(() => error = caught.toString());
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<bool> _confirm(MeraTransactionQuote quote) async =>
      await showDialog<bool>(
          context: context,
          builder: (context) => AlertDialog(
                title: const Text('Confirm Monad transaction'),
                content: SingleChildScrollView(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const Text('Monad mainnet · 143'),
                      const SizedBox(height: 10),
                      Text('Function: ${quote.function}'),
                      Text('Amount: ${quote.exactAmount}'),
                      Text('Maximum network fee: ${quote.maximumFeeMon} MON'),
                      const SizedBox(height: 10),
                      const Text('Contract'),
                      SelectableText(quote.contract),
                      const SizedBox(height: 10),
                      const Text('Only this transaction will be signed.'),
                    ],
                  ),
                ),
                actions: [
                  TextButton(
                      onPressed: () => Navigator.pop(context, false),
                      child: const Text('CANCEL')),
                  FilledButton(
                      onPressed: () => Navigator.pop(context, true),
                      child: const Text('SIGN AND SEND')),
                ],
              )) ??
      false;

  Future<void> _submit(ActivationStep step) async {
    if (busy) return;
    setState(() {
      busy = true;
      error = null;
    });
    try {
      final next = await widget.coordinator.submit(step, _confirm);
      if (mounted) setState(() => progress = next);
    } catch (caught) {
      if (mounted && caught.toString() != 'Transaction cancelled.') {
        setState(() => error = caught.toString());
      }
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final current = progress;
    return Scaffold(
      appBar: AppBar(title: const Text('Activate Perpl'), actions: [
        IconButton(
            onPressed: busy ? null : _refresh,
            tooltip: 'Refresh activation',
            icon: const Icon(Icons.refresh))
      ]),
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 520),
            child: ListView(
              padding: const EdgeInsets.all(EyelerSpacing.md),
              children: [
                const Text('Activate your Mera wallet',
                    style: EyelerTypography.title),
                const SizedBox(height: EyelerSpacing.sm),
                const Text(
                    'Approve AUSD, create your own Perpl account, then enable order forwarding. Each step needs your confirmation.'),
                const SizedBox(height: EyelerSpacing.md),
                const Text('Monad mainnet · Perpl mainnet'),
                if (busy) ...[
                  const SizedBox(height: EyelerSpacing.md),
                  const LinearProgressIndicator(),
                ],
                if (error != null) ...[
                  const SizedBox(height: EyelerSpacing.md),
                  Text(error!,
                      style: TextStyle(
                          color: Theme.of(context).colorScheme.error)),
                ],
                if (current != null) ...[
                  const SizedBox(height: EyelerSpacing.lg),
                  switch (current.step) {
                    ActivationStep.needsAusd => Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Text(
                              'Wallet needs at least Perpl’s current account-opening minimum in AUSD.'),
                          if (widget.onReceive != null)
                            OutlinedButton(
                                onPressed: widget.onReceive,
                                child: const Text('RECEIVE AUSD')),
                        ],
                      ),
                    ActivationStep.approve => _action(
                        'Approve only ${current.nextCall?.exactAmount ?? 'the required AUSD amount'} for Perpl.',
                        'APPROVE EXACTLY ${current.nextCall?.exactAmount ?? 'AUSD'}',
                        ActivationStep.approve),
                    ActivationStep.createAccount => _action(
                        'Create your Perpl account with a deposit of ${current.nextCall?.exactAmount}.',
                        'CREATE ACCOUNT · ${current.nextCall?.exactAmount}',
                        ActivationStep.createAccount),
                    ActivationStep.connectPerpl => Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Text(
                              'Connect this wallet to Perpl with the trade-only API key. Then refresh to read forwarding state.'),
                          if (widget.connectPanel != null) widget.connectPanel!,
                        ],
                      ),
                    ActivationStep.enableForwarding => _action(
                        'Enable Perpl order forwarding for this account.',
                        'ENABLE ORDER FORWARDING',
                        ActivationStep.enableForwarding),
                    ActivationStep.waitForReceipt => Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(current.error == 'TRANSACTION_OUTCOME_UNKNOWN'
                              ? 'Submission outcome unknown. Check wallet and explorer before any further action.'
                              : current.error == 'TRANSACTION_REVERTED'
                                  ? 'Transaction reverted. Review reason before retrying.'
                                  : 'Waiting for receipt and verified account state. Refresh after confirmation.'),
                          if (current.transactionHash != null)
                            TextButton(
                                onPressed: () => launchUrl(Uri.parse(
                                    'https://monadscan.com/tx/${current.transactionHash}')),
                                child: const Text('VIEW ON MONADSCAN')),
                        ],
                      ),
                    ActivationStep.ready => const Text(
                        'Perpl account active. API key connected and order forwarding enabled.'),
                  },
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _action(String description, String label, ActivationStep step) =>
      Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(description),
        const SizedBox(height: EyelerSpacing.md),
        FilledButton(
            onPressed: busy ? null : () => _submit(step), child: Text(label)),
      ]);
}
