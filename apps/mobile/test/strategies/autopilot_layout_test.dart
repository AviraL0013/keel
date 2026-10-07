import 'package:eyeler_mobile/features/strategies/autopilot_screen.dart';
import 'package:eyeler_mobile/features/strategies/strategy_repository.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

class FakeStrategies implements StrategyRepository {
  final item = const StrategyEntry(
      id: 's1',
      mode: 'PAPER',
      kind: 'GRID',
      status: 'RUNNING',
      marketId: 16,
      accountId: 642,
      capital: 1000,
      state: {'inventory': 0.1, 'riskEvents': []});
  @override
  Future<List<StrategyEntry>> list() async => [item];
  @override
  Future<StrategySetup> setup() async => const StrategySetup(
      [StrategyAccount('connection', 642, 'testnet')],
      [StrategyMarket(16, 'BTC')]);
  @override
  Future<StrategyEntry> create(
          String connectionId, Map<String, dynamic> config) async =>
      item;
  @override
  Future<StrategyEntry> control(String id, String action) async => item;
  @override
  Future<Map<String, dynamic>> status(String id) async => {
        'mode': 'PAPER',
        'status': 'RUNNING',
        'state': {'riskEvents': [], 'inventory': 0.1}
      };
  @override
  Future<Map<String, dynamic>> pnl(String id) async => {
        'pnl': 1.2,
        'equity': 1001.2,
        'inventory': 0.1,
        'feesPaid': 0.2,
        'fundingPaid': 0.1
      };
  @override
  Future<List<Map<String, dynamic>>> orders(String id) async => [
        {
          'kind': 'POST',
          'side': 'BUY',
          'status': 'OPEN',
          'size': '0.1',
          'price': '99',
          'simulated': true
        }
      ];
  @override
  Future<List<Map<String, dynamic>>> fills(String id) async => [
        {'side': 'SELL', 'size': '0.1', 'price': '101', 'simulated': true}
      ];
  @override
  Future<List<Map<String, dynamic>>> riskEvents(String id) async => [];
  @override
  Future<bool> killed() async => false;
  @override
  Future<void> kill() async {}
  @override
  Future<void> resetKill() async {}
}

void main() {
  for (final width in [320.0, 360.0, 412.0]) {
    for (final screen in ['list', 'setup', 'dashboard']) {
      testWidgets('$screen fits $width dp', (tester) async {
        tester.view.physicalSize = Size(width, 800);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final repo = FakeStrategies();
        await tester.pumpWidget(ProviderScope(
          overrides: [strategyRepositoryProvider.overrideWithValue(repo)],
          child: MaterialApp(
              home: switch (screen) {
            'list' => const AutopilotScreen(),
            'setup' => const StrategySetupScreen(),
            _ => const StrategyDashboardScreen(id: 's1'),
          }),
        ));
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull);
        expect(find.byType(Scaffold), findsOneWidget);
        if (screen == 'list') expect(find.text('Autopilot'), findsOneWidget);
        if (screen == 'setup') expect(find.text('Step 1 of 3'), findsOneWidget);
        if (screen == 'dashboard') {
          expect(find.text('Simulation only. No on-chain orders or fills.'),
              findsOneWidget);
        }
      });
    }
  }
}
