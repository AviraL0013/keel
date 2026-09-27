import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:keel_mobile/core/theme/app_theme.dart';
import 'package:keel_mobile/features/capital/data/capital_repository.dart';
import 'package:keel_mobile/features/capital/domain/capital_snapshot.dart';
import 'package:keel_mobile/features/capital/presentation/capital_screen.dart';

void main() {
  testWidgets(
      'Agora activity stays separate from balances and labels matches as possible',
      (tester) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(427, 1800);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.view.resetPhysicalSize);
    await tester.pumpWidget(ProviderScope(overrides: [
      capitalProvider.overrideWith(
          (ref) async => CapitalSnapshot.fromJson({'status': 'VALID'})),
      agoraActivityProvider.overrideWith((ref) async => AgoraActivity.fromJson({
            'status': 'AVAILABLE',
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
              }
            ],
          })),
    ], child: MaterialApp(theme: KeelTheme.dark, home: const CapitalScreen())));
    await tester.pumpAndSettle();
    expect(find.text('Agora account activity'), findsOneWidget);
    expect(find.text('Transaction history. Not a balance or funds available.'),
        findsOneWidget);
    expect(find.text('Possible match with on-chain evidence'), findsOneWidget);
    expect(find.textContaining('12.000000 AUSD'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
