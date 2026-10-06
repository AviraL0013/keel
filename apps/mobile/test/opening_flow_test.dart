import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:eyeler_mobile/features/openings/data/opening_repository.dart';
import 'package:eyeler_mobile/features/openings/presentation/opening_screen.dart';
import 'package:eyeler_mobile/features/positions/data/positions_repository.dart';
import 'package:eyeler_mobile/features/positions/domain/position.dart';
import 'package:eyeler_mobile/features/capital/data/capital_repository.dart';
import 'package:eyeler_mobile/features/capital/domain/capital_snapshot.dart';
import 'package:eyeler_mobile/core/config/environment.dart';
import 'package:eyeler_mobile/core/networking/api_client.dart';
import 'package:eyeler_mobile/core/storage/session_storage.dart';
import 'package:eyeler_mobile/core/errors/eyeler_exception.dart';
import 'package:http/http.dart' as http;

class FakeOpeningRepository extends OpeningRepository {
  FakeOpeningRepository(this.markets);
  final List<OpeningMarket> markets;
  final pending = Completer<OpeningOrder>();
  int confirmCalls = 0;
  int previewCalls = 0;
  bool expireFirst = false;
  OpeningOrder? currentOrder;
  @override
  Future<List<OpeningMarket>> listMarkets() async => markets;
  @override
  Future<Map<String, dynamic>> snapshot(int marketId) async => {
        'bidRaw': 999999,
        'askRaw': 1000001,
        'priceDecimals': 1,
      };
  @override
  Future<OpeningPreview> preview(int marketId, String side, String size,
      String leverage, int slippageBps) async {
    previewCalls++;
    return OpeningPreview(
        id: '00000000-0000-4000-8000-000000000001',
        accountId: 12,
        connectionId: 'connection',
        expiresAt: DateTime.now().millisecondsSinceEpoch +
            (expireFirst && previewCalls == 1 ? -1 : 15000),
        quote: {
          'environment': 'testnet',
          'side': side,
          'size': size,
          'market': 'BTC',
          'limitPrice': '100001.0',
          'leverage': leverage,
          'slippageBps': slippageBps,
          'estimatedMargin': '20.000000',
          'estimatedTradingFee': '0.010000',
          'recycleFee': '0.001000',
          'estimatedRequiredBalance': '20.011000',
          'collateralAsset': 'USD'
        });
  }

  @override
  Future<OpeningOrder> confirm(String previewId, String key) {
    confirmCalls++;
    return pending.future;
  }

  @override
  Future<OpeningOrder> order(String id) async =>
      currentOrder ??
      const OpeningOrder(
          id: 'order',
          status: 'VERIFYING',
          environment: 'testnet',
          accountId: 12,
          marketId: 7,
          side: 'LONG');
}

class DisabledOpeningRepository extends FakeOpeningRepository {
  DisabledOpeningRepository() : super(const []);
  @override
  Future<List<OpeningMarket>> listMarkets() async =>
      throw const EyelerException('OPENING_DISABLED', statusCode: 403);
}

class DelayedOpeningRepository extends FakeOpeningRepository {
  DelayedOpeningRepository() : super(const []);
  final result = Completer<List<OpeningMarket>>();
  @override
  Future<List<OpeningMarket>> listMarkets() => result.future;
}

class StaticPositionsRepository extends PositionsRepository {
  StaticPositionsRepository(this.position)
      : super(EyelerApiClient(const EyelerConfig(apiBaseUrl: 'http://unused'),
            const SessionStorage(), http.Client()));
  final Position position;
  @override
  Future<List<Position>> list() async => [position];
}

void main() {
  test('opening status decodes PostgreSQL bigint IDs without losing ownership',
      () {
    final order = OpeningOrder.fromJson({
      'id': '00000000-0000-4000-8000-000000000001',
      'status': 'CONFIRMED',
      'environment': 'testnet',
      'account_id': '12',
      'market_id': 7,
      'side': 'LONG',
      'position_id': '98',
    });
    expect(order.accountId, 12);
    expect(order.positionId, 98);
  });
  for (final width in [320.0, 360.0]) {
    testWidgets('loading and error opening states fit $width dp',
        (tester) async {
      tester.view.physicalSize = Size(width, 700);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final repository = DelayedOpeningRepository();
      await tester.pumpWidget(ProviderScope(overrides: [
        openingRepositoryProvider.overrideWithValue(repository),
      ], child: const MaterialApp(home: OpeningScreen())));
      await tester.pump();
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      repository.result.completeError(
          const EyelerException('PERPL_MARKET_UNAVAILABLE', statusCode: 503));
      await tester.pumpAndSettle();
      expect(
          find.text('EYELER server unavailable. Check the backend and retry.'),
          findsOneWidget);
      expect(find.text('Retry'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
    testWidgets('disabled opening state fits $width dp', (tester) async {
      tester.view.physicalSize = Size(width, 700);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await tester.pumpWidget(ProviderScope(overrides: [
        openingRepositoryProvider
            .overrideWithValue(DisabledOpeningRepository()),
      ], child: const MaterialApp(home: OpeningScreen())));
      await tester.pumpAndSettle();
      expect(find.text('Opening trades are not enabled for this account.'),
          findsOneWidget);
      expect(find.text('Retry'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
    testWidgets('opening market empty state fits $width dp', (tester) async {
      tester.view.physicalSize = Size(width, 700);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await tester.pumpWidget(ProviderScope(overrides: [
        openingRepositoryProvider.overrideWithValue(FakeOpeningRepository([])),
      ], child: const MaterialApp(home: OpeningScreen())));
      await tester.pumpAndSettle();
      expect(find.text('No tradable markets'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
    testWidgets(
        'order form requires exact size and chosen leverage at $width dp',
        (tester) async {
      tester.view.physicalSize = Size(width, 700);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await tester.pumpWidget(ProviderScope(overrides: [
        openingRepositoryProvider.overrideWithValue(FakeOpeningRepository([
          const OpeningMarket(id: 7, symbol: 'BTC', status: 'OPEN'),
        ])),
      ], child: const MaterialApp(home: OpeningScreen())));
      await tester.pumpAndSettle();
      await tester.tap(find.text('BTC'));
      await tester.pumpAndSettle();
      expect(
          tester
              .widget<FilledButton>(
                  find.widgetWithText(FilledButton, 'Preview order'))
              .onPressed,
          isNull);
      await tester.enterText(
          find.widgetWithText(TextField, 'Exact size'), '0.00100');
      await tester.enterText(
          find.widgetWithText(TextField, 'Leverage'), '5.00');
      await tester.pump();
      expect(
          tester
              .widget<FilledButton>(
                  find.widgetWithText(FilledButton, 'Preview order'))
              .onPressed,
          isNotNull);
      expect(tester.takeException(), isNull);
    });
  }
  testWidgets('explicit confirmation blocks double taps and shows order status',
      (tester) async {
    final repository = FakeOpeningRepository([
      const OpeningMarket(id: 7, symbol: 'BTC', status: 'OPEN'),
    ]);
    await tester.pumpWidget(ProviderScope(overrides: [
      openingRepositoryProvider.overrideWithValue(repository),
    ], child: const MaterialApp(home: OpeningScreen())));
    await tester.pumpAndSettle();
    await tester.tap(find.text('BTC'));
    await tester.pumpAndSettle();
    await tester.enterText(
        find.widgetWithText(TextField, 'Exact size'), '0.00100');
    await tester.enterText(find.widgetWithText(TextField, 'Leverage'), '5.00');
    tester.testTextInput.hide();
    await tester.pump();
    final previewButton = find.widgetWithText(FilledButton, 'Preview order');
    expect(tester.widget<FilledButton>(previewButton).onPressed, isNotNull);
    await tester.ensureVisible(previewButton);
    await tester.tap(find.text('Preview order'));
    await tester.pumpAndSettle();
    expect(find.text('testnet · Perpl account 12'), findsOneWidget);
    await tester.tap(find.text('Confirm order'));
    await tester.pump();
    expect(repository.confirmCalls, 1);
    expect(
        tester
            .widget<FilledButton>(
                find.widgetWithText(FilledButton, 'Submitting…'))
            .onPressed,
        isNull);
    repository.pending.complete(const OpeningOrder(
        id: 'order',
        status: 'VERIFYING',
        environment: 'testnet',
        accountId: 12,
        marketId: 7,
        side: 'LONG'));
    await tester.pump();
    await tester.pump();
    expect(find.text('Order status'), findsOneWidget);
    expect(repository.confirmCalls, 1);
    await tester.pumpWidget(const SizedBox.shrink());
  });
  testWidgets('expired preview requests a new preview without submitting',
      (tester) async {
    final repository = FakeOpeningRepository([
      const OpeningMarket(id: 7, symbol: 'BTC', status: 'OPEN'),
    ])
      ..expireFirst = true;
    await tester.pumpWidget(ProviderScope(overrides: [
      openingRepositoryProvider.overrideWithValue(repository),
    ], child: const MaterialApp(home: OpeningScreen())));
    await tester.pumpAndSettle();
    await tester.tap(find.text('BTC'));
    await tester.pumpAndSettle();
    await tester.enterText(
        find.widgetWithText(TextField, 'Exact size'), '0.00100');
    await tester.enterText(find.widgetWithText(TextField, 'Leverage'), '5.00');
    tester.testTextInput.hide();
    await tester.pump();
    await tester.tap(find.text('Preview order'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Confirm order'));
    await tester.pumpAndSettle();
    expect(repository.previewCalls, 2);
    expect(repository.confirmCalls, 0);
    await tester.pumpWidget(const SizedBox.shrink());
  });
  testWidgets('verified opening offers existing Create Book flow',
      (tester) async {
    final repository = FakeOpeningRepository([])
      ..currentOrder = const OpeningOrder(
          id: 'order',
          status: 'CONFIRMED',
          environment: 'testnet',
          accountId: 12,
          marketId: 7,
          side: 'LONG',
          positionId: 98,
          filledSize: '0.00100',
          averagePrice: '100000.0');
    const position = Position(
        marketId: 7,
        accountId: 12,
        market: 'BTC',
        positionId: 98,
        side: 'LONG',
        size: 0.001,
        entryPrice: 100000,
        markPrice: 100000,
        liquidationPrice: 90000,
        leverage: 5,
        margin: 20,
        status: 'OPEN');
    await tester.pumpWidget(ProviderScope(overrides: [
      openingRepositoryProvider.overrideWithValue(repository),
      positionsRepositoryProvider
          .overrideWithValue(StaticPositionsRepository(position)),
      capitalProvider.overrideWith((ref) async => CapitalSnapshot.fromJson({
            'status': 'VALID',
            'walletAusd': '10',
            'perplAvailable': '100',
            'perplLocked': '0'
          })),
    ], child: const MaterialApp(home: OpeningStatusScreen(orderId: 'order'))));
    await tester.pump();
    await tester.pump();
    expect(find.text('Verified position 98'), findsOneWidget);
    await tester.tap(find.text('Protect this position'));
    await tester.pumpAndSettle();
    expect(find.text('Configure Book'), findsOneWidget);
    await tester.pumpWidget(const SizedBox.shrink());
  });
}
