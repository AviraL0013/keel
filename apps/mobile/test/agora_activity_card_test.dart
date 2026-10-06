import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:eyeler_mobile/core/theme/app_theme.dart';
import 'package:eyeler_mobile/features/capital/data/capital_repository.dart';
import 'package:eyeler_mobile/features/capital/domain/capital_snapshot.dart';
import 'package:eyeler_mobile/features/capital/presentation/capital_screen.dart';

void main() {
  testWidgets(
      'Capital shows testnet USD, independent unavailable sources and reserve coverage',
      (tester) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(427, 2200);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.view.resetPhysicalSize);
    await tester.pumpWidget(ProviderScope(
        overrides: [
          capitalProvider.overrideWith((ref) async => CapitalSnapshot.fromJson({
                'status': 'VALID',
                'walletAusd': {
                  'amount': '2.000000',
                  'asset': 'USD',
                  'source': 'MONAD_COLLATERAL',
                  'availability': 'AVAILABLE',
                  'freshness': 'FRESH'
                },
                'perplAvailable': {
                  'amount': '1.500000',
                  'asset': 'USD',
                  'source': 'PERPL_COLLATERAL',
                  'availability': 'AVAILABLE',
                  'freshness': 'FRESH'
                },
                'perplLocked': {
                  'amount': null,
                  'asset': 'USD',
                  'source': 'PERPL_COLLATERAL',
                  'availability': 'UNAVAILABLE',
                  'reason': 'PERPL_BALANCE_READ_FAILED',
                  'freshness': 'UNKNOWN'
                },
                'bookRemaining': {
                  'amount': '1.600001',
                  'asset': 'USD',
                  'source': 'EYELER_LEDGER',
                  'availability': 'AVAILABLE',
                  'freshness': 'FRESH'
                },
                'reserveCoverage': {
                  'promised': '1.600001',
                  'perplFree': '1.500000',
                  'shortfall': '0.100001'
                },
                'bookAllocations': [
                  {
                    'bookId': 'book-1',
                    'market': 'ETH',
                    'available': '1.600001',
                    'reserved': '0.200000',
                    'deployed': '0.300000',
                    'updatedAt': '2026-10-02T00:00:00Z'
                  }
                ],
                'ausdMetrics': {
                  'status': 'AVAILABLE',
                  'scope': 'GLOBAL_AUSD',
                  'supply': '253317445.813025'
                },
              })),
          agoraActivityProvider.overrideWith((ref) async =>
              AgoraActivity.fromJson({
                'status': 'UNAVAILABLE',
                'reason': 'AGORA_NOT_CONNECTED',
                'rows': []
              })),
        ],
        child:
            MaterialApp(theme: EyelerTheme.dark, home: const CapitalScreen())));
    await tester.pumpAndSettle();
    expect(find.text('Wallet / USD'), findsOneWidget);
    expect(find.text('USD balance'), findsOneWidget);
    expect(find.textContaining('1.600001 USD'), findsWidgets);
    expect(find.textContaining('0.100001 USD'), findsOneWidget);
    expect(find.textContaining('Perpl balance unavailable'), findsOneWidget);
    expect(find.textContaining('ETH'), findsWidgets);
    expect(find.text('About AUSD'), findsOneWidget);
    expect(find.textContaining('253317445.813025 AUSD'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
      'optional public metrics outage is shown without changing Book balances',
      (tester) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(427, 1700);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.view.resetPhysicalSize);
    await tester.pumpWidget(ProviderScope(
        overrides: [
          capitalProvider.overrideWith((ref) async => CapitalSnapshot.fromJson({
                'bookRemaining': {
                  'amount': '2.000000',
                  'asset': 'USD',
                  'availability': 'AVAILABLE',
                  'freshness': 'FRESH'
                },
                'ausdMetrics': {
                  'status': 'UNAVAILABLE',
                  'reason': 'AGORA_METRICS_READ_FAILED'
                },
              })),
          agoraActivityProvider.overrideWith((ref) async =>
              AgoraActivity.fromJson({'status': 'UNAVAILABLE', 'rows': []})),
        ],
        child:
            MaterialApp(theme: EyelerTheme.dark, home: const CapitalScreen())));
    await tester.pumpAndSettle();
    expect(find.text('About AUSD'), findsOneWidget);
    expect(find.textContaining('AGORA_METRICS_READ_FAILED'), findsOneWidget);
    expect(find.textContaining('2.000000 USD'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
      'Agora activity stays separate from balances and labels matches as possible',
      (tester) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(427, 1800);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.view.resetPhysicalSize);
    await tester.pumpWidget(ProviderScope(
        overrides: [
          capitalProvider.overrideWith(
              (ref) async => CapitalSnapshot.fromJson({'status': 'VALID'})),
          agoraActivityProvider
              .overrideWith((ref) async => AgoraActivity.fromJson({
                    'status': 'AVAILABLE',
                    'nextCursor': 'more-records',
                    'rows': [
                      {
                        'type': 'mint',
                        'status': 'settled',
                        'source': 'Other bank account',
                        'destination': 'Your Monad wallet',
                        'asset': 'AUSD',
                        'amount': '12.000000',
                        'timestamp': '2026-09-27T00:01:00Z',
                        'match': 'POSSIBLE_MATCH',
                        'transactionHash':
                            '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                      }
                    ],
                  })),
        ],
        child:
            MaterialApp(theme: EyelerTheme.dark, home: const CapitalScreen())));
    await tester.pumpAndSettle();
    expect(find.text('Agora account activity'), findsOneWidget);
    expect(find.text('Transaction history. Not a balance or funds available.'),
        findsOneWidget);
    expect(find.text('Possible match with on-chain evidence'), findsOneWidget);
    expect(find.textContaining('12.000000 AUSD'), findsOneWidget);
    expect(find.text('Load more activity'), findsOneWidget);
    expect(find.textContaining('Transaction 0xaaaaaaaa'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
