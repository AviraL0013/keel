import 'package:eyeler_mobile/core/theme/app_theme.dart';
import 'package:eyeler_mobile/features/analytics/analytics_repository.dart';
import 'package:eyeler_mobile/features/books/data/books_repository.dart';
import 'package:eyeler_mobile/features/books/presentation/screens/app_shell.dart';
import 'package:eyeler_mobile/features/positions/data/positions_repository.dart';
import 'package:eyeler_mobile/features/strategies/strategy_repository.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../strategies/autopilot_layout_test.dart' show FakeStrategies;

void main() {
  for (final width in [320.0, 360.0, 412.0, 1280.0]) {
    testWidgets(
        'Analytics and Autopilot remain reachable at ${width.toInt()}dp',
        (tester) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = Size(width, 860);
      addTearDown(tester.view.resetDevicePixelRatio);
      addTearDown(tester.view.resetPhysicalSize);
      await tester.pumpWidget(ProviderScope(overrides: [
        booksProvider.overrideWith((ref) async => []),
        positionsProvider.overrideWith((ref) async => []),
        perplConnectionProvider.overrideWith((ref) async =>
            const PerplConnectionState(status: 'VALID', accountId: 642)),
        analyticsRepositoryProvider
            .overrideWithValue(FixtureAnalyticsRepository.sample()),
        strategyRepositoryProvider.overrideWithValue(FakeStrategies()),
      ], child: MaterialApp(theme: EyelerTheme.dark, home: const AppShell())));
      await tester.pumpAndSettle();
      expect(tester.getSize(find.byType(NavigationDestination).at(3)).width,
          greaterThanOrEqualTo(48));
      await tester.tap(find.text('Analytics').last);
      await tester.pumpAndSettle();
      expect(find.text('Protocol overview'), findsOneWidget);
      await tester.tap(find.text('Autopilot').last);
      await tester.pumpAndSettle();
      expect(
          find.text(
              'Paper strategies use live Perpl data. Orders and fills are simulated.'),
          findsOneWidget);
      await tester.tap(find.text('Analytics').last);
      await tester.pumpAndSettle();
      expect(find.text('Protocol overview'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  }
}
