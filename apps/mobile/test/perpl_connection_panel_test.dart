import 'package:eyeler_mobile/features/positions/presentation/perpl_connection_panel.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  for (final state in ['NONE', 'ACTIVE', 'PENDING', 'ENROLLING', 'ERROR']) {
    testWidgets(
        'Perpl $state exposes only applicable enrollment controls at phone width',
        (tester) async {
      await tester.binding.setSurfaceSize(const Size(360, 800));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(ProviderScope(
          overrides: [
            enrollmentProvider.overrideWith((_) async => {
                  'status': 'AVAILABLE',
                  'environment': 'mainnet',
                  'builderId': 25,
                  'connections': <Map<String, dynamic>>[
                    if (state != 'NONE')
                      {
                        'id': 'fixture',
                        'environment': 'mainnet',
                        'status': state
                      },
                  ],
                }),
          ],
          child: const MaterialApp(
              home: Scaffold(
                  body:
                      SingleChildScrollView(child: PerplConnectionPanel())))));
      await tester.pumpAndSettle();
      expect(find.textContaining('MAINNET'), findsOneWidget);
      expect(find.text('CONNECT MY PERPL ACCOUNT'),
          state == 'NONE' ? findsOneWidget : findsNothing);
      expect(
          find.text('DISCONNECT ACCESS'),
          !['NONE', 'ENROLLING'].contains(state)
              ? findsOneWidget
              : findsNothing);
      expect(tester.takeException(), isNull);
    });
  }
  testWidgets('operator mode does not offer personal enrollment',
      (tester) async {
    await tester.pumpWidget(ProviderScope(overrides: [
      enrollmentProvider.overrideWith((_) async =>
          {'status': 'UNAVAILABLE', 'reason': 'OPERATOR_ACCOUNT_MODE'}),
    ], child: const MaterialApp(home: Scaffold(body: PerplConnectionPanel()))));
    await tester.pumpAndSettle();
    expect(find.textContaining('restricted operator account'), findsOneWidget);
    expect(find.text('CONNECT MY PERPL ACCOUNT'), findsNothing);
  });
}
