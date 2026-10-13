import 'package:eyeler_mobile/features/analytics/analytics_contract.dart';
import 'package:eyeler_mobile/features/analytics/dashboard_wallet.dart';
import 'package:eyeler_mobile/features/analytics/dashboard_wallet_insights.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

final _openedAt = DateTime.utc(2026, 10, 1);

V1Position position(
  String id,
  String side,
  String? notional, {
  String? mark = '1',
  String symbol = 'BTC',
  int marketId = 1,
}) =>
    V1Position(
      id,
      marketId,
      symbol,
      side,
      '1',
      notional,
      '1',
      mark,
      '1',
      '1',
      null,
      null,
      _openedAt,
    );

V1WalletProfile profile(List<V1Position> positions, {String? equity = '1'}) =>
    V1WalletProfile(
      '0x0000000000000000000000000000000000000001',
      const ['1'],
      V1Margin(null, null, null, equity),
      positions,
    );

DashboardWalletActivity activity(int? active, int verified) =>
    DashboardWalletActivity(
      '0x0000000000000000000000000000000000000001',
      active,
      verified,
      const [],
      null,
    );

void main() {
  test('direction and concentration use exact decimals beyond 2^53', () {
    final result = calculatePositionInsights(
      profile([
        position('a', 'long', '9007199254740993.000001'),
        position(
          'b',
          'short',
          '9007199254740993.000001',
          symbol: 'ETH',
          marketId: 2,
        ),
      ]),
      activity(4, 30),
    );
    expect(result.longShare, '50.0%');
    expect(result.shortShare, '50.0%');
    expect(result.largestShare, '50.0%');
    expect(result.largestMarket, 'BTC · market 1');
    expect(result.activeDays, 4);
  });

  test('long-only, short-only, and fractional shares', () {
    final long = calculatePositionInsights(
      profile([position('a', 'long', '1')]),
      activity(0, 30),
    );
    expect(long.longShare, '100.0%');
    expect(long.shortShare, '0.0%');
    final short = calculatePositionInsights(
      profile([position('a', 'short', '1')]),
      activity(0, 30),
    );
    expect(short.longShare, '0.0%');
    expect(short.shortShare, '100.0%');
    final split = calculatePositionInsights(
      profile([position('a', 'long', '1'), position('b', 'short', '2')]),
      activity(0, 30),
    );
    expect(split.longShare, '33.3%');
    expect(split.shortShare, '66.7%');
    expect(split.largestShare, '66.7%');
  });

  test('no percentage without complete enumeration and valid marks', () {
    expect(calculatePositionInsights(null, null).positionReason, isNotNull);
    expect(
      calculatePositionInsights(
        profile([position('a', 'long', '1')], equity: null),
        null,
      ).longShare,
      isNull,
    );
    for (final invalid in [
      position('a', 'long', null),
      position('a', 'long', '1', mark: null),
      position('a', 'long', '-1'),
      position('a', 'long', '1', mark: '0'),
    ]) {
      final result = calculatePositionInsights(profile([invalid]), null);
      expect(result.positionReason, isNotNull);
      expect(result.largestShare, isNull);
    }
    expect(
      calculatePositionInsights(profile([]), null).positionReason,
      'No current open positions.',
    );
    expect(
      calculatePositionInsights(
        profile([position('a', 'long', '0')]),
        null,
      ).positionReason,
      'Marked gross notional is zero.',
    );
  });

  test('activity counts verified days only and rejects impossible counts', () {
    final partial = calculatePositionInsights(profile([]), activity(3, 8));
    expect(partial.activeDays, 3);
    expect(partial.verifiedDays, 8);
    expect(partial.activityReason, isNull);
    expect(
      calculatePositionInsights(profile([]), activity(9, 8)).activeDays,
      isNull,
    );
    expect(
      calculatePositionInsights(profile([]), activity(null, 8)).activeDays,
      isNull,
    );
    const wrongWallet = DashboardWalletActivity(
      '0x0000000000000000000000000000000000000002',
      3,
      8,
      [],
      null,
    );
    expect(
        calculatePositionInsights(profile([]), wrongWallet).activeDays, isNull);
  });

  testWidgets('missing marks show one reason and no position percentage',
      (tester) async {
    await tester.pumpWidget(MaterialApp(
        home: Scaffold(
            body: PositionInsightsPanel(
                profile: profile([position('a', 'long', null)]),
                activity: activity(0, 30)))));
    expect(find.text('Position marks are unavailable.'), findsOneWidget);
    expect(find.text('Directional exposure'), findsNothing);
    expect(find.text('Largest position'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  for (final width in [360.0, 1280.0]) {
    testWidgets('panel fits $width px and labels partial coverage', (
      tester,
    ) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = Size(width, 900);
      addTearDown(tester.view.resetDevicePixelRatio);
      addTearDown(tester.view.resetPhysicalSize);
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SingleChildScrollView(
              child: SizedBox(
                width: width,
                child: PositionInsightsPanel(
                  profile: profile([
                    position('a', 'long', '2'),
                    position('b', 'short', '1'),
                  ]),
                  activity: activity(3, 8),
                ),
              ),
            ),
          ),
        ),
      );
      expect(find.text('Position insights'), findsOneWidget);
      expect(find.text('66.7% long · 33.3% short'), findsOneWidget);
      expect(find.text('3/8 active days'), findsOneWidget);
      expect(find.text('8/30 verified days'), findsOneWidget);
      expect(
        find.text('Accounts currently linked to this wallet.'),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
    });
  }
}
