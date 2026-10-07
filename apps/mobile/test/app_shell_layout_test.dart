import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:eyeler_mobile/core/theme/app_theme.dart';
import 'package:eyeler_mobile/features/books/data/books_repository.dart';
import 'package:eyeler_mobile/features/books/presentation/screens/app_shell.dart';
import 'package:eyeler_mobile/features/books/presentation/screens/books_screen.dart';
import 'package:eyeler_mobile/features/positions/data/positions_repository.dart';
import 'package:eyeler_mobile/features/onboarding/data/onboarding_repository.dart';
import 'package:eyeler_mobile/features/onboarding/domain/onboarding_progress.dart';
import 'package:eyeler_mobile/features/capital/domain/capital_snapshot.dart';

void main() {
  for (final size in [const Size(427, 952), const Size(1440, 900)]) {
    testWidgets('shell preserves body and tab hit targets at $size',
        (tester) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = size;
      addTearDown(tester.view.resetDevicePixelRatio);
      addTearDown(tester.view.resetPhysicalSize);
      await tester.pumpWidget(ProviderScope(
        overrides: [
          onboardingProvider.overrideWith((ref) async {
            final snapshot = CapitalSnapshot.fromJson({'perplAvailable': '20'});
            return OnboardingProgress(
                step: OnboardingStep.complete,
                environment: 'testnet',
                walletBalance: snapshot.walletAgoraAusd,
                collateral: snapshot.perplAvailable,
                canOpenTrade: true,
                accountId: 642);
          }),
          booksProvider.overrideWith((ref) async => []),
          positionsProvider.overrideWith((ref) async => []),
          perplConnectionProvider.overrideWith((ref) async =>
              const PerplConnectionState(status: 'VALID', accountId: 642)),
        ],
        child: MaterialApp(theme: EyelerTheme.dark, home: const AppShell()),
      ));
      await tester.pumpAndSettle();

      // A bottom-bar wrapper must not consume the body viewport.
      expect(tester.getSize(find.byType(BooksScreen)).height,
          greaterThan(size.height / 2));
      final nav = tester.getRect(find.byType(NavigationBar));
      expect(nav.bottom, closeTo(size.height, 1));
      expect(nav.height, lessThan(120));
      expect(find.text('VIEW POSITIONS').hitTestable(), findsOneWidget);

      await tester.tap(find.text('Positions'));
      await tester.pumpAndSettle();
      expect(
          tester
              .widget<NavigationBar>(find.byType(NavigationBar))
              .selectedIndex,
          1);
      expect(find.text('NO ACTIVE POSITIONS').hitTestable(), findsOneWidget);
      await tester.tap(find.text('Home'));
      await tester.pumpAndSettle();
      expect(find.text('VIEW POSITIONS').hitTestable(), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  }
}
