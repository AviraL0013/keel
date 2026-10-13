import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'analytics_contract.dart';
import 'analytics_local_store.dart';
import 'analytics_models.dart';
import 'analytics_screen.dart' show openAnalyticsMarket, openAnalyticsWallet;
import 'dashboard_chart.dart';
import 'dashboard_data.dart';
import 'dashboard_style.dart';

String _walletPath(String address) {
  if (!isAnalyticsAddress(address)) {
    throw const FormatException('Invalid wallet address');
  }
  return '/wallets/${address.toLowerCase()}';
}

/// Optional fields extend the existing profile envelope without changing v1.
class DashboardWalletData extends V1WalletProfile {
  DashboardWalletData(
      V1WalletProfile profile, this.marginUsed, this.marginUsedReason)
      : super(profile.address, profile.accountIds, profile.margin,
            profile.positions);
  final String? marginUsed, marginUsedReason;
  factory DashboardWalletData.fromJson(Object? raw) {
    final json = AnalyticsParse.object(raw);
    final margin = AnalyticsParse.object(json['margin']);
    return DashboardWalletData(
        V1WalletProfile.fromJson(raw),
        AnalyticsParse.optionalDecimal(margin, 'used'),
        AnalyticsParse.optionalString(margin, 'usedUnavailableReason'));
  }
}

final dashboardWalletProvider =
    FutureProvider.family<V1Envelope<DashboardWalletData>, String>(
        (ref, address) {
  return ref.watch(dashboardApiProvider).request(
      _walletPath(address), DashboardWalletData.fromJson, validate: (value) {
    if (value.address.toLowerCase() != address.toLowerCase()) {
      throw const FormatException('Mismatched wallet');
    }
  });
});
final dashboardPerformanceProvider =
    FutureProvider.family<V1Envelope<V1WalletPerformance>, String>(
        (ref, address) {
  return ref.watch(dashboardApiProvider).request(
      '${_walletPath(address)}/performance', V1WalletPerformance.fromJson,
      ttl: const Duration(minutes: 1), validate: (value) {
    if (value.address.toLowerCase() != address.toLowerCase()) {
      throw const FormatException('Mismatched wallet performance');
    }
  });
});

String shortWallet(String address) =>
    '${address.substring(0, 8)}…${address.substring(address.length - 6)}';
String performanceReason(V1WalletPerformance? performance) =>
    switch (performance?.unavailableReason) {
      'ACCOUNT_ENUMERATION_UNVERIFIED' =>
        'Ownership of all accounts in this period is not yet verified.',
      'STARTING_EQUITY_UNAVAILABLE' =>
        'Verified starting equity is unavailable.',
      final String reason =>
        'Performance unavailable: ${reason.replaceAll('_', ' ').toLowerCase()}.',
      _ => 'The source has not supplied a verified performance value.',
    };
bool isThirtyDayPerformance(V1Envelope<V1WalletPerformance>? response) {
  final label = response?.coverage?.label.toLowerCase() ?? '';
  return label.contains('30 days') ||
      label.contains('30-day') ||
      label.contains('30d');
}

class DashboardWalletProfile extends ConsumerStatefulWidget {
  const DashboardWalletProfile({super.key, required this.address});
  final String address;
  @override
  ConsumerState<DashboardWalletProfile> createState() =>
      _DashboardWalletProfileState();
}

class _DashboardWalletProfileState
    extends ConsumerState<DashboardWalletProfile> {
  int tab = 0;
  bool saved = false;
  String? storageError;
  @override
  void initState() {
    super.initState();
    _readSaved();
  }

  Future<void> _readSaved() async {
    try {
      final list = await ref.read(analyticsLocalStoreProvider).watchlist();
      if (mounted) {
        setState(() => saved =
            list.any((a) => a.toLowerCase() == widget.address.toLowerCase()));
      }
    } catch (_) {
      if (mounted) {
        setState(() => storageError = 'Watchlist unavailable on this device.');
      }
    }
  }

  Future<void> _watch() async {
    try {
      final store = ref.read(analyticsLocalStoreProvider);
      final list = await store.watchlist();
      final exists =
          list.any((a) => a.toLowerCase() == widget.address.toLowerCase());
      if (!exists && list.length >= 4) {
        if (mounted) {
          setState(() => storageError =
              'Watchlist holds up to four wallets. Remove one to add this wallet.');
        }
        return;
      }
      await store.setWatchlist(exists
          ? list
              .where((a) => a.toLowerCase() != widget.address.toLowerCase())
              .toList()
          : [...list, widget.address]);
      if (mounted) {
        setState(() {
          saved = !exists;
          storageError = null;
        });
      }
    } catch (_) {
      if (mounted) {
        setState(
            () => storageError = 'Could not save this wallet. Please retry.');
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final profile = ref.watch(dashboardWalletProvider(widget.address));
    final performance = ref.watch(dashboardPerformanceProvider(widget.address));
    final wallet = profile.asData?.value;
    final history = performance.asData?.value;
    final data = wallet?.data;
    final perf = history?.data;
    final proven = perf != null && perf.unavailableReason == null;
    final perfReason = performance.hasError
        ? 'Performance endpoint unavailable. Current positions remain visible.'
        : performanceReason(perf);
    final briefPerfReason = performance.hasError
        ? 'Performance data could not be loaded.'
        : 'Verified trade history is unavailable.';
    final fullPositions = data?.margin.equity != null;
    final unrealized = !fullPositions
        ? null
        : data!.positions.isEmpty
            ? '0.000000'
            : AnalyticsDecimal.sum(data.positions.map((p) => p.unrealizedPnl));
    final period = history?.coverage?.label ?? 'Coverage not reported';
    return AnalyticsDark(
        child: Scaffold(
      appBar: AppBar(title: Text(shortWallet(widget.address)), actions: [
        IconButton(
            tooltip: 'Refresh wallet',
            onPressed: () {
              ref.invalidate(dashboardWalletProvider(widget.address));
              ref.invalidate(dashboardPerformanceProvider(widget.address));
            },
            icon: const Icon(Icons.refresh)),
      ]),
      body: ListView(padding: const EdgeInsets.all(24), children: [
        Center(
            child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 1440),
          child:
              Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            const Text('Wallet profile',
                style: TextStyle(fontSize: 28, fontWeight: FontWeight.w600)),
            const SizedBox(height: 10),
            SelectableText(widget.address,
                style: const TextStyle(
                    fontSize: 12, color: AnalyticsPalette.muted)),
            const SizedBox(height: 14),
            Wrap(spacing: 10, runSpacing: 8, children: [
              Tooltip(
                  message: saved ? 'Remove from watchlist' : 'Save wallet',
                  child: OutlinedButton.icon(
                      onPressed: _watch,
                      icon: Icon(
                          saved ? Icons.bookmark : Icons.bookmark_outline,
                          size: 17),
                      label: Text(saved ? 'Watching' : 'Watch'))),
              OutlinedButton.icon(
                  onPressed: () => Navigator.of(context).push(
                      MaterialPageRoute<void>(
                          builder: (_) => DashboardCompareScreen(
                              initialAddress: widget.address))),
                  icon: const Icon(Icons.compare_arrows, size: 17),
                  label: const Text('Compare')),
              IconButton(
                  tooltip: 'Copy address',
                  onPressed: () async {
                    await Clipboard.setData(
                        ClipboardData(text: widget.address));
                    if (context.mounted) {
                      ScaffoldMessenger.of(context).showSnackBar(
                          const SnackBar(content: Text('Address copied')));
                    }
                  },
                  icon: const Icon(Icons.copy_outlined, size: 17)),
            ]),
            if (storageError != null)
              Text(storageError!,
                  style: const TextStyle(color: AnalyticsPalette.muted)),
            const SizedBox(height: 24),
            if (profile.hasError)
              DashboardCard(
                  child: DashboardUnavailable(
                      'Wallet snapshot unavailable. Retry this wallet.',
                      retry: () => ref.invalidate(
                          dashboardWalletProvider(widget.address)))),
            DashboardGrid(columns: 4, children: [
              DashboardKpi(
                  label: 'Equity',
                  value: data?.margin.equity,
                  coverage: 'Current Exchange snapshot',
                  loading: profile.isLoading,
                  reason: 'Complete positions and marks are required.'),
              DashboardKpi(
                  label: 'Margin used',
                  value: data?.marginUsed,
                  coverage: 'Current snapshot',
                  reason: 'Total margin used is not verified.'),
              DashboardKpi(
                  label: 'Unrealized PnL',
                  value: unrealized,
                  coverage: 'Current open positions',
                  loading: profile.isLoading,
                  color: unrealized == null
                      ? null
                      : unrealized.startsWith('-')
                          ? AnalyticsPalette.down
                          : AnalyticsPalette.up,
                  reason: 'Verified position marks are required.'),
              DashboardKpi(
                  label: 'Realized PnL (30d)',
                  value: proven && isThirtyDayPerformance(history)
                      ? perf.realizedPnl
                      : null,
                  loading: performance.isLoading,
                  coverage: 'Last 30 days',
                  reason: proven && !isThirtyDayPerformance(history)
                      ? '30-day performance is not verified.'
                      : briefPerfReason),
            ]),
            const SizedBox(height: 16),
            DashboardGrid(columns: 4, children: [
              DashboardKpi(
                  label: 'Win rate',
                  value: proven ? perf.winRatePct : null,
                  percent: true,
                  money: false,
                  loading: performance.isLoading,
                  coverage: period,
                  reason: briefPerfReason),
              DashboardKpi(
                  label: 'Available margin',
                  value: data?.margin.free,
                  coverage: 'Current snapshot',
                  loading: profile.isLoading),
              DashboardKpi(
                  label: 'Locked order collateral',
                  value: data?.margin.locked,
                  coverage: 'Current snapshot',
                  loading: profile.isLoading),
              DashboardKpi(
                  label: 'Account balance',
                  value: data?.margin.balance,
                  coverage: 'Excludes open positions',
                  loading: profile.isLoading),
            ]),
            const SizedBox(height: 18),
            Text(
                wallet == null
                    ? 'Snapshot source unavailable'
                    : '${analyticsSource(wallet.source)} · ${utcExact(wallet.asOf)} · ${wallet.coverage?.label ?? 'Current snapshot'}${wallet.stale ? ' · $dashboardDataNotice' : ''}',
                style: const TextStyle(
                    fontSize: 11, height: 1.6, color: AnalyticsPalette.muted)),
            const SizedBox(height: 24),
            DashboardChartCard(
                title: 'Equity / realized PnL',
                description:
                    'Realized equity curve when a verified starting balance is available.',
                series: [
                  DashboardSeries(
                      'Realized equity',
                      proven
                          ? perf.equityCurve.map((p) => p.toView()).toList()
                          : [])
                ],
                initialType: DashboardChartType.area,
                loading: performance.isLoading,
                unavailableReason: proven
                    ? 'No equity history supplied. A verified starting balance is required.'
                    : perfReason,
                source:
                    history == null ? null : analyticsSource(history.source),
                asOf: history?.asOf,
                stale: history?.stale ?? false,
                coverage: period,
                retry: performance.hasError
                    ? () => ref.invalidate(
                        dashboardPerformanceProvider(widget.address))
                    : null),
            const SizedBox(height: 24),
            Wrap(spacing: 8, children: [
              for (final (index, label) in [
                (0, 'Positions'),
                (1, 'Trades'),
                (2, 'Performance')
              ])
                TextButton(
                    key: ValueKey('wallet_tab_$index'),
                    onPressed: () => setState(() => tab = index),
                    style: TextButton.styleFrom(
                        backgroundColor:
                            tab == index ? AnalyticsPalette.elevated : null),
                    child: Text(label))
            ]),
            const SizedBox(height: 16),
            if (tab == 0)
              DashboardCard(
                  child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                    const Text('Open positions',
                        style: TextStyle(
                            fontSize: 18, fontWeight: FontWeight.w600)),
                    const SizedBox(height: 16),
                    if (profile.isLoading)
                      const DashboardSkeleton()
                    else if (data == null)
                      const DashboardUnavailable('Positions unavailable.')
                    else if (data.positions.isEmpty)
                      const DashboardUnavailable('No observed open positions.')
                    else
                      DashboardGrid(children: [
                        for (final position in data.positions)
                          _Position(position)
                      ]),
                  ])),
            if (tab == 1) DashboardWalletTrades(address: widget.address),
            if (tab == 2)
              DashboardCard(
                  child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                    Text('Performance · $period',
                        style: const TextStyle(
                            fontSize: 18, fontWeight: FontWeight.w600)),
                    if (!proven)
                      DashboardUnavailable(perfReason,
                          retry: performance.hasError
                              ? () => ref.invalidate(
                                  dashboardPerformanceProvider(widget.address))
                              : null)
                    else ...[
                      const SizedBox(height: 20),
                      DashboardGrid(columns: 4, children: [
                        DashboardKpi(
                            label: 'Realized PnL',
                            value: perf.realizedPnl,
                            coverage: period,
                            reason: perfReason),
                        DashboardKpi(
                            label: 'Profit factor',
                            value: perf.profitFactor,
                            money: false,
                            coverage: period,
                            reason:
                                'Profit factor requires verified losing episodes.'),
                        DashboardKpi(
                            label: 'Maximum drawdown',
                            value: perf.maxDrawdownPct,
                            money: false,
                            percent: true,
                            coverage: period,
                            reason: 'Verified starting equity is required.'),
                        DashboardKpi(
                            label: 'Closed episodes',
                            value: perf.closedTrades.toString(),
                            money: false,
                            coverage: period),
                      ])
                    ],
                  ])),
          ]),
        ))
      ]),
    ));
  }
}

class _Position extends StatelessWidget {
  const _Position(this.position);
  final V1Position position;
  @override
  Widget build(BuildContext context) => Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
          border: Border.all(color: AnalyticsPalette.border),
          borderRadius: BorderRadius.circular(8)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          TextButton(
              onPressed: () => openAnalyticsMarket(context, position.symbol),
              child: Text(position.symbol)),
          const Spacer(),
          Text('${position.side} · ${position.leverage}×')
        ]),
        for (final item in [
          ('Size', position.size),
          ('Entry', position.entryPrice),
          ('Mark', position.markPrice),
          ('Collateral', position.collateral),
          ('Unrealized PnL', position.unrealizedPnl),
          ('Liquidation price', position.liquidationPrice)
        ])
          Padding(
              padding: const EdgeInsets.symmetric(vertical: 7),
              child: Row(children: [
                Expanded(
                    child: Text(item.$1,
                        style: const TextStyle(
                            fontSize: 12, color: AnalyticsPalette.muted))),
                Flexible(
                    child: Tooltip(
                        message: item.$2 ??
                            'The source has not verified ${item.$1.toLowerCase()}.',
                        child: Text(item.$2 ?? '—',
                            style: const TextStyle(fontSize: 12)))),
              ])),
      ]));
}

class DashboardWalletTrades extends ConsumerStatefulWidget {
  const DashboardWalletTrades({super.key, required this.address});
  final String address;
  @override
  ConsumerState<DashboardWalletTrades> createState() =>
      _DashboardWalletTradesState();
}

class _DashboardWalletTradesState extends ConsumerState<DashboardWalletTrades> {
  final items = <V1Trade>[];
  String? cursor, error;
  bool loading = true;
  V1Envelope<V1TradePage>? response;
  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      loading = true;
      error = null;
    });
    try {
      final result = await ref.read(dashboardApiProvider).request(
          '${_walletPath(widget.address)}/trades?limit=50${cursor == null ? '' : '&cursor=${Uri.encodeQueryComponent(cursor!)}'}',
          V1TradePage.fromJson);
      if (!mounted) return;
      setState(() {
        final seen = items.map((e) => e.id).toSet();
        items.addAll(result.data.items.where((e) => seen.add(e.id)));
        cursor = result.data.nextCursor;
        response = result;
        loading = false;
      });
    } catch (_) {
      if (mounted) {
        setState(() {
          loading = false;
          error = 'Trade history unavailable from the source.';
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final markets =
        ref.watch(dashboardMarketsProvider).asData?.value.data ?? [];
    final names = {for (final market in markets) market.id: market.symbol};
    return DashboardCard(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      const Text('Trade history',
          style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
      const SizedBox(height: 8),
      if (response != null)
        Text(
            '${analyticsSource(response!.source)} · ${response!.coverage?.label ?? 'Coverage not reported'}${response!.stale ? ' · $dashboardDataNotice' : ''}',
            style:
                const TextStyle(color: AnalyticsPalette.muted, fontSize: 11)),
      if (loading && items.isEmpty) const DashboardSkeleton(),
      if (!loading && error == null && items.isEmpty)
        const DashboardUnavailable('No observed trades.'),
      for (final trade in items)
        Padding(
            padding: const EdgeInsets.symmetric(vertical: 14),
            child:
                Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Wrap(
                  spacing: 16,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    TextButton(
                        onPressed: names[trade.marketId] == null
                            ? null
                            : () => openAnalyticsMarket(
                                context, names[trade.marketId]!),
                        child: Text(names[trade.marketId] ??
                            'Market ${trade.marketId}')),
                    Text('${trade.side} · ${trade.action}'),
                    Tooltip(
                        message: trade.realizedPnl ??
                            'No proven realized settlement for this fill.',
                        child: Text(trade.realizedPnl == null
                            ? 'PnL —'
                            : 'PnL ${AnalyticsNumbers.compact(trade.realizedPnl, places: 2)}')),
                  ]),
              Text('${trade.size} @ ${trade.price} · ${utcExact(trade.time)}',
                  style: const TextStyle(
                      fontSize: 12, color: AnalyticsPalette.muted)),
              const SizedBox(height: 12),
              const Divider(),
            ])),
      if (error != null) DashboardUnavailable(error!, retry: _load),
      if (cursor != null && error == null)
        TextButton(
            onPressed: loading ? null : _load,
            child: Text(loading ? 'Loading…' : 'Load more trades')),
    ]));
  }
}

class DashboardCompareScreen extends ConsumerStatefulWidget {
  const DashboardCompareScreen(
      {super.key, this.initialAddress, this.embedded = false});
  final String? initialAddress;
  final bool embedded;
  @override
  ConsumerState<DashboardCompareScreen> createState() =>
      _DashboardCompareScreenState();
}

class _DashboardCompareScreenState
    extends ConsumerState<DashboardCompareScreen> {
  List<String>? addresses;
  String? error;
  final controller = TextEditingController();
  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final saved = await ref.read(analyticsLocalStoreProvider).watchlist();
      final combined = <String>{
        if (widget.initialAddress != null) widget.initialAddress!.toLowerCase(),
        ...saved.map((a) => a.toLowerCase())
      }.take(4).toList();
      if (mounted) setState(() => addresses = combined);
    } catch (_) {
      if (mounted) {
        setState(() {
          addresses = [];
          error = 'Saved watchlist unavailable.';
        });
      }
    }
  }

  Future<void> _remove(String address) async {
    try {
      final store = ref.read(analyticsLocalStoreProvider);
      final saved = await store.watchlist();
      await store.setWatchlist(saved
          .where((a) => a.toLowerCase() != address.toLowerCase())
          .toList());
      if (mounted) {
        setState(
            () => addresses = addresses!.where((a) => a != address).toList());
      }
    } catch (_) {
      if (mounted) setState(() => error = 'Could not update watchlist.');
    }
  }

  @override
  Widget build(BuildContext context) {
    final body = ListView(padding: const EdgeInsets.all(24), children: [
      Center(
          child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 1440),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          const Text('Watchlist & compare',
              style: TextStyle(fontSize: 26, fontWeight: FontWeight.w600)),
          const SizedBox(height: 8),
          Text(
              '${addresses?.length ?? 0}/4 wallets · snapshots load independently',
              style:
                  const TextStyle(color: AnalyticsPalette.muted, fontSize: 12)),
          const SizedBox(height: 18),
          TextField(
              controller: controller,
              autocorrect: false,
              enableSuggestions: false,
              decoration: InputDecoration(
                  hintText: 'Add address to comparison…',
                  suffixIcon: IconButton(
                      tooltip: 'Add wallet to comparison',
                      icon: const Icon(Icons.add),
                      onPressed: () {
                        final value = controller.text.trim().toLowerCase();
                        if (!isAnalyticsAddress(value)) {
                          setState(
                              () => error = 'Enter a valid wallet address.');
                          return;
                        }
                        if ((addresses?.length ?? 0) >= 4) {
                          setState(() => error = 'Compare up to four wallets.');
                          return;
                        }
                        setState(() {
                          addresses = {...?addresses, value}.toList();
                          error = null;
                          controller.clear();
                        });
                      }))),
          if (error != null)
            Padding(
                padding: const EdgeInsets.only(top: 12),
                child: Text(error!,
                    style: const TextStyle(color: AnalyticsPalette.muted))),
          const SizedBox(height: 24),
          if (addresses == null)
            const DashboardSkeleton()
          else if (addresses!.isEmpty)
            const DashboardUnavailable(
                'No saved wallets. Open a wallet and tap Watch, or enter an address above.')
          else
            DashboardGrid(columns: 4, children: [
              for (final address in addresses!)
                _CompareWallet(address: address, remove: () => _remove(address))
            ]),
        ]),
      ))
    ]);
    return widget.embedded
        ? body
        : AnalyticsDark(
            child: Scaffold(
                appBar: AppBar(title: const Text('Compare wallets')),
                body: body));
  }
}

class _CompareWallet extends ConsumerWidget {
  const _CompareWallet({required this.address, required this.remove});
  final String address;
  final VoidCallback remove;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final snapshot = ref.watch(dashboardWalletProvider(address));
    final performance = ref.watch(dashboardPerformanceProvider(address));
    final wallet = snapshot.asData?.value;
    final history = performance.asData?.value;
    final proven = history?.data.unavailableReason == null;
    return DashboardCard(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Row(children: [
        Expanded(
            child: TextButton(
                onPressed: () => openAnalyticsWallet(context, address),
                child: Text(shortWallet(address),
                    style: const TextStyle(fontSize: 11)))),
        IconButton(
            tooltip: 'Remove wallet',
            onPressed: remove,
            icon: const Icon(Icons.close, size: 16))
      ]),
      DashboardKpi(
          label: 'Equity',
          value: wallet?.data.margin.equity,
          coverage: 'Current snapshot',
          bare: true,
          loading: snapshot.isLoading),
      DashboardKpi(
          label: 'Win rate',
          value: proven ? history?.data.winRatePct : null,
          coverage: history?.coverage?.label ?? 'Coverage not reported',
          reason: performanceReason(history?.data),
          percent: true,
          money: false,
          bare: true,
          loading: performance.isLoading),
      if (wallet != null)
        Text(
            '${analyticsSource(wallet.source)} · ${utcExact(wallet.asOf)}${wallet.stale ? ' · $dashboardDataNotice' : ''}',
            style: const TextStyle(
                fontSize: 10, height: 1.6, color: AnalyticsPalette.muted)),
      if (snapshot.hasError)
        TextButton(
            onPressed: () => ref.invalidate(dashboardWalletProvider(address)),
            child: const Text('Retry snapshot')),
    ]));
  }
}
