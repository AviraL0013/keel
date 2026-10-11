import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/theme/app_theme.dart';
import 'analytics_models.dart';
import 'analytics_repository.dart';
import 'analytics_widgets.dart';
import 'wallet_screen.dart';
import 'dashboard_screen.dart';
import 'dashboard_style.dart';
import 'dashboard_wallet.dart';
import 'dashboard_market.dart';

class AnalyticsScreen extends StatelessWidget {
  const AnalyticsScreen({super.key});
  @override
  Widget build(BuildContext context) => const AnalyticsDashboard();
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
                  const Text('Monad mainnet'),
                  const SizedBox(height: 12),
                  _WindowSelector(
                    selected: window,
                    onSelected: (next) => setState(() => window = next),
                  ),
                  Text(
                      'Coverage: ${value.historyLabels[window] ?? 'Not reported'}',
                      style: Theme.of(context).textTheme.bodySmall),
                  Text(
                      'Summary source: ${value.summarySources[window] ?? 'Unavailable'}',
                      style: Theme.of(context).textTheme.bodySmall),
                  if (value.windows[window]!.first.note != null)
                    Text('Volume source: ${value.windows[window]!.first.note!}',
                        style: Theme.of(context).textTheme.bodySmall),
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
                            trend: metric.key == 'volume'
                                ? value.volumeSeriesByWindow[window] ??
                                    value.volumeSeries
                                : null,
                            trendLabel: 'Observed trading volume',
                            note: metric.note,
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
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                  'Source: ${value.volumeSources[window] ?? 'Unavailable'}',
                                  style: Theme.of(context).textTheme.bodySmall),
                              const SizedBox(height: 8),
                              AnalyticsChart(
                                key: ValueKey('volume_$window'),
                                label: 'Trading volume',
                                points: value.volumeSeriesByWindow[window] ??
                                    value.volumeSeries,
                              ),
                            ],
                          ),
                        ),
                        AnalyticsPanel(
                          title: 'Net inflow / outflow',
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                  'Source: ${value.flowSources[window] ?? 'Unavailable'}',
                                  style: Theme.of(context).textTheme.bodySmall),
                              const SizedBox(height: 8),
                              AnalyticsChart(
                                key: ValueKey('inflow_$window'),
                                label: 'Net inflow and outflow',
                                points: value.inflowSeriesByWindow[window] ??
                                    value.inflowSeries,
                                color: EyelerColors.defend,
                              ),
                            ],
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
                  Text('Market source: ${value.marketSource ?? 'Unavailable'}',
                      style: Theme.of(context).textTheme.bodySmall),
                  const SizedBox(height: 4),
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
                                        DataColumn(
                                            label: Text('24h volume'),
                                            numeric: true),
                                        DataColumn(
                                            label: Text('OI'), numeric: true),
                                        DataColumn(label: Text('Long / short')),
                                        DataColumn(
                                            label: Text('Funding'),
                                            numeric: true),
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
                                                    compact: true,
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
                        title: value.liquidationCount == null
                            ? 'Recent liquidations (24h) · total unavailable'
                            : 'Recent liquidations (24h) · ${value.liquidationCount} events · ${AnalyticsNumbers.compact(value.liquidationTotal)}',
                        child: value.liquidations.isEmpty
                            ? Text('No observed liquidations · '
                                'source: ${value.liquidationSource ?? 'Unavailable'}')
                            : Column(
                                children: [
                                  Text(
                                      'Source: ${value.liquidationSource ?? 'Unavailable'}',
                                      style: Theme.of(context)
                                          .textTheme
                                          .bodySmall),
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
  const _SkewBar({required this.longShare, this.compact = false});
  final String? longShare;
  final bool compact;
  @override
  Widget build(BuildContext context) {
    final percent = double.tryParse(longShare ?? '');
    if (percent == null || percent < 0 || percent > 100) {
      return const Text('Unavailable · skew value missing');
    }
    final long = percent / 100;
    final parts = longShare!.split('.');
    final decimals = parts.length == 2 ? parts.last.length : 0;
    final scale = BigInt.from(10).pow(decimals);
    final shortUnits = BigInt.from(100) * scale - BigInt.parse(parts.join());
    final short = decimals == 0
        ? shortUnits.toString()
        : '${shortUnits ~/ scale}.${(shortUnits % scale).toString().padLeft(decimals, '0')}';
    return Semantics(
        label:
            'Long and short open interest skew: $longShare% long, $short% short',
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (compact)
              Text('$longShare% long', style: const TextStyle(fontSize: 11))
            else
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Text('$longShare% long'),
                  Text('$short% short'),
                ],
              ),
            const SizedBox(height: 7),
            LayoutBuilder(
              builder: (context, constraints) => ClipRRect(
                borderRadius: BorderRadius.circular(6),
                child: SizedBox(
                  height: compact ? 7 : 12,
                  width: constraints.maxWidth,
                  child: Stack(
                    children: [
                      const Positioned.fill(
                          child: ColoredBox(color: EyelerColors.exit)),
                      SizedBox(
                        width: constraints.maxWidth * long,
                        height: double.infinity,
                        child: const ColoredBox(color: EyelerColors.defend),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ],
        ));
  }
}

void openAnalyticsMarket(BuildContext context, String symbol) =>
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => DashboardMarketScreen(symbol: symbol),
      ),
    );

void openAnalyticsWallet(BuildContext context, String address) =>
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => DashboardWalletProfile(address: address),
      ),
    );

void openAnalyticsWalletSearch(BuildContext context) =>
    Navigator.of(context).push(MaterialPageRoute<void>(
      builder: (_) => AnalyticsDark(
          child: Scaffold(
        appBar: AppBar(title: const Text('Wallet lookup')),
        body: const AnalyticsWalletSearchScreen(),
      )),
    ));

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
                    Text(
                        'Source: ${value.marketSource ?? 'Unavailable'} · '
                        'Coverage: ${value.coverageLabel ?? 'Not reported'}',
                        style: Theme.of(context).textTheme.bodySmall),
                    const SizedBox(height: 8),
                    _WindowSelector(
                      selected: window,
                      values: const ['24h', '7d', '30d'],
                      onSelected: (next) => setState(() => window = next),
                    ),
                    const SizedBox(height: 12),
                    TextButton.icon(
                      onPressed: () => openAnalyticsWalletSearch(context),
                      icon: const Icon(Icons.account_balance_wallet_outlined),
                      label: const Text('Find wallet'),
                    ),
                    AnalyticsPanel(
                      title: 'Price',
                      child: value.priceSeries.isEmpty
                          ? const SizedBox(
                              height: 100,
                              child: Center(
                                  child: Text(
                                      'Price history unavailable from analytics API')))
                          : Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                    'Source: ${value.priceSource ?? 'Unavailable'}',
                                    style:
                                        Theme.of(context).textTheme.bodySmall),
                                const SizedBox(height: 8),
                                AnalyticsChart(
                                    label: 'Price',
                                    points: value.priceSeries,
                                    height: 210),
                              ],
                            ),
                    ),
                    const SizedBox(height: 8),
                    AnalyticsPanel(
                      title: 'Long / short skew',
                      child: _SkewBar(longShare: value.longShare),
                    ),
                    const SizedBox(height: 8),
                    AnalyticsPanel(
                      title: 'Funding history',
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                              'Source: ${value.fundingSource ?? 'Unavailable'}',
                              style: Theme.of(context).textTheme.bodySmall),
                          const SizedBox(height: 8),
                          AnalyticsChart(
                            label: 'Funding rate',
                            points: value.fundingHistory,
                            percent: true,
                            color: EyelerColors.reduce,
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(height: 8),
                    AnalyticsPanel(
                      title: 'Recent liquidations',
                      child: value.liquidations.isEmpty
                          ? Text('No observed liquidations · '
                              'source: ${value.liquidationSource ?? 'Unavailable'}')
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
