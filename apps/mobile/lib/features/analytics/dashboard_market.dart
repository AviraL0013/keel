import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'analytics_contract.dart';
import 'analytics_models.dart';
import 'analytics_screen.dart' show openAnalyticsWalletSearch;
import 'dashboard_chart.dart';
import 'dashboard_data.dart';
import 'dashboard_style.dart';

final _marketDetail =
    FutureProvider.family<V1Envelope<V1MarketDetail>, int>((ref, id) {
  return ref
      .watch(dashboardApiProvider)
      .request('/markets/$id', V1MarketDetail.fromJson, validate: (value) {
    if (value.market.id != id) {
      throw const FormatException('Mismatched market');
    }
  });
});
final _marketPrices =
    FutureProvider.family<V1Envelope<V1MarketPrices>, (int, DashboardRange)>(
        (ref, key) {
  final api = ref.watch(dashboardApiProvider);
  final (from, to) = api.bounds(key.$2);
  final query =
      'from=${Uri.encodeQueryComponent(wireTime(from))}&to=${Uri.encodeQueryComponent(wireTime(to))}';
  return api.request(
      '/markets/${key.$1}/prices?interval=1d&$query', V1MarketPrices.fromJson,
      ttl: const Duration(minutes: 5), validate: (value) {
    if (value.marketId != key.$1 ||
        value.from != from ||
        value.to != to ||
        value.interval != '1d') {
      throw const FormatException('Mismatched market history');
    }
  });
});
final _marketFunding =
    FutureProvider.family<V1Envelope<V1MarketFunding>, (int, DashboardRange)>(
        (ref, key) {
  final api = ref.watch(dashboardApiProvider);
  // The endpoint caps funding observations at 1,024. Wider selectors retain the
  // available 30-day view and state that limit rather than implying 90-day data.
  final range = key.$2 == DashboardRange.week
      ? DashboardRange.week
      : DashboardRange.month;
  return api.request('/markets/${key.$1}/funding?${api.rangeQuery(range)}',
      V1MarketFunding.fromJson, ttl: const Duration(minutes: 5),
      validate: (value) {
    if (value.marketId != key.$1) {
      throw const FormatException('Mismatched funding market');
    }
  });
});

class DashboardMarketScreen extends ConsumerStatefulWidget {
  const DashboardMarketScreen({super.key, required this.symbol});
  final String symbol;
  @override
  ConsumerState<DashboardMarketScreen> createState() =>
      _DashboardMarketScreenState();
}

class _DashboardMarketScreenState extends ConsumerState<DashboardMarketScreen> {
  DashboardRange range = DashboardRange.month;
  @override
  Widget build(BuildContext context) {
    final markets = ref.watch(dashboardMarketsProvider);
    final market = markets.asData?.value.data
        .where((m) => m.symbol == widget.symbol)
        .firstOrNull;
    return AnalyticsDark(
        child: Scaffold(
      appBar: AppBar(title: Text(widget.symbol)),
      body: ListView(padding: const EdgeInsets.all(24), children: [
        Center(
            child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 1440),
          child:
              Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('${widget.symbol} market',
                style:
                    const TextStyle(fontSize: 28, fontWeight: FontWeight.w600)),
            const SizedBox(height: 8),
            const Text('Perpl on Monad · current market and available history',
                style: TextStyle(color: AnalyticsPalette.muted, fontSize: 12)),
            const SizedBox(height: 20),
            Wrap(spacing: 6, children: [
              for (final value in DashboardRange.values)
                TextButton(
                    onPressed: () => setState(() => range = value),
                    style: TextButton.styleFrom(
                        backgroundColor:
                            value == range ? AnalyticsPalette.elevated : null),
                    child: Text(value.label)),
              TextButton.icon(
                  onPressed: () => openAnalyticsWalletSearch(context),
                  icon: const Icon(Icons.search, size: 18),
                  label: const Text('Find wallet')),
            ]),
            const SizedBox(height: 20),
            if (markets.isLoading)
              const DashboardSkeleton()
            else if (market == null)
              DashboardUnavailable('Market data unavailable.',
                  retry: () => ref.invalidate(dashboardMarketsProvider))
            else
              _MarketContent(id: market.id, range: range),
          ]),
        ))
      ]),
    ));
  }
}

class _MarketContent extends ConsumerWidget {
  const _MarketContent({required this.id, required this.range});
  final int id;
  final DashboardRange range;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final detail = ref.watch(_marketDetail(id));
    final prices = ref.watch(_marketPrices((id, range)));
    final funding = ref.watch(_marketFunding((id, range)));
    final snapshot = detail.asData?.value;
    final price = prices.asData?.value;
    final rate = funding.asData?.value;
    final market = snapshot?.data.market;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      DashboardGrid(columns: 4, children: [
        DashboardKpi(
            label: 'Mark price',
            value: market?.markPrice,
            coverage: 'Current snapshot',
            loading: detail.isLoading),
        DashboardKpi(
            label: '24h Volume',
            value: market?.volume24h,
            coverage: 'Last 24 hours',
            loading: detail.isLoading),
        DashboardKpi(
            label: 'Open Interest',
            value: market?.openInterest,
            coverage: 'Current snapshot',
            loading: detail.isLoading),
        DashboardKpi(
            label: 'TVL',
            value: snapshot?.data.tvl,
            coverage: 'Current snapshot',
            loading: detail.isLoading),
      ]),
      const SizedBox(height: 24),
      DashboardGrid(children: [
        DashboardChartCard(
            title: 'Price',
            description:
                'Completed candle closes. Missing candles remain unknown.',
            series: [
              DashboardSeries(market?.symbol ?? 'Close',
                  price?.data.points.map((p) => p.toView()).toList() ?? [])
            ],
            initialType: DashboardChartType.line,
            brush: true,
            loading: prices.isLoading,
            source: price == null ? null : analyticsSource(price.source),
            asOf: price?.asOf,
            stale: price?.stale ?? false,
            coverage: range == DashboardRange.all
                ? 'Up to 2 years'
                : 'Last ${range.days} days',
            unavailableReason: 'Price history unavailable for this range.',
            retry: prices.hasError
                ? () => ref.invalidate(_marketPrices((id, range)))
                : null),
        DashboardChartCard(
            title: 'Funding history',
            description: 'Signed rate per funding interval; no annualization.',
            series: [
              DashboardSeries(
                  'Funding rate',
                  rate?.data.points.map((p) {
                        final value = AnalyticsDecimal.parse(p.rate);
                        return AnalyticsPoint(
                            p.time,
                            AnalyticsDecimal(
                                    value.units * BigInt.from(100), value.scale)
                                .toString());
                      }).toList() ??
                      [])
            ],
            money: false,
            percent: true,
            initialType: DashboardChartType.line,
            loading: funding.isLoading,
            source: rate == null ? null : analyticsSource(rate.source),
            asOf: rate?.asOf,
            stale: rate?.stale ?? false,
            coverage:
                'Last ${range == DashboardRange.week ? 7 : 30} days · up to 1,024 observations',
            unavailableReason: 'Funding history unavailable for this market.',
            retry: funding.hasError
                ? () => ref.invalidate(_marketFunding((id, range)))
                : null),
      ]),
      const SizedBox(height: 24),
      DashboardGrid(columns: 3, children: [
        DashboardKpi(
            label: 'Long open interest',
            value: market?.longOpenInterest,
            coverage: 'Current snapshot',
            reason: 'Indexed long exposure is not verified.'),
        DashboardKpi(
            label: 'Short open interest',
            value: market?.shortOpenInterest,
            coverage: 'Current snapshot',
            reason: 'Indexed short exposure is not verified.'),
        DashboardKpi(
            label: 'Long share',
            value: market?.longSharePct,
            percent: true,
            money: false,
            coverage: 'Current snapshot',
            reason: 'Verified long and short exposure is required.'),
      ]),
      if (snapshot != null)
        Padding(
            padding: const EdgeInsets.only(top: 18),
            child: Text(
                '${analyticsSource(snapshot.source)} · ${utcExact(snapshot.asOf)}${snapshot.stale ? ' · Stale / partial' : ''}',
                style: const TextStyle(
                    fontSize: 11, color: AnalyticsPalette.muted))),
    ]);
  }
}
