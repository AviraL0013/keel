import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:eyeler_mobile/core/theme/app_theme.dart';
import 'package:eyeler_mobile/features/autopsy/data/autopsy_repository.dart';
import 'package:eyeler_mobile/features/autopsy/domain/autopsy_event.dart';
import 'package:eyeler_mobile/features/autopsy/presentation/autopsy_screen.dart';

void main() {
  testWidgets('shows an admission deadline without an execution explorer link',
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
    expect(find.text('Execution deadline: Block 101'), findsOneWidget);
    expect(find.textContaining('Explorer:'), findsNothing);
    expect(find.byTooltip('Copy explorer link'), findsNothing);
  });

  Future<void> showEvidence(WidgetTester tester, AutopsyEvent event) async {
    await tester.pumpWidget(ProviderScope(
      key: UniqueKey(),
      overrides: [
        autopsyProvider('book').overrideWith((ref) async => [event]),
      ],
      child: MaterialApp(
          theme: EyelerTheme.dark,
          home: const AutopsyScreen(
              bookId: 'book', explorerBaseUrl: 'https://explorer.example')),
    ));
    await tester.pump();
    await tester.tap(find.text('Technical details'));
    await tester.pumpAndSettle();
  }

  for (final kind in ['DEFEND', 'REDUCE', 'EXIT']) {
    testWidgets('$kind confirmation links its recorded execution block',
        (tester) async {
      await showEvidence(
          tester,
          AutopsyEvent(
            id: 'confirmed',
            type: '${kind}_CONFIRMED',
            timestamp: '2026-09-29T00:00:00Z',
            venueProgress: const {
              'admitted': true,
              'effectiveLastExecBlock': 101,
              'confirmedExecutionBlock': 99,
            },
          ));
      expect(find.text('Execution deadline: Block 101'), findsOneWidget);
      expect(find.text('Confirmed execution: Block 99'), findsOneWidget);
      expect(find.textContaining('https://explorer.example/block/99'),
          findsOneWidget);
      expect(find.byTooltip('Copy explorer link'), findsOneWidget);
    });

    for (final status in ['UNKNOWN', 'PARTIAL', 'FAILED']) {
      testWidgets('$kind $status cannot link a completed execution',
          (tester) async {
        await showEvidence(
            tester,
            AutopsyEvent(
              id: 'unresolved',
              type: '${kind}_$status',
              timestamp: '2026-09-29T00:00:00Z',
              transactionHash: '0x${'a' * 64}',
              venueProgress: const {
                'effectiveLastExecBlock': 101,
                'confirmedExecutionBlock': 99,
              },
            ));
        expect(find.text('Execution deadline: Block 101'), findsOneWidget);
        expect(find.textContaining('Confirmed execution:'), findsNothing);
        expect(find.textContaining('Explorer:'), findsNothing);
        expect(find.byTooltip('Copy explorer link'), findsNothing);
      });
    }
  }

  testWidgets('confirmed transaction takes precedence over execution block',
      (tester) async {
    final hash = '0x${'b' * 64}';
    await showEvidence(
        tester,
        AutopsyEvent(
          id: 'confirmed',
          type: 'DEFEND_CONFIRMED',
          timestamp: '2026-09-29T00:00:00Z',
          transactionHash: hash,
          venueProgress: const {'confirmedExecutionBlock': 99},
        ));
    expect(find.textContaining('https://explorer.example/tx/$hash'),
        findsOneWidget);
    expect(
        find.textContaining('https://explorer.example/block/99'), findsNothing);
  });

  testWidgets('exhausted automatic retries do not claim a reconciled action',
      (tester) async {
    await showEvidence(
        tester,
        const AutopsyEvent(
          id: 'exhausted',
          type: 'AUTOMATION_RETRY_EXHAUSTED',
          timestamp: '2026-09-29T00:00:00Z',
          action: 'REDUCE',
        ));
    expect(find.text('REDUCE action recorded.'), findsOneWidget);
    expect(find.textContaining('and reconciled'), findsNothing);
    expect(find.textContaining('Explorer:'), findsNothing);
  });

  for (final block in [0, -1, '99', 99.5]) {
    testWidgets('invalid execution block $block cannot create an explorer link',
        (tester) async {
      await showEvidence(
          tester,
          AutopsyEvent(
            id: 'confirmed',
            type: 'EXIT_CONFIRMED',
            timestamp: '2026-09-29T00:00:00Z',
            venueProgress: {'confirmedExecutionBlock': block},
          ));
      expect(find.textContaining('Confirmed execution:'), findsNothing);
      expect(find.textContaining('Explorer:'), findsNothing);
    });
  }

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
