import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../../core/errors/eyeler_exception.dart';
import '../../../../core/theme/app_theme.dart';
import '../../../../shared/widgets/eyeler_widgets.dart';
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
          padding: const EdgeInsets.fromLTRB(EyelerSpacing.md, EyelerSpacing.sm,
              EyelerSpacing.md, EyelerSpacing.xl),
          children: [
            const Text('Your capital across different sources',
                style: EyelerTypography.body),
            const SizedBox(height: EyelerSpacing.xs),
            capital.when(
              loading: () => const Padding(
                  padding: EdgeInsets.all(EyelerSpacing.lg),
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
                        style: EyelerTypography.body.copyWith(
                            color:
                                Theme.of(context).textTheme.bodyMedium?.color)),
                    const SizedBox(height: EyelerSpacing.lg),
                    _CapitalSection(
                        title: 'Wallet / ${snapshot.walletAusd.asset}',
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
                        title: 'EYELER Books',
                        icon: Icons.shield_outlined,
                        values: {
                          'Reserved': snapshot.bookReserved,
                          'Deployed': snapshot.bookDeployed,
                          'Remaining': snapshot.bookRemaining,
                          'Unreserved': snapshot.unreservedCapital
                        }),
                    if (snapshot.reserveCoverage case final coverage?)
                      EyelerPanel(
                          tone: EyelerColors.reduce,
                          child: Text(
                              'Your Books promise ${coverage['promised']} ${snapshot.perplAvailable.asset} of defense, but Perpl has ${coverage['perplFree']} ${snapshot.perplAvailable.asset} free. Short by ${coverage['shortfall']} ${snapshot.perplAvailable.asset}.')),
                    if (snapshot.bookAllocations.isNotEmpty)
                      EyelerPanel(
                          child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                            const Text('Book allocations',
                                style: EyelerTypography.title),
                            ...snapshot.bookAllocations.map((row) => Text(
                                '${row['market'] ?? 'Book'} · Available ${row['available']} ${snapshot.bookRemaining.asset} · Reserved ${row['reserved']} · Deployed ${row['deployed']}')),
                          ])),
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
  Widget build(BuildContext context) => EyelerPanel(
      tone: EyelerColors.info,
      child: Padding(
        padding: EdgeInsets.zero,
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          const Row(children: [
            EyelerIconTile(
                icon: Icons.receipt_long_outlined, color: EyelerColors.info),
            SizedBox(width: EyelerSpacing.md),
            Expanded(
                child: Text('Agora account activity',
                    style: EyelerTypography.title)),
          ]),
          const SizedBox(height: EyelerSpacing.xs),
          const Text('Transaction history. Not a balance or funds available.'),
          const SizedBox(height: EyelerSpacing.md),
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
                              const EdgeInsets.only(bottom: EyelerSpacing.md),
                          child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                    '${row.type.toUpperCase()} · ${row.status}',
                                    style: EyelerTypography.label),
                                Text('${row.source} to ${row.destination}'),
                                Text(
                                    '${row.amount.isEmpty ? 'Amount unavailable' : '${row.amount} ${row.asset}'} · ${row.timestamp?.toLocal().toString().split('.').first ?? 'Time unavailable'}'),
                                Text(row.match == 'POSSIBLE_MATCH'
                                    ? 'Possible match with on-chain evidence'
                                    : 'No verified match in EYELER'),
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
    return EyelerPanel(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Row(children: [
        EyelerIconTile(
            icon: icon,
            color: title.startsWith('Wallet /')
                ? EyelerColors.info
                : EyelerColors.accent),
        const SizedBox(width: EyelerSpacing.md),
        Expanded(child: Text(title, style: EyelerTypography.title)),
      ]),
      const SizedBox(height: EyelerSpacing.lg),
      ...values.entries.map((entry) => Padding(
            padding: const EdgeInsets.only(bottom: EyelerSpacing.md),
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Expanded(
                  child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                    Text(entry.key,
                        style: EyelerTypography.body.copyWith(
                            color:
                                Theme.of(context).textTheme.bodyMedium?.color)),
                    const SizedBox(height: 3),
                    Text(_status(entry.value),
                        style: EyelerTypography.body.copyWith(
                            fontSize: 11,
                            color:
                                Theme.of(context).textTheme.bodyMedium?.color)),
                  ])),
              const SizedBox(width: EyelerSpacing.sm),
              Flexible(
                  child: Text(
                      entry.value.amount == null
                          ? 'Unavailable'
                          : '${entry.value.amount} ${entry.value.asset}',
                      textAlign: TextAlign.right,
                      style: EyelerTypography.metric.copyWith(fontSize: 17))),
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
    return '${value.source} · ${value.freshness}${value.ageMs == null ? '' : '  ${_age(value.ageMs!)}'}';
  }

  String _reason(String reason) => switch (reason) {
        'MONAD_WALLET_ADDRESS_NOT_CONFIGURED' =>
          'Wallet AUSD address unavailable',
        'MONAD_AUSD_READ_FAILED' => 'Monad AUSD read unavailable',
        'BOOK_LEDGER_NOT_AGGREGATED' => 'Book ledger unavailable',
        'BOOK_LEDGER_READ_FAILED' => 'Book ledger unavailable',
        'PERPL_BALANCE_READ_FAILED' => 'Perpl balance unavailable',
        'MONAD_COLLATERAL_READ_FAILED' => 'Wallet balance unavailable',
        _ => 'Source unavailable',
      };
}
