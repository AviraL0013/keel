import 'package:eyeler_mobile/features/analytics/dashboard_wallet_stress.dart';
import 'package:eyeler_mobile/features/analytics/dashboard_wallet_tools_data.dart';
import 'package:eyeler_mobile/features/analytics/dashboard_data.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'wallet_tools_fixture.dart';

void main() {
  test(
      'linear shocks use exact size and mark, offset sides, leave other markets',
      () {
    final snapshot = walletSnapshot(1, [
      walletPosition('a', 'long', '2', '10', '20'),
      walletPosition('b', 'short', '1', '10.0', '10'),
      walletPosition('c', 'long', '100', '10', '1000', marketId: 2),
    ]);
    final down = calculateWalletStress(snapshot, 1, -500);
    expect(down.reason, isNull);
    expect(down.total.toString(), '-0.50000');
    expect(down.longChange.toString(), '-1.0000');
    expect(down.shortChange.toString(), '0.50000');
    expect(down.currentMark.toString(), '10');
    expect(down.scenarioMark.toString(), '9.5000');
    expect(down.contributions, hasLength(2));
    expect(
        calculateWalletStress(snapshot, 1, 500).total!.units.isNegative, false);
    expect(signedMoney(calculateWalletStress(snapshot, 1, 0).total!), r'$0');
  });

  test('market IDs stay separate and large amounts retain exact units', () {
    final snapshot = walletSnapshot(1, [
      walletPosition('a', 'long', '9007199254740993.000001', '1',
          '9007199254740993.000001'),
      walletPosition('b', 'short', '1', '1', '1', marketId: 2, symbol: 'BTC'),
    ]);
    expect(largestWalletMarket(snapshot), 1);
    expect(calculateWalletStress(snapshot, 1, 25).total.toString(),
        '22517998136852.4825000025');
    expect(calculateWalletStress(snapshot, 2, 25).total.toString(), '-0.0025');
  });

  test('nonzero amounts below one cent retain magnitude and sign', () {
    for (final amount in ['0.0025', '0.000000000000000001', '0.009999']) {
      final positive = AnalyticsDecimal.parse(amount);
      expect(analyticsMoney(positive), r'<$0.01');
      expect(signedMoney(positive), r'+<$0.01');
      expect(analyticsMoney(positive.negative), r'-<$0.01');
      expect(signedMoney(positive.negative), r'-<$0.01');
    }
    expect(signedMoney(AnalyticsDecimal.parse('0')), r'$0');
    expect(signedMoney(AnalyticsDecimal.parse('0.01')), r'+$0.01');
    expect(signedMoney(AnalyticsDecimal.parse('-0.01')), r'-$0.01');
  });

  test('contributions aggregate exactly before display rounding', () {
    final snapshot = walletSnapshot(1, [
      walletPosition('a', 'long', '1', '1', '1'),
      walletPosition('b', 'long', '1', '1', '1'),
      walletPosition('c', 'long', '1', '1', '1'),
      walletPosition('d', 'long', '1', '1', '1'),
    ]);
    final result = calculateWalletStress(snapshot, 1, 25);
    expect(result.total!.compareTo(AnalyticsDecimal.parse('0.01')), 0);
    expect(signedMoney(result.total!), r'+$0.01');
    expect(result.contributions.map((c) => signedMoney(c.change)),
        everyElement(r'+<$0.01'));
  });

  test('missing evidence and invalid shocks show reasons', () {
    final good = walletPosition('a', 'long', '1', '10', '10');
    for (final snapshot in [
      walletSnapshot(1, [good], equity: null),
      walletSnapshot(1, [good], stale: true),
      walletSnapshot(1, [good, good]),
      walletSnapshot(1, [walletPosition('a', 'long', '1', null, null)]),
      walletSnapshot(1, [walletPosition('a', 'long', '-1', '10', '10')]),
      walletSnapshot(1, [walletPosition('a', 'long', '1', '0', '0')]),
    ]) {
      expect(calculateWalletStress(snapshot, 1, 500).reason, isNotNull);
    }
    expect(calculateWalletStress(walletSnapshot(1, []), null, 0).reason,
        'No current open positions.');
    expect(calculateWalletStress(walletSnapshot(1, [good]), 1, 1001).reason,
        isNotNull);
    expect(calculateWalletStress(walletSnapshot(1, [good]), 2, 0).reason,
        isNotNull);
    expect(
        calculateWalletStress(
                walletSnapshot(
                    1, [good, walletPosition('b', 'short', '1', '11', '11')]),
                1,
                0)
            .reason,
        'Current market marks disagree.');
  });

  testWidgets('selected market resets when refreshed snapshot removes it',
      (tester) async {
    final first = walletSnapshot(1, [
      walletPosition('a', 'long', '2', '10', '20'),
      walletPosition('b', 'short', '1', '5', '5', marketId: 2),
    ]);
    final second = walletSnapshot(2, [
      walletPosition('a', 'long', '2', '10', '20'),
    ]);
    Widget mount(snapshot) => MaterialApp(
        home: Scaffold(
            body: WalletStressPanel(
                key: const ValueKey('panel'), snapshot: snapshot)));
    await tester.pumpWidget(mount(first));
    await tester.tap(find.byType(DropdownButtonFormField<int>));
    await tester.pumpAndSettle();
    await tester.tap(find.text('BTC · market 2').last);
    await tester.pumpAndSettle();
    await tester.tap(find.text('-5%'));
    await tester.pump();
    await tester.pumpWidget(mount(second));
    await tester.pump();
    expect(find.text('Only BTC · market 1 moves; other markets unchanged.'),
        findsOneWidget);
    expect(find.text('Price move: 0%'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('default market removal resets shock on refreshed snapshot',
      (tester) async {
    final first = walletSnapshot(1, [
      walletPosition('a', 'long', '2', '10', '20'),
      walletPosition('b', 'short', '1', '5', '5', marketId: 2),
    ]);
    final second = walletSnapshot(2, [
      walletPosition('b', 'short', '1', '5', '5', marketId: 2),
    ]);
    Widget mount(snapshot) => MaterialApp(
        home: Scaffold(
            body: WalletStressPanel(
                key: const ValueKey('panel'), snapshot: snapshot)));
    await tester.pumpWidget(mount(first));
    await tester.tap(find.text('+5%'));
    await tester.pump();
    expect(find.text('Price move: +5%'), findsOneWidget);
    await tester.pumpWidget(mount(second));
    await tester.pump();
    expect(find.text('Only BTC · market 2 moves; other markets unchanged.'),
        findsOneWidget);
    expect(find.text('Price move: 0%'), findsOneWidget);
    expect(tester.widget<Text>(find.byKey(const ValueKey('stress_total'))).data,
        r'$0');
    expect(tester.takeException(), isNull);
  });

  testWidgets('default selection and shock survive market ranking change',
      (tester) async {
    final first = walletSnapshot(1, [
      walletPosition('a', 'long', '2', '10', '20'),
      walletPosition('b', 'short', '1', '5', '5', marketId: 2),
    ]);
    final second = walletSnapshot(2, [
      walletPosition('a', 'long', '2', '10', '20'),
      walletPosition('b', 'short', '100', '5', '500', marketId: 2),
    ]);
    Widget mount(snapshot) => MaterialApp(
        home: Scaffold(
            body: WalletStressPanel(
                key: const ValueKey('panel'), snapshot: snapshot)));
    await tester.pumpWidget(mount(first));
    await tester.tap(find.text('+5%'));
    await tester.pump();
    await tester.pumpWidget(mount(second));
    await tester.pump();
    expect(find.text('Only BTC · market 1 moves; other markets unchanged.'),
        findsOneWidget);
    expect(find.text('Price move: +5%'), findsOneWidget);
    expect(tester.widget<Text>(find.byKey(const ValueKey('stress_total'))).data,
        r'+$1.00');
    expect(tester.takeException(), isNull);
  });

  testWidgets('large exact values remain compact at 360 px', (tester) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(360, 900);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(MaterialApp(
        home: Scaffold(
            body: WalletStressPanel(
                snapshot: walletSnapshot(1, [
      walletPosition('a', 'long', '9007199254740993.000001', '1',
          '9007199254740993.000001'),
    ])))));
    await tester.tap(find.text('+5%'));
    await tester.pump();
    final total =
        tester.widget<Text>(find.byKey(const ValueKey('stress_total')));
    expect(total.data, contains('B'));
    expect(tester.takeException(), isNull);
  });

  for (final width in [360.0, 1280.0]) {
    testWidgets('stress card fits $width and presets recalculate',
        (tester) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = Size(width, 900);
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await tester.pumpWidget(MaterialApp(
          home: Scaffold(
              body: SingleChildScrollView(
                  child: SizedBox(
                      width: width,
                      child: WalletStressPanel(
                          snapshot: walletSnapshot(1, [
                        walletPosition('a', 'long', '2', '10', '20'),
                      ])))))));
      expect(find.text('Stress my wallet'), findsOneWidget);
      expect(find.text(r'$0'), findsWidgets);
      final controls =
          tester.getRect(find.byKey(const ValueKey('stress_controls')));
      final results =
          tester.getRect(find.byKey(const ValueKey('stress_results')));
      if (width == 1280) {
        expect(controls.top, results.top);
        expect(controls.right, lessThan(results.left));
      } else {
        expect(controls.bottom, lessThan(results.top));
        expect(controls.left, results.left);
      }
      await tester.tap(find.text('-5%'));
      await tester.pump();
      expect(find.text('-\$1.00'), findsWidgets);
      expect(tester.takeException(), isNull);
    });
  }
}
