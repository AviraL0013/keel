import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter/services.dart';
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
                        title: 'Agora AUSD wallet',
                        icon: Icons.currency_exchange,
                        values: {'AUSD balance': snapshot.walletAgoraAusd}),
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
                    if (snapshot.ausdMetrics case final metrics?)
                      EyelerPanel(
                          tone: EyelerColors.info,
                          child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                const Text('About AUSD',
                                    style: EyelerTypography.title),
                                const Text(
                                    'Public global supply. This is not your balance or Book collateral.'),
                                Text(metrics.status == 'AVAILABLE' &&
                                        metrics.supply != null
                                    ? '${metrics.supply} AUSD in total supply'
                                    : 'Unavailable · ${metrics.reason ?? 'Agora metrics could not be read'}'),
                              ])),
                  ]),
            ),
            _AgoraActivitySection(activity: agoraActivity),
          ]),
    );
  }
}

class _AgoraActivitySection extends ConsumerStatefulWidget {
  const _AgoraActivitySection({required this.activity});
  final AsyncValue<AgoraActivity> activity;

  @override
  ConsumerState<_AgoraActivitySection> createState() =>
      _AgoraActivitySectionState();
}

class _AgoraActivitySectionState extends ConsumerState<_AgoraActivitySection> {
  final List<AgoraActivityRow> _extraRows = [];
  String? _nextCursor;
  bool _loadedPage = false;
  bool _loading = false;
  String? _pageError;

  @override
  void didUpdateWidget(covariant _AgoraActivitySection oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.activity != widget.activity) {
      _extraRows.clear();
      _nextCursor = null;
      _loadedPage = false;
      _pageError = null;
    }
  }

  Future<void> _loadMore(String cursor) async {
    setState(() {
      _loading = true;
      _pageError = null;
    });
    try {
      final page = await ref
          .read(capitalRepositoryProvider)
          .getAgoraActivity(cursor: cursor);
      if (!mounted) return;
      if (page.status != 'AVAILABLE') {
        throw StateError(page.reason ?? 'AGORA_READ_FAILED');
      }
      setState(() {
        _extraRows.addAll(page.rows);
        _nextCursor = page.nextCursor;
        _loadedPage = true;
      });
    } catch (_) {
      if (mounted) {
        setState(
            () => _pageError = 'More Agora activity is unavailable. Retry.');
      }
    } finally {
      if (mounted) {
        setState(() => _loading = false);
      }
    }
  }

  String? _explorerUrl(String? hash) {
    const base = String.fromEnvironment('EYELER_MONAD_EXPLORER_URL');
    final uri = Uri.tryParse(base);
    if (hash == null ||
        !RegExp(r'^0x[0-9a-fA-F]{64}$').hasMatch(hash) ||
        uri == null ||
        uri.scheme != 'https' ||
        uri.host.isEmpty ||
        uri.userInfo.isNotEmpty) {
      return null;
    }
    return '${base.replaceFirst(RegExp(r'/$'), '')}/tx/$hash';
  }

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
          widget.activity.when(
            loading: () => const Text('Checking Agora activity…'),
            error: (_, __) => const Text('Unavailable'),
            data: (value) {
              if (value.status != 'AVAILABLE') {
                return Text(switch (value.reason) {
                  'AGORA_NOT_CONNECTED' =>
                    'Agora activity unavailable: connection not configured.',
                  'WALLET_NOT_REGISTERED' =>
                    'No Agora activity linked to this wallet.',
                  'WALLET_NOT_CONNECTED' =>
                    'Connect your wallet to see Agora activity.',
                  _ => 'Agora activity unavailable. Try again later.',
                });
              }
              final rows = [...value.rows, ..._extraRows];
              final nextCursor = _loadedPage ? _nextCursor : value.nextCursor;
              return Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                        'Source: Agora · ${value.checkedAt == null ? 'Freshness unknown' : 'Checked ${value.checkedAt!.toLocal().toString().split('.').first}'}'),
                    if (rows.isEmpty)
                      Text(nextCursor != null
                          ? 'No activity for this wallet on this page.'
                          : 'No Agora activity for this wallet.'),
                    ...rows.map((row) => Padding(
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
                                if (row.transactionHash != null &&
                                    RegExp(r'^0x[0-9a-fA-F]{64}$')
                                        .hasMatch(row.transactionHash!))
                                  Row(children: [
                                    Expanded(
                                        child: Text(
                                            'Transaction ${row.transactionHash!.substring(0, 10)}…${row.transactionHash!.substring(row.transactionHash!.length - 4)}')),
                                    IconButton(
                                        onPressed: () => Clipboard.setData(
                                            ClipboardData(
                                                text: row.transactionHash!)),
                                        icon: const Icon(Icons.copy),
                                        tooltip: 'Copy transaction hash'),
                                  ]),
                                if (_explorerUrl(row.transactionHash)
                                    case final url?)
                                  Row(children: [
                                    Expanded(
                                        child:
                                            SelectableText(url, maxLines: 1)),
                                    IconButton(
                                        onPressed: () => Clipboard.setData(
                                            ClipboardData(text: url)),
                                        icon: const Icon(Icons.copy),
                                        tooltip: 'Copy explorer link'),
                                  ]),
                                if (row.transactionHash == null &&
                                    row.id != null)
                                  Text('Agora reference ${row.id}'),
                              ]),
                        )),
                    if (_pageError != null) Text(_pageError!),
                    if (nextCursor != null)
                      OutlinedButton(
                          onPressed:
                              _loading ? null : () => _loadMore(nextCursor),
                          child: Text(
                              _loading ? 'Loading…' : 'Load more activity')),
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
