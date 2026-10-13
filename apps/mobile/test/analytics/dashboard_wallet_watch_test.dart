import 'package:eyeler_mobile/features/analytics/dashboard_wallet_watch.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'wallet_tools_fixture.dart';

void main() {
  test('watch compares verified position size, side, additions and removals',
      () {
    final session = WalletWatchSession(walletAddress);
    session.start(walletSnapshot(1, [
      walletPosition(
          'a', 'long', '9007199254740993.0', '1', '9007199254740993'),
      walletPosition('b', 'short', '1', '2', '2'),
    ]));
    session.accept(walletSnapshot(2, [
      walletPosition(
          'a', 'short', '9007199254740993.00', '2', '18014398509481986'),
      walletPosition('c', 'long', '1', '3', '3'),
    ]));
    expect(
        session.events.map((e) => e.label),
        containsAll([
          'Observed side changed',
          'Newly observed position',
          'Position no longer observed',
        ]));
    expect(session.events.any((e) => e.label.contains('size')), false);
    session.accept(walletSnapshot(3, [
      walletPosition(
          'a', 'short', '9007199254740994', '2', '18014398509481988'),
      walletPosition('c', 'long', '1', '3', '3'),
    ]));
    expect(session.events.first.label, 'Observed size increased');
    expect(session.events.first.detail, contains('9007199254740993.00 to'));
  });

  test('mark-only updates do not claim position changes', () {
    final session = WalletWatchSession(walletAddress)
      ..start(walletSnapshot(1, [walletPosition('a', 'long', '1', '10', '10')]))
      ..accept(
          walletSnapshot(2, [walletPosition('a', 'long', '1.00', '11', '11')]));
    expect(session.events, isEmpty);
    expect(session.latest?.block, 2);
  });

  test('missing evidence and source gaps reset baseline', () {
    final session = WalletWatchSession(walletAddress);
    session.start(
        walletSnapshot(1, [walletPosition('a', 'long', '1', '10', '10')]));
    session.accept(walletSnapshot(
        2, [walletPosition('a', 'long', '2', '10', '20')],
        stale: true));
    expect(session.baseline, isNull);
    session.accept(walletSnapshot(3, []));
    expect(session.events, isEmpty);
    session.accept(
        walletSnapshot(4, [walletPosition('b', 'long', '1', '10', '10')]));
    expect(session.events.single.label, 'Newly observed position');
    session.gap('Network unavailable.');
    expect(session.baseline, isNull);
    session.accept(walletSnapshot(5, []));
    expect(session.events, hasLength(1));
  });

  test('deduplicates block and rejects conflicting or regressing snapshots',
      () {
    final session = WalletWatchSession(walletAddress);
    session.start(
        walletSnapshot(1, [walletPosition('a', 'long', '1', '10', '10')]));
    session.accept(
        walletSnapshot(1, [walletPosition('a', 'long', '1.0', '10', '10')]));
    expect(session.events, isEmpty);
    expect(session.baseline?.block, 1);
    // Same block with changed size is inconsistent, so no event is emitted.
    session.accept(
        walletSnapshot(1, [walletPosition('a', 'long', '2', '10', '20')]));
    expect(session.baseline, isNull);
    expect(session.events, isEmpty);
    session.accept(
        walletSnapshot(2, [walletPosition('a', 'long', '2', '10', '20')]));
    expect(session.baseline?.block, 2);
    session.accept(walletSnapshot(3, [], asOf: DateTime.utc(2026, 10, 13, 11)));
    expect(session.baseline, isNull);
  });

  test('account order stays comparable but account set resets feed', () {
    final session = WalletWatchSession(walletAddress);
    session.start(walletSnapshot(1, [], accounts: ['1', '2']));
    session.accept(walletSnapshot(
        2, [walletPosition('a', 'long', '1', '10', '10')],
        accounts: ['2', '1']));
    expect(session.events, hasLength(1));
    session.accept(walletSnapshot(3, [], accounts: ['3']));
    expect(session.events, isEmpty);
    expect(session.status, 'Linked accounts changed. Watch baseline reset.');
  });

  testWidgets('watch card renders session controls and observation',
      (tester) async {
    final session = WalletWatchSession(walletAddress)
      ..start(walletSnapshot(1, []))
      ..accept(
          walletSnapshot(2, [walletPosition('a', 'long', '1', '10', '10')]));
    await tester.pumpWidget(MaterialApp(
        home: Scaffold(
            body: SingleChildScrollView(
                child: LiveWalletWatchPanel(
                    session: session,
                    onStart: () {},
                    onPause: () {},
                    onResume: () {})))));
    expect(find.text('Live wallet watch'), findsOneWidget);
    expect(find.text('Newly observed position'), findsOneWidget);
    expect(find.text('Marked gross \$0.00 to \$10.00'), findsOneWidget);
    expect(find.text('Pause watch'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
