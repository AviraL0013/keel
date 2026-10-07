import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/theme/app_theme.dart';
import 'analytics_local_store.dart';
import 'analytics_models.dart';
import 'analytics_repository.dart';
import 'analytics_widgets.dart';
import 'analytics_screen.dart' show openAnalyticsMarket, openAnalyticsWallet;

class AnalyticsWalletSearchScreen extends ConsumerStatefulWidget {
  const AnalyticsWalletSearchScreen({super.key});
  @override
  ConsumerState<AnalyticsWalletSearchScreen> createState() =>
      _AnalyticsWalletSearchScreenState();
}

class _AnalyticsWalletSearchScreenState
    extends ConsumerState<AnalyticsWalletSearchScreen> {
  final controller = TextEditingController();
  List<String> recent = [];
  List<String>? results;
  bool searching = false;
  String? error;

  @override
  void initState() {
    super.initState();
    _loadRecent();
  }

  Future<void> _loadRecent() async {
    try {
      final result = await ref.read(analyticsLocalStoreProvider).recent();
      if (mounted) setState(() => recent = result);
    } catch (_) {
      if (mounted) setState(() => error = 'Recent searches unavailable');
    }
  }

  Future<void> _search(String raw) async {
    final query = raw.trim();
    if (!RegExp(r'^0x[0-9a-fA-F]{6,40}$').hasMatch(query)) {
      setState(() => error = 'Enter at least six hexadecimal digits after 0x.');
      return;
    }
    setState(() {
      error = null;
      searching = true;
    });
    try {
      final matches = await ref.read(analyticsRepositoryProvider).search(query);
      if (!mounted) return;
      setState(() {
        results = matches;
        searching = false;
      });
      if (isAnalyticsAddress(query) &&
          matches
              .any((address) => address.toLowerCase() == query.toLowerCase())) {
        await _open(query);
      }
    } catch (_) {
      if (mounted) {
        setState(() {
          searching = false;
          error = 'Wallet search unavailable. Retry.';
        });
      }
    }
  }

  Future<void> _open(String address) async {
    try {
      await ref.read(analyticsLocalStoreProvider).addRecent(address);
      await _loadRecent();
    } catch (_) {
      // Local storage failure does not block wallet navigation.
    }
    if (mounted) openAnalyticsWallet(context, address);
  }

  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) =>
      ListView(padding: const EdgeInsets.all(16), children: [
        Center(
            child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 820),
                child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('Wallet lookup',
                          style: Theme.of(context).textTheme.headlineSmall),
                      const SizedBox(height: 5),
                      Text('Inspect margin, positions and trading performance.',
                          style: Theme.of(context).textTheme.bodyMedium),
                      const SizedBox(height: 20),
                      TextField(
                          controller: controller,
                          autocorrect: false,
                          enableSuggestions: false,
                          textInputAction: TextInputAction.search,
                          onSubmitted: _search,
                          decoration: InputDecoration(
                              labelText: 'Wallet address',
                              hintText: '0x…',
                              prefixIcon: const Icon(Icons.search),
                              suffixIcon: IconButton(
                                  tooltip: 'Search wallet',
                                  onPressed: () => _search(controller.text),
                                  icon: const Icon(Icons.arrow_forward)))),
                      if (error != null)
                        Padding(
                            padding: const EdgeInsets.only(top: 8),
                            child: Text(error!,
                                style: TextStyle(
                                    color:
                                        Theme.of(context).colorScheme.error))),
                      if (searching)
                        const Padding(
                            padding: EdgeInsets.only(top: 12),
                            child: LinearProgressIndicator()),
                      if (results != null) ...[
                        const SizedBox(height: 16),
                        AnalyticsPanel(
                            title: 'Search results',
                            child: results!.isEmpty
                                ? const Text('No indexed wallets found')
                                : Column(children: [
                                    for (final address in results!)
                                      ListTile(
                                          contentPadding: EdgeInsets.zero,
                                          title: Text(
                                              shortAnalyticsAddress(address)),
                                          subtitle: Text(address,
                                              maxLines: 1,
                                              overflow: TextOverflow.ellipsis),
                                          trailing:
                                              const Icon(Icons.chevron_right),
                                          onTap: () => _open(address))
                                  ])),
                      ],
                      const SizedBox(height: 24),
                      AnalyticsPanel(
                          title: 'Recent searches',
                          child: recent.isEmpty
                              ? const Text('No recent wallets')
                              : Column(children: [
                                  for (final address in recent)
                                    ListTile(
                                        contentPadding: EdgeInsets.zero,
                                        title: Text(
                                            shortAnalyticsAddress(address)),
                                        subtitle: Text(address,
                                            maxLines: 1,
                                            overflow: TextOverflow.ellipsis),
                                        trailing:
                                            const Icon(Icons.chevron_right),
                                        onTap: () => _open(address))
                                ])),
                    ]))),
      ]);
}

class AnalyticsWalletScreen extends ConsumerStatefulWidget {
  const AnalyticsWalletScreen({super.key, required this.address});
  final String address;
  @override
  ConsumerState<AnalyticsWalletScreen> createState() =>
      _AnalyticsWalletScreenState();
}

class _AnalyticsWalletScreenState extends ConsumerState<AnalyticsWalletScreen> {
  List<AnalyticsTrade> trades = [];
  String? cursor;
  bool tradesLoading = true;
  bool tradesLoaded = false;
  bool saved = false;
  String? tradesError;
  String? saveError;

  @override
  void initState() {
    super.initState();
    _loadTrades();
    _loadSaved();
  }

  Future<void> _loadSaved() async {
    try {
      final addresses = await ref.read(analyticsLocalStoreProvider).watchlist();
      if (mounted) {
        setState(() => saved = addresses
            .any((a) => a.toLowerCase() == widget.address.toLowerCase()));
      }
    } catch (_) {
      if (mounted) setState(() => saveError = 'Watchlist unavailable');
    }
  }

  Future<void> _toggleSaved() async {
    try {
      final store = ref.read(analyticsLocalStoreProvider);
      final addresses = await store.watchlist();
      final exists =
          addresses.any((a) => a.toLowerCase() == widget.address.toLowerCase());
      if (!exists && addresses.length >= 4) {
        setState(() => saveError = 'Watchlist holds up to four wallets.');
        return;
      }
      await store.setWatchlist(exists
          ? addresses
              .where((a) => a.toLowerCase() != widget.address.toLowerCase())
              .toList()
          : [...addresses, widget.address]);
      if (mounted) {
        setState(() {
          saved = !exists;
          saveError = null;
        });
      }
    } catch (_) {
      if (mounted) setState(() => saveError = 'Could not save watchlist');
    }
  }

  Future<void> _loadTrades() async {
    if (tradesLoaded && (cursor == null || tradesLoading)) return;
    setState(() {
      tradesLoading = true;
      tradesError = null;
    });
    try {
      final page = await ref
          .read(analyticsRepositoryProvider)
          .trades(widget.address, cursor: tradesLoaded ? cursor : null);
      if (!mounted) return;
      setState(() {
        trades = [...trades, ...page.rows];
        cursor = page.nextCursor;
        tradesLoaded = true;
        tradesLoading = false;
      });
    } catch (_) {
      if (mounted) {
        setState(() {
          tradesError = 'Trade history unavailable';
          tradesLoading = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
      appBar:
          AppBar(title: Text(shortAnalyticsAddress(widget.address)), actions: [
        IconButton(
            tooltip: saved ? 'Remove from watchlist' : 'Save wallet',
            onPressed: _toggleSaved,
            icon: Icon(saved ? Icons.bookmark : Icons.bookmark_outline)),
      ]),
      body: NotificationListener<ScrollNotification>(
          onNotification: (notification) {
            if (notification.metrics.extentAfter < 250 &&
                cursor != null &&
                !tradesLoading) {
              _loadTrades();
            }
            return false;
          },
          child: AnalyticsResource<AnalyticsWallet>(
              load: () =>
                  ref.read(analyticsRepositoryProvider).wallet(widget.address),
              isEmpty: (value) =>
                  value.positions.isEmpty &&
                  value.performance.equitySeries.isEmpty &&
                  value.margin.equity == null &&
                  value.margin.available == null &&
                  value.margin.balance == null &&
                  value.margin.locked == null,
              asOf: (value) => value.asOf,
              isStale: (value) => value.stale,
              emptyMessage: 'No wallet analytics yet',
              body: (context, wallet, refresh) => Center(
                  child: ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 1200),
                      child: Padding(
                          padding: const EdgeInsets.symmetric(horizontal: 16),
                          child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(wallet.address,
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style:
                                        Theme.of(context).textTheme.bodySmall),
                                if (saveError != null)
                                  Text(saveError!,
                                      style: TextStyle(
                                          color: Theme.of(context)
                                              .colorScheme
                                              .error)),
                                const SizedBox(height: 12),
                                _MarginGrid(margin: wallet.margin),
                                const SizedBox(height: 8),
                                AnalyticsPanel(
                                    title: 'Open positions',
                                    child: wallet.positions.isEmpty
                                        ? const Text('No open positions')
                                        : Column(children: [
                                            for (final item in wallet.positions)
                                              _PositionCard(position: item)
                                          ])),
                                const SizedBox(height: 8),
                                _PerformanceSection(
                                    performance: wallet.performance),
                                const SizedBox(height: 8),
                                AnalyticsPanel(
                                    title: 'Trade history',
                                    child: Column(
                                        crossAxisAlignment:
                                            CrossAxisAlignment.start,
                                        children: [
                                          if (trades.isEmpty &&
                                              !tradesLoading &&
                                              tradesError == null)
                                            const Text('No trade history'),
                                          for (final trade in trades)
                                            ListTile(
                                                contentPadding: EdgeInsets.zero,
                                                title: TextButton(
                                                    onPressed: () => openAnalyticsMarket(
                                                        context, trade.market),
                                                    child: Align(
                                                        alignment: Alignment
                                                            .centerLeft,
                                                        child: Text(
                                                            trade.market))),
                                                subtitle: Text(
                                                    '${trade.side} · ${trade.size} · ${analyticsLocalTime(trade.at, context)}'),
                                                trailing: Text(
                                                    AnalyticsNumbers.compact(
                                                        trade.realizedPnl),
                                                    style: TextStyle(
                                                        color: (trade
                                                                    .realizedPnl
                                                                    ?.startsWith('-') ??
                                                                false)
                                                            ? EyelerColors.exit
                                                            : EyelerColors.defend))),
                                          if (tradesLoading)
                                            const Center(
                                                child: Padding(
                                                    padding: EdgeInsets.all(12),
                                                    child:
                                                        CircularProgressIndicator())),
                                          if (tradesError != null)
                                            TextButton(
                                                onPressed: _loadTrades,
                                                child: Text(
                                                    '$tradesError · Retry')),
                                        ])),
                              ])))))));
}

class _MarginGrid extends StatelessWidget {
  const _MarginGrid({required this.margin});
  final AnalyticsMargin margin;
  @override
  Widget build(BuildContext context) =>
      LayoutBuilder(builder: (context, constraints) {
        final count = constraints.maxWidth >= 760 ? 3 : 2;
        return GridView.count(
            crossAxisCount: count,
            shrinkWrap: true,
            physics: const NeverScrollableScrollPhysics(),
            childAspectRatio: constraints.maxWidth < 500 ? 1.35 : 2.3,
            crossAxisSpacing: 8,
            mainAxisSpacing: 8,
            children: [
              AnalyticsMetricTile(label: 'Equity', value: margin.equity),
              AnalyticsMetricTile(label: 'Available', value: margin.available),
              if (margin.locked != null)
                AnalyticsMetricTile(label: 'Locked', value: margin.locked),
              if (margin.balance != null)
                AnalyticsMetricTile(label: 'Balance', value: margin.balance),
              if (margin.maintenance != null)
                AnalyticsMetricTile(
                    label: 'Maintenance', value: margin.maintenance),
            ]);
      });
}

class _PositionCard extends StatelessWidget {
  const _PositionCard({required this.position});
  final AnalyticsPosition position;
  @override
  Widget build(BuildContext context) => Card(
      child: Padding(
          padding: const EdgeInsets.all(12),
          child:
              Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Expanded(
                  child: TextButton(
                      onPressed: () =>
                          openAnalyticsMarket(context, position.market),
                      child: Align(
                          alignment: Alignment.centerLeft,
                          child: Text(position.market)))),
              Text('${position.side} · ${position.leverage}×'),
            ]),
            Wrap(spacing: 18, runSpacing: 10, children: [
              _Fact('Size', position.size),
              _Fact('Entry', AnalyticsNumbers.compact(position.entry)),
              _Fact('Unrealized PnL',
                  AnalyticsNumbers.compact(position.unrealizedPnl)),
              _Fact('Liquidation price',
                  AnalyticsNumbers.compact(position.liquidationPrice)),
              _Fact(
                  'Distance to liquidation',
                  position.liquidationDistance == null
                      ? null
                      : '${position.liquidationDistance}%'),
            ]),
          ])));
}

class _Fact extends StatelessWidget {
  const _Fact(this.label, this.value);
  final String label;
  final String? value;
  @override
  Widget build(BuildContext context) =>
      Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(label, style: Theme.of(context).textTheme.bodySmall),
        Text(value ?? 'Unavailable'),
      ]);
}

class _PerformanceSection extends StatelessWidget {
  const _PerformanceSection({required this.performance});
  final AnalyticsPerformance performance;
  @override
  Widget build(BuildContext context) => AnalyticsPanel(
      title: 'Performance',
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        AnalyticsChart(
            points: performance.equitySeries, color: EyelerColors.defend),
        const SizedBox(height: 12),
        Wrap(spacing: 22, runSpacing: 12, children: [
          _Fact('Win rate',
              performance.winRate == null ? null : '${performance.winRate}%'),
          _Fact('Profit factor', performance.profitFactor),
          _Fact(
              'Max drawdown',
              performance.maxDrawdown == null
                  ? null
                  : '${performance.maxDrawdown}%'),
          _Fact('Current streak', performance.currentStreak),
          _Fact(
              'Average hold',
              performance.averageHoldHours == null
                  ? null
                  : '${performance.averageHoldHours}h'),
          _Fact('Best market', performance.bestMarket),
          _Fact('Worst market', performance.worstMarket),
        ]),
      ]));
}

class AnalyticsWatchlistScreen extends ConsumerStatefulWidget {
  const AnalyticsWatchlistScreen({super.key});
  @override
  ConsumerState<AnalyticsWatchlistScreen> createState() =>
      _AnalyticsWatchlistScreenState();
}

class _AnalyticsWatchlistScreenState
    extends ConsumerState<AnalyticsWatchlistScreen> {
  List<String> addresses = [];
  final Map<String, AnalyticsWallet> wallets = {};
  String? error;
  bool loading = true;

  @override
  void initState() {
    super.initState();
    _reload();
  }

  Future<void> _reload() async {
    setState(() {
      loading = true;
      error = null;
    });
    try {
      final next = await ref.read(analyticsLocalStoreProvider).watchlist();
      final results = await Future.wait(next.map((a) async =>
          MapEntry(a, await ref.read(analyticsRepositoryProvider).wallet(a))));
      if (mounted) {
        setState(() {
          addresses = next;
          wallets
            ..clear()
            ..addEntries(results);
          loading = false;
        });
      }
    } catch (_) {
      if (mounted) {
        setState(() {
          loading = false;
          error = 'Watchlist unavailable';
        });
      }
    }
  }

  Future<void> _remove(String address) async {
    try {
      final next = addresses.where((a) => a != address).toList();
      await ref.read(analyticsLocalStoreProvider).setWatchlist(next);
      _reload();
    } catch (_) {
      if (mounted) setState(() => error = 'Could not update watchlist');
    }
  }

  @override
  Widget build(BuildContext context) => RefreshIndicator(
      onRefresh: _reload,
      child: ListView(padding: const EdgeInsets.all(16), children: [
        Center(
            child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 1440),
                child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('Watchlist & compare',
                          style: Theme.of(context).textTheme.headlineSmall),
                      const SizedBox(height: 4),
                      Text('${addresses.length}/4 wallets saved',
                          style: Theme.of(context).textTheme.bodyMedium),
                      if (!loading && wallets.isNotEmpty)
                        Text(
                            wallets.values.any((wallet) =>
                                    DateTime.now()
                                        .toUtc()
                                        .difference(wallet.asOf) >
                                    const Duration(seconds: 45))
                                ? 'Stale wallet data'
                                : 'Wallet data current',
                            style: TextStyle(
                                color: wallets.values.any((wallet) =>
                                        DateTime.now()
                                            .toUtc()
                                            .difference(wallet.asOf) >
                                        const Duration(seconds: 45))
                                    ? EyelerColors.reduce
                                    : EyelerColors.defend)),
                      const SizedBox(height: 16),
                      if (loading)
                        const SizedBox(height: 350, child: AnalyticsSkeleton()),
                      if (error != null)
                        AnalyticsState(
                            message: error!,
                            action: TextButton(
                                onPressed: _reload,
                                child: const Text('Retry'))),
                      if (!loading && error == null && addresses.isEmpty)
                        const AnalyticsState(
                            message:
                                'No saved wallets. Open a wallet and tap Save.'),
                      if (!loading && error == null && addresses.isNotEmpty)
                        LayoutBuilder(builder: (context, constraints) {
                          final columns = constraints.maxWidth >= 1100
                              ? 4
                              : constraints.maxWidth >= 650
                                  ? 2
                                  : 1;
                          return GridView.builder(
                              shrinkWrap: true,
                              physics: const NeverScrollableScrollPhysics(),
                              gridDelegate:
                                  SliverGridDelegateWithFixedCrossAxisCount(
                                      crossAxisCount: columns,
                                      mainAxisExtent: 246,
                                      mainAxisSpacing: 8,
                                      crossAxisSpacing: 8),
                              itemCount: addresses.length,
                              itemBuilder: (context, index) {
                                final address = addresses[index];
                                final wallet = wallets[address]!;
                                return Card(
                                    child: Padding(
                                        padding: const EdgeInsets.all(16),
                                        child: Column(
                                            crossAxisAlignment:
                                                CrossAxisAlignment.start,
                                            children: [
                                              Row(children: [
                                                Expanded(
                                                    child: TextButton(
                                                        onPressed: () =>
                                                            openAnalyticsWallet(
                                                                context,
                                                                address),
                                                        child: Text(
                                                            shortAnalyticsAddress(
                                                                address)))),
                                                IconButton(
                                                    tooltip: 'Remove wallet',
                                                    onPressed: () =>
                                                        _remove(address),
                                                    icon: const Icon(
                                                        Icons.close)),
                                              ]),
                                              _Fact(
                                                  'Equity',
                                                  AnalyticsNumbers.compact(
                                                      wallet.margin.equity)),
                                              const SizedBox(height: 8),
                                              _Fact(
                                                  'Win rate',
                                                  wallet.performance.winRate ==
                                                          null
                                                      ? null
                                                      : '${wallet.performance.winRate}%'),
                                              const SizedBox(height: 8),
                                              _Fact(
                                                  'Profit factor',
                                                  wallet.performance
                                                      .profitFactor),
                                              const SizedBox(height: 8),
                                              _Fact(
                                                  'Max drawdown',
                                                  wallet.performance
                                                              .maxDrawdown ==
                                                          null
                                                      ? null
                                                      : '${wallet.performance.maxDrawdown}%'),
                                            ])));
                              });
                        }),
                    ]))),
      ]));
}
