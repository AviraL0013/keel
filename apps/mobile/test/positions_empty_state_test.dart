import 'package:eyeler_mobile/features/positions/data/positions_repository.dart';
import 'package:eyeler_mobile/features/positions/presentation/positions_screen.dart';
import 'package:eyeler_mobile/core/errors/eyeler_exception.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('unconnected account does not claim the server is down',
      (tester) async {
    await tester.pumpWidget(ProviderScope(overrides: [
      positionsProvider.overrideWith(
          (ref) async => throw const EyelerException('PERPL_NOT_CONNECTED')),
      perplConnectionProvider.overrideWith(
          (ref) async => const PerplConnectionState(status: 'NOT_CONNECTED')),
    ], child: const MaterialApp(home: PositionsScreen())));
    await tester.pumpAndSettle();
    expect(find.text('PERPL ACCOUNT NOT CONNECTED'), findsOneWidget);
    expect(find.text('EYELER SERVER UNAVAILABLE'), findsNothing);
    expect(find.text('CONTINUE ACCOUNT SETUP'), findsOneWidget);
  });

  testWidgets(
      'connected testnet account with no positions has clear empty state',
      (tester) async {
    await tester.pumpWidget(ProviderScope(overrides: [
      positionsProvider.overrideWith((ref) async => const []),
      perplConnectionProvider.overrideWith((ref) async =>
          const PerplConnectionState(
              status: 'VALID', environment: 'testnet', accountId: 642)),
    ], child: const MaterialApp(home: PositionsScreen())));
    await tester.pump();
    expect(find.text('TESTNET / ACCOUNT 642'), findsOneWidget);
    expect(
        find.text('No open positions on this Perpl account.'), findsOneWidget);
    expect(find.text('Connect a Perpl account to discover positions.'),
        findsNothing);
    // A VALID connection alone does not establish forwarding/fresh collateral.
    expect(find.text('Continue account setup'), findsOneWidget);
  });
}
