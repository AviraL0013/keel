import 'dart:async';

import 'package:eyeler_mobile/features/analytics/analytics_models.dart';
import 'package:eyeler_mobile/features/analytics/analytics_contract.dart';
import 'package:eyeler_mobile/features/analytics/dashboard_wallet.dart';
import 'package:eyeler_mobile/features/analytics/dashboard_chart.dart';
import 'package:eyeler_mobile/features/analytics/dashboard_data.dart';
import 'package:flutter_test/flutter_test.dart';

import 'dashboard_fixture.dart';

void main() {
  test(
      'current exposure sums marked notionals exactly and fails closed on missing marks',
      () async {
    final raw = await RecordedDashboard()
            .get('/analytics/v1/wallets/${RecordedDashboard.wallet}')
        as Map<String, dynamic>;
    final profile = raw['data'] as Map<String, dynamic>;
    final positions = profile['positions'] as List;
    profile['positions'] = [positions[0], positions[1]];
    (positions[0] as Map)['notional'] = '9007199254740993.000001';
    (positions[1] as Map)['notional'] = '0.000002';
    final exposure =
        DashboardWalletExposure.fromProfile(V1WalletProfile.fromJson(profile));
    expect(exposure?.gross, '9007199254740993.000003');
    expect(exposure?.long, '9007199254740993.000001');
    expect(exposure?.short, '0.000002');
    (positions[1] as Map)['notional'] = null;
    expect(
        DashboardWalletExposure.fromProfile(V1WalletProfile.fromJson(profile)),
        isNull);
  });

  test('All liquidation view requests only the 90 days accepted by the API',
      () async {
    final recorded = RecordedDashboard();
    await recorded.api.liquidations(DashboardRange.all);
    final uri = Uri.parse(recorded.requests.single);
    final from = DateTime.parse(uri.queryParameters['from']!);
    final to = DateTime.parse(uri.queryParameters['to']!);
    expect(to.difference(from), const Duration(days: 90));
  });

  test('daily flows sum only observed hours and preserve exact signs', () {
    final flows = dailyAnalyticsFlows([
      V1FlowBucket(
          DateTime.utc(2026, 10, 5, 2), '10.000001', '2.000002', '7.999999'),
      V1FlowBucket(
          DateTime.utc(2026, 10, 5, 3), '1.000001', '5.000001', '-4.000000'),
      V1FlowBucket(
          DateTime.utc(2026, 10, 7), '3.000003', '0.000000', '3.000003'),
    ]);
    expect(flows, hasLength(2));
    expect(flows.first.deposits, '11.000002');
    expect(flows.first.withdrawals, '7.000003');
    expect(flows.first.net, '3.999999');
    expect(flows.last.time, DateTime.utc(2026, 10, 7));
  });

  test(
      'optional revenue, recording dates, daily liquidations and margin fields activate without replacing v1',
      () async {
    final recorded = RecordedDashboard();
    final summary =
        await recorded.get('/analytics/v1/protocol/summary?window=30d')
            as Map<String, dynamic>;
    final points = [
      {'time': '2026-10-05T00:00:00.000Z', 'value': '0.000001'}
    ];
    final daily = {
      'interval': '1d',
      'from': '2026-09-11T00:00:00.000Z',
      'to': '2026-10-11T00:00:00.000Z',
      'points': points
    };
    summary['data']['revenue']['history'] = {
      'asOf': summary['asOf'],
      'block': null,
      'source': 'monad_exchange',
      'stale': false,
      'data': daily
    };
    expect(
        DashboardSummary.fromJson(summary['data'])
            .revenueHistory!
            .data
            .points
            .single
            .value,
        '0.000001');
    final profile =
        await recorded.get('/analytics/v1/wallets/${RecordedDashboard.wallet}')
            as Map<String, dynamic>;
    profile['data']['margin']['used'] = '123.000001';
    expect(
        DashboardWalletData.fromJson(profile['data']).marginUsed, '123.000001');
    final liquidations = await recorded.get('/analytics/v1/liquidations')
        as Map<String, dynamic>;
    liquidations['data']['dailyNotional'] = daily;
    expect(
        DashboardLiquidationPage.fromJson(liquidations['data'])
            .dailyNotional!
            .points
            .single
            .value,
        '0.000001');
    final history = DashboardHistory.fromJson({
      ...daily,
      'metric': 'oi',
      'historyStartedAt': '2026-10-05T00:00:00.000Z',
      'unavailableReason': 'Recording has begun.'
    });
    expect(history.historyStartedAt, DateTime.utc(2026, 10, 5));
    expect(history.unavailableReason, 'Recording has begun.');
  });

  test(
      'exact aggregation and CSV retain decimal strings beyond double precision',
      () {
    expect(AnalyticsDecimal.sum(['9007199254740993.000001', '-0.000002']),
        '9007199254740992.999999');
    expect(AnalyticsDecimal.sum(['1.000000', null]), isNull);
    final series = [
      DashboardSeries('Volume', [
        AnalyticsPoint(DateTime.utc(2026, 10, 5), '9007199254740993.000001'),
        AnalyticsPoint(DateTime.utc(2026, 10, 6), null),
      ])
    ];
    final csv = analyticsCsv(series);
    expect(
        csv, contains('"2026-10-05T00:00:00.000Z","9007199254740993.000001"'));
    expect(csv, contains('"2026-10-06T00:00:00.000Z",""'));
    expect(analyticsCsv([DashboardSeries('=SUM(A1)', series.first.points)]),
        contains("'=SUM(A1)"));
  });

  test('weekly and monthly totals preserve explicit and implicit missing days',
      () {
    final points = [
      for (var day = 5; day <= 7; day++)
        AnalyticsPoint(DateTime.utc(2026, 10, day), '1.000001')
    ];
    expect(aggregateAnalyticsDays(points, DashboardGrain.week).single.value,
        '3.000003');
    expect(
        aggregateAnalyticsDays([points.first, points.last], DashboardGrain.week)
            .single
            .value,
        isNull);
    expect(
        aggregateAnalyticsDays(
                [points.first, AnalyticsPoint(points[1].at, null), points.last],
                DashboardGrain.month)
            .single
            .value,
        isNull);
    final cumulative = cumulativeAnalyticsPoints(
        [points.first, AnalyticsPoint(points[1].at, null), points.last]);
    expect(cumulative.map((p) => p.value), ['1.000001', null, null]);
  });

  test(
      'parallel endpoint loads cache and coalesce without waiting for slow history',
      () async {
    final recorded = RecordedDashboard();
    final pending = Completer<Object?>();
    var calls = 0;
    final api = DashboardApi((path) {
      calls++;
      return path.contains('timeseries') ? pending.future : recorded.get(path);
    }, now: () => RecordedDashboard.now);
    final slow = api.history('volume', DashboardRange.month);
    final first = api.summary('24h'), second = api.summary('24h');
    expect((await first).data.metrics['volume']!.value, '11385705.591334');
    await second;
    await api.summary('24h');
    expect(calls, 2);
    pending.complete(await recorded.get(
        '/analytics/v1/protocol/timeseries?metric=volume&interval=1d&${api.rangeQuery(DashboardRange.month)}'));
    expect((await slow).data.total.points, hasLength(30));
  });

  test('errors are evicted and foreign history ranges rejected', () async {
    var calls = 0;
    final recorded = RecordedDashboard();
    final api = DashboardApi((path) async {
      if (calls++ == 0) throw StateError('offline');
      return recorded.get(path);
    }, now: () => RecordedDashboard.now);
    await expectLater(api.summary('24h'), throwsStateError);
    expect((await api.summary('24h')).data.window, '24h');
    var historyCalls = 0;
    final bad = DashboardApi((path) async {
      final raw = await recorded.get(path) as Map<String, dynamic>;
      if (historyCalls++ == 0) {
        raw['data']['metric'] = 'fees';
      }
      return raw;
    }, now: () => RecordedDashboard.now);
    await expectLater(
        bad.history('volume', DashboardRange.month), throwsFormatException);
    expect(
        (await bad.history('volume', DashboardRange.month)).data.total.metric,
        'volume');
    expect(historyCalls, 2);
  });

  test('optional market series must reconcile with authoritative volume', () {
    final raw = <String, dynamic>{
      'metric': 'volume',
      'interval': '1d',
      'from': '2026-10-01T00:00:00.000Z',
      'to': '2026-10-02T00:00:00.000Z',
      'points': [
        {'time': '2026-10-01T00:00:00.000Z', 'value': '3.000000'}
      ],
      'marketSeries': [
        {
          'marketId': 1,
          'symbol': 'BTC',
          'points': [
            {'time': '2026-10-01T00:00:00.000Z', 'value': '1.000000'}
          ]
        },
        {
          'marketId': 2,
          'symbol': 'ETH',
          'points': [
            {'time': '2026-10-01T00:00:00.000Z', 'value': '2.000000'}
          ]
        },
      ]
    };
    expect(DashboardHistory.fromJson(raw).markets, hasLength(2));
    (raw['marketSeries'] as List)[0]['points'][0]['value'] = '10.000000';
    expect(DashboardHistory.fromJson(raw).markets, isEmpty);
  });
}
