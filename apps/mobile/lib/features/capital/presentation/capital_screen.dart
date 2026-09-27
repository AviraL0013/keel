import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../../core/errors/keel_exception.dart';
import '../../../../core/theme/app_theme.dart';
import '../../../../shared/widgets/keel_widgets.dart';
import '../data/capital_repository.dart';
import '../domain/capital_snapshot.dart';

class CapitalScreen extends ConsumerWidget {
  const CapitalScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final capital = ref.watch(capitalProvider);
    final agoraActivity = ref.watch(agoraActivityProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Capital'), actions: [
        IconButton(
            onPressed: () {
              ref.invalidate(capitalProvider);
              ref.invalidate(agoraActivityProvider);
            },
            icon: const Icon(Icons.refresh))
      ]),
      body: ListView(
          padding: const EdgeInsets.fromLTRB(
              KeelSpacing.md, KeelSpacing.sm, KeelSpacing.md, KeelSpacing.xl),
          children: [
            const Text('Your capital across different sources',
                style: KeelTypography.body),
            const SizedBox(height: KeelSpacing.xs),
            capital.when(
              loading: () => const Padding(
                  padding: EdgeInsets.all(KeelSpacing.lg),
                  child: Center(child: CircularProgressIndicator())),
              error: (error, _) => ErrorStateCard(
                  message: friendlyError(error),
                  onRetry: () => ref.invalidate(capitalProvider)),
              data: (snapshot) => Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                        snapshot.status == 'VALID'
                            ? 'Authoritative balances kept separate by source.'
                            : 'Some capital sources are unavailable.',
                        style: KeelTypography.body.copyWith(
                            color:
                                Theme.of(context).textTheme.bodyMedium?.color)),
                    const SizedBox(height: KeelSpacing.lg),
                    _CapitalSection(
                        title: 'Wallet / AUSD',
                        icon: Icons.account_balance_wallet_outlined,
                        values: {'AUSD balance': snapshot.walletAusd}),
                    _CapitalSection(
                        title: 'Perpl Collateral',
                        icon: Icons.swap_horiz,
                        values: {
                          'Available': snapshot.perplAvailable,
                          'Locked': snapshot.perplLocked
                        }),
                    _CapitalSection(
                        title: 'KEEL Books',
                        icon: Icons.shield_outlined,
                        values: {
                          'Reserved': snapshot.bookReserved,
                          'Deployed': snapshot.bookDeployed,
                          'Remaining': snapshot.bookRemaining,
                          'Unreserved': snapshot.unreservedCapital
                        }),
                  ]),
            ),
            _AgoraActivitySection(activity: agoraActivity),
          ]),
    );
  }
}

class _AgoraActivitySection extends StatelessWidget {
  const _AgoraActivitySection({required this.activity});
  final AsyncValue<AgoraActivity> activity;

  @override
  Widget build(BuildContext context) => KeelPanel(
      tone: KeelColors.info,
      child: Padding(
        padding: EdgeInsets.zero,
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          const Row(children: [
            KeelIconTile(
                icon: Icons.receipt_long_outlined, color: KeelColors.info),
            SizedBox(width: KeelSpacing.md),
            Expanded(
                child: Text('Agora account activity',
                    style: KeelTypography.title)),
          ]),
          const SizedBox(height: KeelSpacing.xs),
          const Text('Transaction history. Not a balance or funds available.'),
          const SizedBox(height: KeelSpacing.md),
          activity.when(
            loading: () => const Text('Checking Agora activity…'),
            error: (_, __) => const Text('Unavailable'),
            data: (value) {
              if (value.status != 'AVAILABLE') return const Text('Unavailable');
              if (value.rows.isEmpty) {
                return Text(value.limited == true
                    ? 'No activity for this wallet in recent Agora records.'
                    : 'No Agora activity for this wallet.');
              }
              return Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    ...value.rows.map((row) => Padding(
                          padding:
                              const EdgeInsets.only(bottom: KeelSpacing.md),
                          child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                    '${row.type.toUpperCase()} · ${row.status}',
                                    style: KeelTypography.label),
                                Text('${row.source} to ${row.destination}'),
                                Text(
                                    '${row.amount.isEmpty ? 'Amount unavailable' : '${row.amount} ${row.asset}'} · ${row.timestamp?.toLocal().toString().split('.').first ?? 'Time unavailable'}'),
                                Text(row.match == 'POSSIBLE_MATCH'
                                    ? 'Possible match with on-chain evidence'
                                    : 'No verified match in KEEL'),
                              ]),
                        )),
                    if (value.limited == true)
                      const Text('Showing recent Agora records only.'),
                  ]);
            },
          ),
        ]),
      ));
}

class _CapitalSection extends StatelessWidget {
  const _CapitalSection(
      {required this.title, required this.icon, required this.values});
  final String title;
  final IconData icon;
  final Map<String, CapitalAmount> values;

  @override
  Widget build(BuildContext context) {
    return KeelPanel(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Row(children: [
        KeelIconTile(
            icon: icon,
            color:
                title == 'Wallet / AUSD' ? KeelColors.info : KeelColors.accent),
        const SizedBox(width: KeelSpacing.md),
        Expanded(child: Text(title, style: KeelTypography.title)),
      ]),
      const SizedBox(height: KeelSpacing.lg),
      ...values.entries.map((entry) => Padding(
            padding: const EdgeInsets.only(bottom: KeelSpacing.md),
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Expanded(
                  child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                    Text(entry.key,
                        style: KeelTypography.body.copyWith(
                            color:
                                Theme.of(context).textTheme.bodyMedium?.color)),
                    const SizedBox(height: 3),
                    Text(_status(entry.value),
                        style: KeelTypography.body.copyWith(
                            fontSize: 11,
                            color:
                                Theme.of(context).textTheme.bodyMedium?.color)),
                  ])),
              const SizedBox(width: KeelSpacing.sm),
              Flexible(
                  child: Text(
                      entry.value.amount == null
                          ? 'Unavailable'
                          : '${entry.value.amount} ${entry.value.asset}',
                      textAlign: TextAlign.right,
                      style: KeelTypography.metric.copyWith(fontSize: 17))),
            ]),
          )),
    ]));
  }

  String _age(int ageMs) => ageMs < 1000
      ? '${ageMs}ms'
      : '${(ageMs / 1000).toStringAsFixed(ageMs < 10000 ? 1 : 0)}s';

  String _status(CapitalAmount value) {
    if (value.amount == null) {
      return value.reason == null ? 'UNAVAILABLE' : _reason(value.reason!);
    }
    return '${value.freshness}${value.ageMs == null ? '' : '  ${_age(value.ageMs!)}'}';
  }

  String _reason(String reason) => switch (reason) {
        'MONAD_WALLET_ADDRESS_NOT_CONFIGURED' =>
          'Wallet AUSD address unavailable',
        'MONAD_AUSD_READ_FAILED' => 'Monad AUSD read unavailable',
        'BOOK_LEDGER_NOT_AGGREGATED' => 'Book ledger unavailable',
        _ => 'Source unavailable',
      };
}
