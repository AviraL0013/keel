import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:eyeler_mobile/core/networking/backend_status.dart';
import 'package:eyeler_mobile/core/theme/app_theme.dart';
import 'package:eyeler_mobile/features/auth/presentation/auth_screen.dart';

void main() {
  for (final width in [320.0, 360.0]) {
    testWidgets('mainnet allowlist demo label fits phone width $width',
        (tester) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = Size(width, 952);
      addTearDown(tester.view.resetDevicePixelRatio);
      addTearDown(tester.view.resetPhysicalSize);
      await tester.pumpWidget(ProviderScope(
        overrides: [
          backendStatusProvider.overrideWith((ref) async => const BackendStatus(
              BackendState.live,
              environment: 'mainnet',
              demoAllowlist: true)),
        ],
        child: MaterialApp(theme: EyelerTheme.dark, home: const AuthScreen()),
      ));
      await tester.pump();
      expect(find.text('Demo (allowlisted)'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  }
  for (final width in [320.0, 427.0]) {
    testWidgets('wallet sign-in fits phone width $width', (tester) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = Size(width, 952);
      addTearDown(tester.view.resetDevicePixelRatio);
      addTearDown(tester.view.resetPhysicalSize);

      await tester.pumpWidget(ProviderScope(
        overrides: [
          backendStatusProvider.overrideWith((ref) async => const BackendStatus(
              BackendState.live,
              environment: 'development')),
        ],
        child: MaterialApp(theme: EyelerTheme.dark, home: const AuthScreen()),
      ));
      await tester.pump();
      expect(tester.takeException(), isNull);
      expect(find.text('SIGN IN WITH PASSKEY'), findsOneWidget);
      expect(find.text('CREATE NEW MERA WALLET'), findsOneWidget);
    });
  }
}
