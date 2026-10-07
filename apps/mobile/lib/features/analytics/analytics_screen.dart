import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/theme/app_theme.dart';
import 'analytics_models.dart';
import 'analytics_repository.dart';
import 'analytics_widgets.dart';
import 'wallet_screen.dart';

class AnalyticsScreen extends StatefulWidget {
  const AnalyticsScreen({super.key});
  @override
  State<AnalyticsScreen> createState() => _AnalyticsScreenState();
}

class _AnalyticsScreenState extends State<AnalyticsScreen> {
  int selected = 0;
  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Analytics')),
        body: Column(
          children: [
            if (analyticsFixtureMode)
              Container(
                width: double.infinity,
                padding:
                    const EdgeInsets.symmetric(horizontal: 16, vertical: 7),
                color: EyelerColors.accent.withValues(alpha: .14),
                child: const Text(
                  'Sample data · analytics API pending',
                  style: TextStyle(fontSize: 12),
                ),
              ),
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 4, 12, 8),
              child: Row(
                children: [
                  for (final (index, label, icon) in [
                    (0, 'Protocol', Icons.analytics_outlined),
                    (1, 'Wallet', Icons.account_balance_wallet_outlined),
                    (2, 'Watchlist', Icons.bookmark_outline),
                  ])
                    Expanded(
                      child: TextButton.icon(
                        key: Key('analytics_tab_$index'),
                        onPressed: () => setState(() => selected = index),
                        icon: Icon(icon, size: 18),
                        label:
                            Text(label, style: const TextStyle(fontSize: 11)),
                        style: TextButton.styleFrom(
                          minimumSize: const Size(0, 48),
                          foregroundColor: selected == index
                              ? Theme.of(context).colorScheme.onSurface
                              : Theme.of(context).textTheme.bodyMedium?.color,
                          backgroundColor: selected == index
                              ? Theme.of(context).colorScheme.surface
                              : null,
                        ),
                      ),
                    ),
                ],
              ),
            ),
            Expanded(
              child: switch (selected) {
                0 => const ProtocolOverviewScreen(),
                1 => const AnalyticsWalletSearchScreen(),
                _ => const AnalyticsWatchlistScreen(),
              },
            ),
          ],
        ),
      );
}

class ProtocolOverviewScreen extends ConsumerStatefulWidget {
  const ProtocolOverviewScreen({super.key});
  @override
  ConsumerState<ProtocolOverviewScreen> createState() =>
      _ProtocolOverviewScreenState();
}

class _ProtocolOverviewScreenState
    extends ConsumerState<ProtocolOverviewScreen> {
  String window = '24h';
  @override
  Widget build(BuildContext context) => AnalyticsResource<AnalyticsOverview>(
        load: () => ref.read(analyticsRepositoryProvider).overview(),
        isEmpty: (value) =>
            value.windows['24h']!.isEmpty &&
            value.markets.isEmpty &&
            value.volumeSeries.isEmpty &&
            value.inflowSeries.isEmpty &&
            value.liquidations.isEmpty,
        asOf: (value) => value.asOf,
        isStale: (value) => value.stale,
        emptyMessage: 'No protocol analytics yet',
        body: (context, value, refresh) => Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 1440),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const _Heading(
                    title: 'Protocol overview',
                    subtitle: 'Perpl activity and risk',
                  ),
                  const SizedBox(height: 12),
                  _WindowSelector(
                    selected: window,
                    onSelected: (next) => setState(() => window = next),
                  ),
                  if (window == 'All')
                    Text('Charts show the latest two years.',
                        style: Theme.of(context).textTheme.bodySmall),
                  const SizedBox(height: 12),
                  LayoutBuilder(
                    builder: (context, constraints) {
                      final count = constraints.maxWidth >= 1000
                          ? 5
                          : constraints.maxWidth >= 600
                              ? 3
                              : 2;
                      return GridView.builder(
                        physics: const NeverScrollableScrollPhysics(),
                        shrinkWrap: true,
                        gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
                          crossAxisCount: count,
                          mainAxisSpacing: 8,
                          crossAxisSpacing: 8,
                          mainAxisExtent: 150,
                        ),
                        itemCount: value.windows[window]!.length,
                        itemBuilder: (context, index) {
                          final metric = value.windows[window]![index];
                          return AnalyticsMetricTile(
                            label: _metricName(metric.key),
                            value: metric.value,
                            delta: metric.delta,
                            money: metric.key != 'activeUsers',
                          );
                        },
                      );
                    },
                  ),
                  const SizedBox(height: 12),
                  LayoutBuilder(
                    builder: (context, constraints) {
                      final wide = constraints.maxWidth >= 760;
                      final charts = [
                        AnalyticsPanel(
                          title: 'Trading volume',
                          child: AnalyticsChart(
                            key: ValueKey('volume_$window'),
                            points: value.volumeSeriesByWindow[window] ??
                                value.volumeSeries,
                          ),
                        ),
                        AnalyticsPanel(
                          title: 'Net inflow / outflow',
                          child: AnalyticsChart(
                            key: ValueKey('inflow_$window'),
                            points: value.inflowSeriesByWindow[window] ??
                                value.inflowSeries,
                            color: EyelerColors.defend,
                          ),
                        ),
                      ];
                      return wide
                          ? Row(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                for (final chart in charts)
                                  Expanded(
                                    child: Padding(
                                      padding: const EdgeInsets.only(right: 8),
                                      child: chart,
                                    ),
                                  ),
                              ],
                            )
                          : Column(
                              children: [
                                for (final chart in charts)
                                  Padding(
                                    padding: const EdgeInsets.only(bottom: 8),
                                    child: chart,
                                  ),
                              ],
                            );
                    },
                  ),
                  const SizedBox(height: 8),
                  AnalyticsPanel(
                    title: 'Markets',
                    child: value.markets.isEmpty
                        ? const Text('No markets yet')
                        : LayoutBuilder(
                            builder: (context, constraints) =>
                                SingleChildScrollView(
                                  scrollDirection: Axis.horizontal,
                                  child: ConstrainedBox(
                                    constraints: BoxConstraints(
                                        minWidth: constraints.maxWidth),
                                    child: DataTable(
                                      columnSpacing: 20,
                                      dataRowMinHeight: 56,
                                      dataRowMaxHeight: 62,
                                      columns: const [
                                        DataColumn(label: Text('Market')),
                                        DataColumn(label: Text('24h volume')),
                                        DataColumn(label: Text('OI')),
                                        DataColumn(label: Text('Long / short')),
                                        DataColumn(label: Text('Funding')),
                                      ],
                                      rows: [
                                        for (final market in value.markets)
                                          DataRow(
                                            cells: [
                                              DataCell(
                                                TextButton(
                                                  onPressed: () =>
                                                      openAnalyticsMarket(
                                                    context,
                                                    market.symbol,
                                                  ),
                                                  child: Text(market.symbol),
                                                ),
                                              ),
                                              DataCell(
                                                Text(
                                                  AnalyticsNumbers.compact(
                                                      market.volume),
                                                ),
                                              ),
                                              DataCell(
                                                Text(AnalyticsNumbers.compact(
                                                    market.oi)),
                                              ),
                                              DataCell(
                                                SizedBox(
                                                  width: 105,
                                                  child: _SkewBar(
                                                    longShare: market.longShare,
                                                  ),
                                                ),
                                              ),
                                              DataCell(Text(
                                                  market.funding == null
                                                      ? 'Unavailable'
                                                      : '${market.funding}%')),
                                            ],
                                          ),
                                      ],
                                    ),
                                  ),
                                )),
                  ),
                  const SizedBox(height: 8),
                  LayoutBuilder(
                    builder: (context, constraints) {
                      final funding = AnalyticsPanel(
                        title: 'Funding overview',
                        child: value.markets.isEmpty
                            ? const Text('No funding data')
                            : Column(
                                children: [
                                  for (final market in value.markets)
                                    ListTile(
                                      contentPadding: EdgeInsets.zero,
                                      title: Text(market.symbol),
                                      trailing: Text(market.funding == null
                                          ? 'Unavailable'
                                          : '${market.funding}%'),
                                    ),
                                ],
                              ),
                      );
                      final liquidations = AnalyticsPanel(
                        title:
                            'Recent liquidations (24h) · ${value.liquidationCount ?? value.liquidations.length} events · ${AnalyticsNumbers.compact(value.liquidationTotal)}',
                        child: value.liquidations.isEmpty
                            ? const Text('No recent liquidations')
                            : Column(
                                children: [
                                  for (final item in value.liquidations)
                                    AnalyticsLiquidationRow(item: item),
                                ],
                              ),
                      );
                      if (constraints.maxWidth < 760) {
                        return Column(
                          children: [
                            funding,
                            const SizedBox(height: 8),
                            liquidations,
                          ],
                        );
                      }
                      return Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Expanded(child: funding),
                          const SizedBox(width: 8),
                          Expanded(child: liquidations),
                        ],
                      );
                    },
                  ),
                  if (value.insight case final insight?) ...[
                    const SizedBox(height: 8),
                    AnalyticsPanel(title: 'Insight', child: Text(insight)),
                  ],
                ],
              ),
            ),
          ),
        ),
      );
}

String _metricName(String key) => switch (key) {
      'volume' => 'Volume',
      'oi' => 'Open interest',
      'tvl' => 'TVL',
      'fees' => 'Fees',
      'activeUsers' => 'Active users',
      _ => key,
    };

class _Heading extends StatelessWidget {
  const _Heading({required this.title, required this.subtitle});
  final String title, subtitle;
  @override
  Widget build(BuildContext context) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title, style: Theme.of(context).textTheme.headlineSmall),
          const SizedBox(height: 4),
          Text(subtitle, style: Theme.of(context).textTheme.bodyMedium),
        ],
      );
}

class _WindowSelector extends StatelessWidget {
  const _WindowSelector(
      {required this.selected,
      required this.onSelected,
      this.values = const ['24h', '7d', '30d', 'All']});
  final String selected;
  final ValueChanged<String> onSelected;
  final List<String> values;
  @override
  Widget build(BuildContext context) => Wrap(
        spacing: 6,
        children: [
          for (final value in values)
            OutlinedButton(
              onPressed: () => onSelected(value),
              style: OutlinedButton.styleFrom(
                minimumSize: const Size(64, 48),
                padding: const EdgeInsets.symmetric(horizontal: 8),
                backgroundColor: value == selected
                    ? EyelerColors.accent.withValues(alpha: .24)
                    : null,
              ),
              child: Text(value),
            ),
        ],
      );
}

class _SkewBar extends StatelessWidget {
  const _SkewBar({required this.longShare});
  final String? longShare;
  @override
  Widget build(BuildContext context) {
    if (longShare == null) return const Text('Skew unavailable');
    final long = (double.tryParse(longShare!) ?? 0).clamp(0, 100) / 100;
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Text('$longShare% long', style: const TextStyle(fontSize: 11)),
        const SizedBox(height: 3),
        ClipRRect(
          borderRadius: BorderRadius.circular(5),
          child: SizedBox(
            height: 5,
            child: Row(
              children: [
                Expanded(
                  flex: (long * 100).round().clamp(1, 99),
                  child: const ColoredBox(color: EyelerColors.defend),
                ),
                Expanded(
                  flex: 100 - (long * 100).round().clamp(1, 99),
                  child: const ColoredBox(color: EyelerColors.exit),
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }
}

void openAnalyticsMarket(BuildContext context, String symbol) =>
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => AnalyticsMarketScreen(symbol: symbol),
      ),
    );

void openAnalyticsWallet(BuildContext context, String address) =>
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => AnalyticsWalletScreen(address: address),
      ),
    );

class AnalyticsLiquidationRow extends StatelessWidget {
  const AnalyticsLiquidationRow({super.key, required this.item});
  final AnalyticsLiquidation item;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 8),
        child: Wrap(
          crossAxisAlignment: WrapCrossAlignment.center,
          spacing: 8,
          children: [
            TextButton(
              onPressed: () => openAnalyticsMarket(context, item.market),
              child: Text(item.market),
            ),
            Text(
                '${item.side ?? 'Unknown side'} · ${AnalyticsNumbers.compact(item.notional)}'),
            if (item.address case final address?)
              TextButton(
                onPressed: () => openAnalyticsWallet(context, address),
                child: Text(shortAnalyticsAddress(address)),
              )
            else
              const Text('Unknown wallet'),
            Text(
              analyticsLocalTime(item.at, context),
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ],
        ),
      );
}

class AnalyticsMarketScreen extends ConsumerStatefulWidget {
  const AnalyticsMarketScreen({super.key, required this.symbol});
  final String symbol;
  @override
  ConsumerState<AnalyticsMarketScreen> createState() =>
      _AnalyticsMarketScreenState();
}

class _AnalyticsMarketScreenState extends ConsumerState<AnalyticsMarketScreen> {
  String window = '24h';
  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: Text(widget.symbol)),
        body: AnalyticsResource<AnalyticsMarketDetail>(
          key: ValueKey('${widget.symbol}_$window'),
          load: () => ref
              .read(analyticsRepositoryProvider)
              .market(widget.symbol, window),
          isEmpty: (value) =>
              value.priceSeries.isEmpty &&
              value.fundingHistory.isEmpty &&
              value.liquidations.isEmpty &&
              value.longShare == null,
          asOf: (value) => value.asOf,
          isStale: (value) => value.stale,
          emptyMessage: 'No market analytics yet',
          body: (context, value, refresh) => Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 1200),
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    _WindowSelector(
                      selected: window,
                      values: const ['24h', '7d', '30d'],
                      onSelected: (next) => setState(() => window = next),
                    ),
                    const SizedBox(height: 12),
                    AnalyticsPanel(
                      title: 'Price',
                      child: value.priceSeries.isEmpty
                          ? const SizedBox(
                              height: 100,
                              child: Center(
                                  child: Text(
                                      'Price history unavailable from analytics API')))
                          : AnalyticsChart(
                              points: value.priceSeries, height: 210),
                    ),
                    const SizedBox(height: 8),
                    AnalyticsPanel(
                      title: 'Long / short skew',
                      child: _SkewBar(longShare: value.longShare),
                    ),
                    const SizedBox(height: 8),
                    AnalyticsPanel(
                      title: 'Funding history',
                      child: AnalyticsChart(
                        points: value.fundingHistory,
                        color: EyelerColors.reduce,
                      ),
                    ),
                    const SizedBox(height: 8),
                    AnalyticsPanel(
                      title: 'Recent liquidations',
                      child: value.liquidations.isEmpty
                          ? const Text('No recent liquidations')
                          : Column(
                              children: [
                                for (final item in value.liquidations)
                                  AnalyticsLiquidationRow(item: item),
                              ],
                            ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      );
}
