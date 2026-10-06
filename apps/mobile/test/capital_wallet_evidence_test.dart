import 'package:eyeler_mobile/features/capital/data/capital_repository.dart';
import 'package:eyeler_mobile/features/capital/domain/capital_snapshot.dart';
import 'package:eyeler_mobile/features/capital/presentation/capital_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets(
      'wallet evidence preserves exact AUSD and identifies the account and chain',
      (tester) async {
    const wallet = '0x0000000000000000000000000000000000000001';
    const token = '0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC';
    final snapshot = CapitalSnapshot.fromJson({
      'status': 'VALID',
      'walletAgoraAusd': {
        'amount': '9007199254.740993',
        'asset': 'AUSD',
        'availability': 'AVAILABLE',
        'freshness': 'FRESH',
        'onChain': {
          'wallet': wallet,
          'token': token,
          'chainId': 10143,
          'blockNumber': '123',
          'explorerUrl': 'https://testnet.monadexplorer.com/address/$wallet'
        },
      },
    });
    await tester.pumpWidget(ProviderScope(overrides: [
      capitalProvider.overrideWith((_) async => snapshot),
      agoraActivityProvider.overrideWith(
          (_) async => const AgoraActivity(status: 'UNAVAILABLE', rows: [])),
    ], child: const MaterialApp(home: CapitalScreen())));
    await tester.pumpAndSettle();
    expect(find.text('9007199254.740993 AUSD'), findsOneWidget);
    await tester.ensureVisible(find.text('Wallet and network details'));
    await tester.tap(find.text('Wallet and network details'));
    await tester.pumpAndSettle();
    expect(find.text('Monad testnet (10143)'), findsOneWidget);
    expect(find.text('Wallet: $wallet'), findsOneWidget);
    expect(find.text('Token: $token'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
