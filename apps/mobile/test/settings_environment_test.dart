import 'package:eyeler_mobile/core/networking/backend_status.dart';
import 'package:eyeler_mobile/features/capital/data/capital_repository.dart';
import 'package:eyeler_mobile/features/capital/domain/capital_snapshot.dart';
import 'package:eyeler_mobile/features/settings/presentation/settings_screen.dart';
import 'package:eyeler_mobile/features/settings/presentation/telegram_panel.dart';
import 'package:eyeler_mobile/features/positions/presentation/perpl_connection_panel.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('Settings never labels a mainnet backend as testnet',
      (tester) async {
    await tester.pumpWidget(ProviderScope(overrides: [
      backendStatusProvider.overrideWith((_) async =>
          const BackendStatus(BackendState.live, environment: 'mainnet')),
      capitalProvider.overrideWith((_) async => CapitalSnapshot.fromJson({})),
      telegramStatusProvider
          .overrideWith((_) async => {'status': 'UNAVAILABLE'}),
      enrollmentProvider.overrideWith((_) async => {'status': 'UNAVAILABLE'}),
    ], child: const MaterialApp(home: SettingsScreen())));
    await tester.pumpAndSettle();
    expect(find.text('LIVE MAINNET'), findsOneWidget);
    expect(find.text('LIVE TESTNET'), findsNothing);
  });
}
