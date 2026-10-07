import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:eyeler_mobile/core/config/environment.dart';
import 'package:eyeler_mobile/core/networking/api_client.dart';
import 'package:eyeler_mobile/core/networking/backend_status.dart';
import 'package:eyeler_mobile/main.dart';
import 'package:eyeler_mobile/core/storage/session_storage.dart';
import 'package:eyeler_mobile/core/theme/app_theme.dart';
import 'package:eyeler_mobile/core/wallet/wallet_types.dart';
import 'package:eyeler_mobile/features/auth/data/auth_repository.dart';
import 'package:eyeler_mobile/features/auth/domain/auth_state.dart';
import 'package:eyeler_mobile/features/capital/domain/capital_snapshot.dart';
import 'package:eyeler_mobile/features/onboarding/data/onboarding_repository.dart';
import 'package:eyeler_mobile/features/onboarding/domain/onboarding_progress.dart';
import 'package:eyeler_mobile/features/onboarding/presentation/onboarding_screen.dart';
import 'package:eyeler_mobile/features/onboarding/presentation/trading_entry_route.dart';

CapitalSnapshot capital(
        {String? wallet = '10.000000',
        String? collateral = '20.000000',
        String walletFreshness = 'FRESH',
        String collateralFreshness = 'FRESH',
        String asset = 'AUSD',
        int account = 7}) =>
    CapitalSnapshot.fromJson({
      'status': 'VALID',
      'accountId': account,
      'walletAgoraAusd': {
        'amount': wallet,
        'asset': 'AUSD',
        'availability': wallet == null ? 'UNAVAILABLE' : 'AVAILABLE',
        'freshness': walletFreshness,
        'onChain': {'chainId': 143}
      },
      'perplAvailable': {
        'amount': collateral,
        'asset': asset,
        'availability': collateral == null ? 'UNAVAILABLE' : 'AVAILABLE',
        'freshness': collateralFreshness
      },
    });
const active = {
  'status': 'AVAILABLE',
  'accountId': 7,
  'forwardingEnabled': true
};
OnboardingProgress plan(
        {CapitalSnapshot? snapshot,
        Map<String, dynamic> account = active,
        int positions = 0,
        int books = 0,
        String environment = 'mainnet'}) =>
    planOnboarding(
      environment: environment,
      capital: snapshot ?? capital(),
      account: account,
      openPositions: positions,
      books: books,
    );

class TestStorage extends SessionStorage {
  @override
  Future<String?> readToken() async => null;
}

class TestWallet extends WalletConnector {
  @override
  Future<WalletConnection> connect() => throw UnimplementedError();
  @override
  Future<String> signMessage(String address, String message) =>
      throw UnimplementedError();
  @override
  Future<String> signTypedData(
          String address, Map<String, Object?> typedData) =>
      throw UnimplementedError();
}

class TestAuth extends AuthController {
  TestAuth(EyelerApiClient api)
      : super(AuthRepository(api), TestStorage(), TestWallet());
  void login(String address) =>
      state = AuthState(authenticated: true, address: address);
  @override
  Future<void> restore() async {}
}

void main() {
  test('new wallet funding advances to activation, trade, then Book protection',
      () {
    expect(
        plan(
            snapshot: capital(wallet: '0'),
            account: {'status': 'NOT_CONNECTED'}).step,
        OnboardingStep.fundWallet);
    expect(plan(account: {'status': 'NOT_CONNECTED'}).step,
        OnboardingStep.activatePerpl);
    expect(plan().step, OnboardingStep.firstTrade);
    expect(plan(positions: 1).step, OnboardingStep.protectPosition);
    expect(plan(positions: 1, books: 1).step, OnboardingStep.complete);
  });
  test(
      'wallet empty after deposit does not restart funding for an activated account',
      () {
    final progress = plan(snapshot: capital(wallet: '0'));
    expect(progress.step, OnboardingStep.firstTrade);
    expect(progress.canOpenTrade, isTrue);
  });
  test(
      'unavailable and stale funds cannot be presented as zero or enable trading',
      () {
    for (final snapshot in [
      capital(collateral: null),
      capital(collateralFreshness: 'STALE'),
      capital(account: 8),
      capital(asset: 'USD'),
      capital(collateral: '-2')
    ]) {
      final progress = plan(snapshot: snapshot);
      expect(progress.step, OnboardingStep.unavailable);
      expect(progress.canOpenTrade, isFalse);
    }
    expect(
        plan(
            snapshot: capital(wallet: null),
            account: {'status': 'NOT_CONNECTED'}).step,
        OnboardingStep.unavailable);
    expect(
        plan(
            snapshot: capital(walletFreshness: 'STALE'),
            account: {'status': 'NOT_CONNECTED'}).step,
        OnboardingStep.unavailable);
  });
  test('disabled forwarding and an unknown account never enable order controls',
      () {
    expect(plan(account: {...active, 'forwardingEnabled': false}).step,
        OnboardingStep.activatePerpl);
    expect(plan(account: {...active, 'forwardingEnabled': false}).canOpenTrade,
        isFalse);
    expect(plan(account: {'status': 'UNAVAILABLE'}).step,
        OnboardingStep.unavailable);
    expect(plan(account: {...active, 'accountId': 0}).canOpenTrade, isFalse);
  });
  test(
      'zero collateral requires a deposit but existing positions can still be protected',
      () {
    expect(plan(snapshot: capital(collateral: '0')).step,
        OnboardingStep.fundCollateral);
    final progress = plan(snapshot: capital(collateral: '0'), positions: 1);
    expect(progress.step, OnboardingStep.protectPosition);
    expect(progress.canOpenTrade, isFalse);
    expect(
        plan(snapshot: capital(collateral: '0.000001')).canOpenTrade, isTrue);
  });
  test('testnet remains explicit USD and never asks for a mainnet deposit', () {
    expect(
        plan(
                environment: 'testnet',
                account: {'status': 'NOT_CONNECTED'},
                snapshot: capital(wallet: null, asset: 'USD'))
            .step,
        OnboardingStep.activatePerpl);
    expect(
        plan(environment: 'testnet', snapshot: capital(asset: 'USD'))
            .canOpenTrade,
        isTrue);
    expect(plan(environment: 'testnet').canOpenTrade, isFalse);
  });
  test('identity switch discards onboarding data from the prior user',
      () async {
    var owner = 'alice';
    final client = MockClient((request) async {
      final body = switch (request.url.path) {
        '/connections/perpl/capabilities' => {
            'status': 'AVAILABLE',
            'environment': 'testnet'
          },
        '/connections' => <dynamic>[],
        '/connections/perpl/account-state' => {
            'status': 'AVAILABLE',
            'accountId': owner == 'alice' ? 7 : 8,
            'forwardingEnabled': true
          },
        '/capital' => {
            'accountId': owner == 'alice' ? 7 : 8,
            'perplAvailable': {
              'amount': owner == 'alice' ? '20' : '0',
              'asset': 'USD',
              'availability': 'AVAILABLE',
              'freshness': 'FRESH'
            }
          },
        '/connections/perpl/positions' => {'status': 'VALID', 'positions': []},
        '/books' => <dynamic>[],
        _ => throw StateError('Unexpected request ${request.url.path}'),
      };
      return http.Response(jsonEncode(body), 200);
    });
    final api = EyelerApiClient(
        const EyelerConfig(apiBaseUrl: 'https://fixture.invalid'),
        TestStorage(),
        client);
    final auth = TestAuth(api)..login(owner);
    final container = ProviderContainer(overrides: [
      apiClientProvider.overrideWithValue(api),
      authProvider.overrideWith((_) => auth)
    ]);
    final subscription = container.listen(onboardingProvider, (_, __) {});
    addTearDown(subscription.close);
    addTearDown(container.dispose);
    addTearDown(client.close);
    expect(
        (await container.read(onboardingProvider.future)).canOpenTrade, isTrue);
    owner = 'bob';
    auth.login(owner);
    final next = await container.read(onboardingProvider.future);
    expect(next.accountId, 8);
    expect(next.step, OnboardingStep.fundCollateral);
    expect(next.canOpenTrade, isFalse);
  });
  for (final width in [320.0, 427.0]) {
    testWidgets('setup fits $width phone width with enlarged text',
        (tester) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = Size(width, 952);
      addTearDown(tester.view.resetDevicePixelRatio);
      addTearDown(tester.view.resetPhysicalSize);
      await tester.pumpWidget(ProviderScope(
          child: MaterialApp(
              theme: EyelerTheme.dark,
              home: MediaQuery(
                  data: MediaQueryData(
                      size: Size(width, 952),
                      textScaler: const TextScaler.linear(1.3)),
                  child: OnboardingScreen(
                      progress: plan(account: {'status': 'NOT_CONNECTED'}))))));
      await tester.pump();
      expect(tester.takeException(), isNull);
      await tester.drag(find.byType(ListView), const Offset(0, -650));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      expect(find.text('ACTIVATE PERPL'), findsOneWidget);
    });
  }
  testWidgets(
      'opening route sends an unready wallet to setup instead of markets',
      (tester) async {
    await tester.pumpWidget(ProviderScope(overrides: [
      onboardingProvider.overrideWith((_) async => plan(
          snapshot: capital(wallet: '0'), account: {'status': 'NOT_CONNECTED'}))
    ], child: const MaterialApp(home: TradingEntryRoute())));
    await tester.pumpAndSettle();
    expect(find.text('Your wallet. Your starting point.'), findsOneWidget);
    expect(find.text('Choose a market'), findsNothing);
  });
  testWidgets('session expiry removes previously pushed wallet screens',
      (tester) async {
    final client = MockClient((_) async => http.Response('{}', 200));
    final api = EyelerApiClient(
        const EyelerConfig(apiBaseUrl: 'https://fixture.invalid'),
        TestStorage(),
        client);
    final auth = TestAuth(api)..login('0x${'11' * 20}');
    addTearDown(client.close);
    await tester.pumpWidget(ProviderScope(overrides: [
      authProvider.overrideWith((_) => auth),
      onboardingProvider.overrideWith(
          (_) async => plan(account: {'status': 'NOT_CONNECTED'})),
      backendStatusProvider.overrideWith((_) async =>
          const BackendStatus(BackendState.live, environment: 'testnet')),
    ], child: const EyelerApp()));
    await tester.pump();
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();
    final navigator =
        tester.state<NavigatorState>(find.byType(Navigator).first);
    navigator.push(MaterialPageRoute<void>(
        builder: (_) => const Scaffold(body: Text('Private wallet screen'))));
    await tester.pumpAndSettle();
    expect(find.text('Private wallet screen'), findsOneWidget);
    auth.sessionExpired();
    await tester.pumpAndSettle();
    expect(find.text('Private wallet screen'), findsNothing);
    expect(find.text('Secure wallet sign-in'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
