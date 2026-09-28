import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:eyeler_mobile/core/theme/app_theme.dart';
import 'package:eyeler_mobile/features/autopsy/data/autopsy_repository.dart';
import 'package:eyeler_mobile/features/autopsy/domain/autopsy_event.dart';
import 'package:eyeler_mobile/features/autopsy/presentation/autopsy_screen.dart';

void main() {
  testWidgets('shows admitted venue evidence and a copyable explorer link',
      (tester) async {
    await tester.pumpWidget(ProviderScope(
      overrides: [
        autopsyProvider('book').overrideWith((ref) async => const [
              AutopsyEvent(
                id: 'event',
                type: 'DEFEND_CONFIRMED',
                timestamp: '2026-09-29T00:00:00Z',
                venueProgress: {
                  'requestId': '1791001362433',
                  'admitted': true,
                  'response': 'ORDER_UPDATE',
                  'effectiveLastExecBlock': 101,
                },
              ),
            ]),
      ],
      child: MaterialApp(
          theme: EyelerTheme.dark,
          home: const AutopsyScreen(
              bookId: 'book', explorerBaseUrl: 'https://explorer.example')),
    ));
    await tester.pump();
    await tester.tap(find.text('Technical details'));
    await tester.pumpAndSettle();
    expect(find.textContaining('Perpl admitted'), findsOneWidget);
    expect(find.textContaining('Block 101'), findsOneWidget);
    expect(find.textContaining('https://explorer.example/block/101'),
        findsOneWidget);
  });

  testWidgets('long event status fits narrow phone', (tester) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(320, 952);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.view.resetPhysicalSize);

    await tester.pumpWidget(ProviderScope(
      overrides: [
        autopsyProvider('book').overrideWith((ref) async => const [
              AutopsyEvent(
                id: '1',
                type: 'DEFENSE_EFFICIENCY_UPDATED',
                timestamp: '2026-09-28T00:00:00Z',
              ),
            ]),
      ],
      child: MaterialApp(
          theme: EyelerTheme.dark, home: const AutopsyScreen(bookId: 'book')),
    ));
    await tester.pump();
    expect(tester.takeException(), isNull);
    expect(find.text('Technical details'), findsOneWidget);
  });
}
