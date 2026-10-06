import 'package:eyeler_mobile/features/settings/presentation/telegram_panel.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  for (final state in ['LINKED', 'NOT_LINKED', 'UNAVAILABLE']) {
    testWidgets('Telegram panel $state shows only applicable controls',
        (tester) async {
      await tester.pumpWidget(ProviderScope(overrides: [
        telegramStatusProvider.overrideWith((_) async => {'status': state})
      ], child: const MaterialApp(home: Scaffold(body: TelegramPanel()))));
      await tester.pumpAndSettle();
      expect(find.text('CONNECT TELEGRAM'),
          state == 'NOT_LINKED' ? findsOneWidget : findsNothing);
      expect(find.text('DISCONNECT TELEGRAM'),
          state == 'LINKED' ? findsOneWidget : findsNothing);
      if (state == 'UNAVAILABLE') {
        expect(find.textContaining('bot is not configured'), findsOneWidget);
      }
      expect(tester.takeException(), isNull);
    });
  }
}
