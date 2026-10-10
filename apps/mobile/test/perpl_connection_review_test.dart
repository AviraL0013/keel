import 'dart:convert';
import 'dart:io';

import 'package:eyeler_mobile/core/config/environment.dart';
import 'package:eyeler_mobile/core/networking/api_client.dart';
import 'package:eyeler_mobile/core/storage/session_storage.dart';
import 'package:eyeler_mobile/core/wallet/wallet_types.dart';
import 'package:eyeler_mobile/features/auth/data/auth_repository.dart';
import 'package:eyeler_mobile/features/auth/domain/auth_state.dart';
import 'package:eyeler_mobile/features/positions/presentation/perpl_connection_panel.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:web3dart/crypto.dart';

const _address = '0xF9297b542BDb5DA50C364f9AE4Cbe1F3933bA40F';

class _Storage extends SessionStorage {
  @override
  Future<String?> readToken() async => 'test-session';
}

class _Wallet extends WalletConnector {
  final events = <String>[];
  @override
  Future<WalletConnection> connect() async {
    events.add('fingerprint');
    return const WalletConnection(address: _address, chainId: 143);
  }

  @override
  Future<String> signMessage(String address, String message) async =>
      throw StateError('No sign-in in this test');

  @override
  Future<String> signTypedData(
      String address, Map<String, Object?> typedData) async {
    events.add('sign');
    return '0x${'ab' * 65}';
  }
}

class _Auth extends AuthController {
  _Auth(EyelerApiClient api, _Wallet wallet)
      : super(AuthRepository(api), _Storage(), wallet) {
    state = const AuthState(authenticated: true, address: _address);
  }
}

Map<String, dynamic> _typedData() {
  final fixture =
      jsonDecode(File('test/fixtures/perpl_enrollment.json').readAsStringSync())
          as Map<String, dynamic>;
  final typed = Map<String, dynamic>.from(fixture['typedData'] as Map);
  final domain = Map<String, dynamic>.from(typed['domain'] as Map);
  domain['chainId'] = '0x8f';
  typed['domain'] = domain;
  final message = Map<String, dynamic>.from(typed['message'] as Map);
  message['publicKey'] = base64Url
      .encode(hexToBytes(message['publicKey'] as String))
      .replaceAll('=', '');
  final now = DateTime.now().millisecondsSinceEpoch;
  message['time'] = '0x${now.toRadixString(16)}';
  message['expiresAt'] = '${now + 86400000}';
  typed['message'] = message;
  return typed;
}

void main() {
  for (final width in [320.0, 360.0]) {
    testWidgets(
        'reviews exact account and trade-only terms before fingerprint at $width dp',
        (tester) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = Size(width, 950);
      addTearDown(tester.view.resetDevicePixelRatio);
      addTearDown(tester.view.resetPhysicalSize);
      final wallet = _Wallet();
      final events = <String>[];
      final typed = _typedData();
      final client = MockClient((request) async {
        if (request.url.path == '/connections/perpl/enrollment') {
          events.add('start');
          return http.Response(
              jsonEncode({'connectionId': 'pending-1', 'typedData': typed}),
              200);
        }
        if (request.url.path == '/connections/perpl/pending-1/disconnect') {
          events.add('disconnect');
          return http.Response('{}', 200);
        }
        if (request.url.path == '/connections/perpl/capabilities') {
          return http.Response(
              jsonEncode({
                'status': 'AVAILABLE',
                'environment': 'mainnet',
                'chainId': 143,
                'origin': 'https://app.eyeler.xyz',
                'builderId': 25,
                'maxBuilderFeePer100K': 0,
                'scope': 'read,trade',
                'withdrawals': false,
              }),
              200);
        }
        if (request.url.path == '/connections') {
          return http.Response('[]', 200);
        }
        throw StateError('Unexpected request ${request.url.path}');
      });
      addTearDown(client.close);
      final api = EyelerApiClient(
          const EyelerConfig(apiBaseUrl: 'https://fixture.invalid'),
          _Storage(),
          client);
      await tester.pumpWidget(ProviderScope(
          overrides: [
            apiClientProvider.overrideWithValue(api),
            walletConnectorProvider.overrideWithValue(wallet),
            authProvider.overrideWith((_) => _Auth(api, wallet)),
            perplEnrollmentAccountProvider.overrideWithValue((address) async {
              events.add('account');
              expect(address, _address);
              return 5438;
            }),
          ],
          child: const MaterialApp(
              home: Scaffold(
                  body:
                      SingleChildScrollView(child: PerplConnectionPanel())))));
      await tester.pumpAndSettle();
      await tester.tap(find.text('CONNECT MY PERPL ACCOUNT'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 350));
      expect(events, ['account', 'start']);
      expect(wallet.events, isEmpty);
      expect(find.textContaining('Account 5438'), findsOneWidget);
      expect(find.textContaining('Chain 143'), findsOneWidget);
      expect(find.textContaining('https://app.eyeler.xyz'), findsOneWidget);
      expect(find.text('Builder 25 · Fee 0%'), findsOneWidget);
      expect(find.textContaining('Fee 0%'), findsOneWidget);
      expect(find.textContaining('No withdrawals'), findsWidgets);
      expect(find.textContaining('Expiry:'), findsOneWidget);
      await tester.tap(find.text('CANCEL'));
      await tester.pumpAndSettle();
      expect(events, ['account', 'start', 'disconnect']);
      expect(wallet.events, isEmpty);
    });
  }

  testWidgets(
      'a payload failure reports its stage and never invokes fingerprint',
      (tester) async {
    final wallet = _Wallet();
    final client = MockClient((request) async {
      if (request.url.path == '/connections/perpl/enrollment') {
        return http.Response(
            jsonEncode({'error': 'PERPL_ENROLLMENT_UNAVAILABLE'}), 503);
      }
      if (request.url.path == '/connections/perpl/capabilities') {
        return http.Response(
            jsonEncode({
              'status': 'AVAILABLE',
              'environment': 'mainnet',
              'chainId': 143,
              'origin': 'https://app.eyeler.xyz',
              'builderId': 25,
              'maxBuilderFeePer100K': 0,
              'scope': 'read,trade',
              'withdrawals': false,
            }),
            200);
      }
      if (request.url.path == '/connections') return http.Response('[]', 200);
      throw StateError('Unexpected request ${request.url.path}');
    });
    addTearDown(client.close);
    final api = EyelerApiClient(
        const EyelerConfig(apiBaseUrl: 'https://fixture.invalid'),
        _Storage(),
        client);
    await tester.pumpWidget(ProviderScope(
        overrides: [
          apiClientProvider.overrideWithValue(api),
          walletConnectorProvider.overrideWithValue(wallet),
          authProvider.overrideWith((_) => _Auth(api, wallet)),
          perplEnrollmentAccountProvider.overrideWithValue((_) async => 5438),
        ],
        child: const MaterialApp(
            home: Scaffold(
                body: SingleChildScrollView(child: PerplConnectionPanel())))));
    await tester.pumpAndSettle();
    await tester.tap(find.text('CONNECT MY PERPL ACCOUNT'));
    await tester.pumpAndSettle();
    expect(find.textContaining('PERPL_ENROLLMENT_UNAVAILABLE'), findsOneWidget);
    expect(wallet.events, isEmpty);
  });

  testWidgets('only explicit review advances to fingerprint and enrollment',
      (tester) async {
    final wallet = _Wallet();
    final events = <String>[];
    final typed = _typedData();
    final client = MockClient((request) async {
      if (request.url.path == '/connections/perpl/enrollment') {
        events.add('start');
        return http.Response(
            jsonEncode({'connectionId': 'pending-2', 'typedData': typed}), 200);
      }
      if (request.url.path ==
          '/connections/perpl/enrollment/pending-2/complete') {
        events.add('complete');
        expect(jsonDecode(request.body)['signature'], '0x${'ab' * 65}');
        return http.Response('{}', 200);
      }
      if (request.url.path == '/connections/perpl/capabilities') {
        return http.Response(
            jsonEncode({
              'status': 'AVAILABLE',
              'environment': 'mainnet',
              'chainId': 143,
              'origin': 'https://app.eyeler.xyz',
              'builderId': 25,
              'maxBuilderFeePer100K': 0,
              'scope': 'read,trade',
              'withdrawals': false,
            }),
            200);
      }
      if (request.url.path == '/connections') return http.Response('[]', 200);
      throw StateError('Unexpected request ${request.url.path}');
    });
    addTearDown(client.close);
    final api = EyelerApiClient(
        const EyelerConfig(apiBaseUrl: 'https://fixture.invalid'),
        _Storage(),
        client);
    await tester.pumpWidget(ProviderScope(
        overrides: [
          apiClientProvider.overrideWithValue(api),
          walletConnectorProvider.overrideWithValue(wallet),
          authProvider.overrideWith((_) => _Auth(api, wallet)),
          perplEnrollmentAccountProvider.overrideWithValue((_) async => 5438),
        ],
        child: const MaterialApp(
            home: Scaffold(
                body: SingleChildScrollView(child: PerplConnectionPanel())))));
    await tester.pumpAndSettle();
    await tester.tap(find.text('CONNECT MY PERPL ACCOUNT'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 350));
    expect(wallet.events, isEmpty);
    expect(events, ['start']);
    await tester.tap(find.text('CONTINUE TO FINGERPRINT'));
    await tester.pumpAndSettle();
    expect(wallet.events, ['fingerprint', 'sign']);
    expect(events, ['start', 'complete']);
    expect(find.textContaining('Perpl key connected.'), findsOneWidget);
  });
}
