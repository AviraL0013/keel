import 'dart:async';

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

class _BookLevel {
  const _BookLevel(this.price, this.size, this.orders);
  final String price, size;
  final int orders;
  factory _BookLevel.fromJson(Object? raw) {
    final value = AnalyticsParse.object(raw);
    return _BookLevel(AnalyticsParse.decimal(value, 'price'),
        AnalyticsParse.decimal(value, 'size'), V1.integer(value, 'orders'));
  }
}

class _MarketBook {
  const _MarketBook(this.marketId, this.bids, this.asks, this.spreadBps);
  final int marketId;
  final List<_BookLevel> bids, asks;
  final String? spreadBps;
  factory _MarketBook.fromJson(Object? raw) {
    final value = AnalyticsParse.object(raw);
    final bids = V1.list(value, 'bids', _BookLevel.fromJson);
    final asks = V1.list(value, 'asks', _BookLevel.fromJson);
    if (bids.length > 5 ||
        asks.length > 5 ||
        [...bids, ...asks].any((level) =>
            level.orders <= 0 ||
            AnalyticsDecimal.parse(level.price).units <= BigInt.zero ||
            AnalyticsDecimal.parse(level.size).units <= BigInt.zero)) {
      throw const FormatException('Invalid order book');
    }
    return _MarketBook(V1.integer(value, 'marketId'), bids, asks,
        AnalyticsParse.optionalDecimal(value, 'spreadBps'));
  }
}

final _marketBook =
    FutureProvider.family<V1Envelope<_MarketBook>, int>((ref, id) {
  return ref.watch(dashboardApiProvider).request(
      '/markets/$id/book', _MarketBook.fromJson,
      ttl: const Duration(seconds: 5), validate: (value) {
    if (value.marketId != id) {
      throw const FormatException('Mismatched order book');
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
  Timer? _bookTimer;
  @override
  void initState() {
    super.initState();
    _bookTimer = Timer.periodic(const Duration(seconds: 10), (_) {
      final market = ref
          .read(dashboardMarketsProvider)
          .asData
          ?.value
          .data
          .where((item) => item.symbol == widget.symbol)
          .firstOrNull;
      if (market != null) ref.invalidate(_marketBook(market.id));
    });
  }

  @override
  void dispose() {
    _bookTimer?.cancel();
    super.dispose();
  }

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
    final book = ref.watch(_marketBook(id));
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
      DashboardCard(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            const Expanded(
                child: Text('Order book',
                    style:
                        TextStyle(fontSize: 18, fontWeight: FontWeight.w600))),
            if (book.asData?.value.data.spreadBps case final spread?)
              Text('Spread $spread bps',
                  style: const TextStyle(
                      color: AnalyticsPalette.muted, fontSize: 12)),
          ]),
          const SizedBox(height: 6),
          Text(
              book.asData == null
                  ? 'Perpl public order book'
                  : 'Perpl API · ${utcExact(book.asData!.value.asOf)}${book.asData!.value.stale ? ' · Data delayed' : ''}',
              style:
                  const TextStyle(color: AnalyticsPalette.muted, fontSize: 11)),
          const SizedBox(height: 16),
          if (book.isLoading && book.asData == null)
            const DashboardSkeleton(height: 110)
          else if (book.asData == null)
            DashboardUnavailable('Perpl order book is temporarily unavailable.',
                retry: () => ref.invalidate(_marketBook(id)))
          else
            DashboardGrid(children: [
              _BookSide(
                  'Bids', book.asData!.value.data.bids, AnalyticsPalette.up),
              _BookSide(
                  'Asks', book.asData!.value.data.asks, AnalyticsPalette.down),
            ]),
        ]),
      ),
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
                '${analyticsSource(snapshot.source)} · ${utcExact(snapshot.asOf)}${snapshot.stale ? ' · $dashboardDataNotice' : ''}',
                style: const TextStyle(
                    fontSize: 11, color: AnalyticsPalette.muted))),
    ]);
  }
}

class _BookSide extends StatelessWidget {
  const _BookSide(this.label, this.levels, this.color);
  final String label;
  final List<_BookLevel> levels;
  final Color color;
  @override
  Widget build(BuildContext context) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label,
              style: TextStyle(color: color, fontWeight: FontWeight.w600)),
          const SizedBox(height: 8),
          if (levels.isEmpty)
            const Text('No resting levels',
                style: TextStyle(color: AnalyticsPalette.muted, fontSize: 12)),
          for (final level in levels)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 4),
              child: Row(children: [
                Expanded(
                    child: Text(level.price,
                        style: TextStyle(color: color, fontFeatures: const [
                          FontFeature.tabularFigures()
                        ]))),
                Expanded(
                    child: Text(level.size,
                        textAlign: TextAlign.right,
                        style: const TextStyle(
                            fontFeatures: [FontFeature.tabularFigures()]))),
                SizedBox(
                    width: 42,
                    child: Text('${level.orders}',
                        textAlign: TextAlign.right,
                        style: const TextStyle(color: AnalyticsPalette.muted))),
              ]),
            ),
          const SizedBox(height: 3),
          const Text('Price · Size · Orders',
              style: TextStyle(color: AnalyticsPalette.muted, fontSize: 10)),
        ],
      );
}
