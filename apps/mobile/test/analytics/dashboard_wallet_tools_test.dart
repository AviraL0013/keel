import 'dart:async';
import 'dart:convert';

import 'package:eyeler_mobile/features/analytics/dashboard_data.dart';
import 'package:eyeler_mobile/features/analytics/dashboard_wallet_tools.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'dashboard_fixture.dart';
import 'wallet_tools_fixture.dart';

void main() {
  for (final width in [360.0, 1280.0]) {
    testWidgets('tools mount and watch verified refresh at $width px',
        (tester) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = Size(width, 1200);
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      var now = DateTime.utc(2026, 10, 13, 12);
      var profileCalls = 0;
      final api = DashboardApi((path) async {
        if (path.endsWith('/activity')) {
          return {
            'asOf': now.toIso8601String(),
            'block': 1,
            'source': 'monad_exchange',
            'stale': false,
            'data': {
              'address': walletAddress,
              'scope': 'currently_linked_accounts',
              'activeDays': 1,
              'verifiedDays': 30,
              'points': [],
              'unavailableReason': null,
            }
          };
        }
        profileCalls++;
        return {
          'asOf': now.toIso8601String(),
          'block': profileCalls,
          'source': 'monad_exchange',
          'stale': false,
          'data': {
            'address': walletAddress,
            'accountIds': ['1'],
            'margin': {
              'balance': '100',
              'locked': '0',
              'free': '100',
              'equity': '100'
            },
            'positions': profileCalls == 1
                ? []
                : [
                    {
                      'id': '1:1',
                      'marketId': 1,
                      'symbol': 'BTC',
                      'side': 'long',
                      'size': '1',
                      'notional': '10',
                      'entryPrice': '10',
                      'markPrice': '10',
                      'leverage': '1',
                      'collateral': '1',
                      'unrealizedPnl': '0',
                      'liquidationPrice': null,
                      'openedAt': '2026-10-01T00:00:00.000Z',
                    }
                  ],
          }
        };
      }, now: () => now);
      await tester.pumpWidget(ProviderScope(
        overrides: [dashboardApiProvider.overrideWithValue(api)],
        child: MaterialApp(
            home: Scaffold(
                body: SingleChildScrollView(
          child: SizedBox(
              width: width,
              child: const DashboardWalletTools(address: walletAddress)),
        ))),
      ));
      await tester.pumpAndSettle();
      expect(find.text('Position insights'), findsOneWidget);
      expect(find.text('Stress my wallet'), findsOneWidget);
      expect(find.text('Live wallet watch'), findsOneWidget);
      expect(profileCalls, 1);
      final start = find.text('Start live watch');
      await tester.ensureVisible(start);
      await tester.tap(start);
      await tester.pump();
      now = now.add(const Duration(seconds: 31));
      await tester.pump(const Duration(seconds: 31));
      await tester.pumpAndSettle();
      expect(profileCalls, 2);
      expect(find.text('Newly observed position'), findsOneWidget);
      await tester.ensureVisible(find.text('Pause watch'));
      await tester.tap(find.text('Pause watch'));
      await tester.pump();
      now = now.add(const Duration(seconds: 31));
      await tester.pump(const Duration(seconds: 31));
      expect(profileCalls, 2);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    });
  }

  testWidgets('pause and resume during in-flight refresh restarts polling',
      (tester) async {
    final address = RecordedDashboard.wallet;
    final path = '/analytics/v1/wallets/$address';
    final base = await RecordedDashboard().get(path) as Map<String, dynamic>;
    var now = DateTime.utc(2026, 10, 13, 12);
    var calls = 0;
    final pending = Completer<Object?>();
    Map<String, dynamic> nextBody(int block) {
      final result = jsonDecode(jsonEncode(base)) as Map<String, dynamic>;
      result['block'] = block;
      return result;
    }

    final api = DashboardApi((request) async {
      if (request.endsWith('/activity')) {
        throw StateError('No activity fixture');
      }
      calls++;
      if (calls == 2) return pending.future;
      return nextBody((base['block'] as int) + calls - 1);
    }, now: () => now);
    await tester.pumpWidget(ProviderScope(
      overrides: [dashboardApiProvider.overrideWithValue(api)],
      child: MaterialApp(
          home: Scaffold(
              body: SingleChildScrollView(
                  child: DashboardWalletTools(address: address)))),
    ));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('Start live watch'));
    await tester.tap(find.text('Start live watch'));
    await tester.pump();
    now = now.add(const Duration(seconds: 31));
    await tester.pump(const Duration(seconds: 31));
    await tester.pump();
    expect(calls, 2);
    await tester.tap(find.text('Pause watch'));
    await tester.pump();
    await tester.tap(find.text('Resume watch'));
    await tester.pump();
    pending.complete(nextBody((base['block'] as int) + 1));
    await tester.pumpAndSettle();
    now = now.add(const Duration(seconds: 31));
    await tester.pump(const Duration(seconds: 31));
    await tester.pumpAndSettle();
    expect(calls, 3);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });
}
