import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:keel_mobile/core/theme/app_theme.dart';
import 'package:keel_mobile/features/autopsy/data/autopsy_repository.dart';
import 'package:keel_mobile/features/autopsy/domain/autopsy_event.dart';
import 'package:keel_mobile/features/autopsy/presentation/autopsy_screen.dart';

void main() {
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
          theme: KeelTheme.dark, home: const AutopsyScreen(bookId: 'book')),
    ));
    await tester.pump();
    expect(tester.takeException(), isNull);
    expect(find.text('Technical detail'), findsOneWidget);
  });
}
