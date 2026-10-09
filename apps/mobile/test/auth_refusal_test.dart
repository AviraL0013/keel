import 'dart:convert';

import 'package:eyeler_mobile/core/config/environment.dart';
import 'package:eyeler_mobile/core/networking/api_client.dart';
import 'package:eyeler_mobile/core/networking/backend_status.dart';
import 'package:eyeler_mobile/core/storage/session_storage.dart';
import 'package:eyeler_mobile/core/theme/app_theme.dart';
import 'package:eyeler_mobile/core/wallet/wallet_types.dart';
import 'package:eyeler_mobile/features/auth/data/auth_repository.dart';
import 'package:eyeler_mobile/features/auth/presentation/auth_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

const address = '0x335E58172fC8895Bc380471972A22Ea921152F6d';

class _NoSession extends SessionStorage {
  @override
  Future<String?> readToken() async => null;
}

class _MeraWallet extends WalletConnector {
  @override
  bool get supportsAccountCreation => true;
  @override
  Future<WalletConnection> connect() async =>
      const WalletConnection(address: address, chainId: 143);
  @override
  Future<String> signMessage(String address, String message) async =>
      throw StateError('challenge must be refused before signing');
  @override
  Future<String> signTypedData(
          String address, Map<String, Object?> typedData) async =>
      throw StateError('not used');
}

void main() {
  for (final width in [320.0, 360.0]) {
    testWidgets(
        'refused Mera wallet shows copyable public address at $width dp',
        (tester) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = Size(width, 952);
      addTearDown(tester.view.resetDevicePixelRatio);
      addTearDown(tester.view.resetPhysicalSize);
      String? copiedAddress;
      tester.binding.defaultBinaryMessenger
          .setMockMethodCallHandler(SystemChannels.platform, (call) async {
        if (call.method == 'Clipboard.setData') {
          copiedAddress = (call.arguments as Map)['text'] as String?;
        }
        return null;
      });
      addTearDown(() => tester.binding.defaultBinaryMessenger
          .setMockMethodCallHandler(SystemChannels.platform, null));
      final client = MockClient((request) async {
        expect(request.url.path, '/auth/challenge');
        return http.Response(jsonEncode({'error': 'WALLET_NOT_ALLOWED'}), 403);
      });
      addTearDown(client.close);
      await tester.pumpWidget(ProviderScope(
        overrides: [
          backendStatusProvider.overrideWith((ref) async =>
              const BackendStatus(BackendState.live, environment: 'mainnet')),
          sessionStorageProvider.overrideWithValue(_NoSession()),
          walletConnectorProvider.overrideWithValue(_MeraWallet()),
          apiClientProvider.overrideWithValue(EyelerApiClient(
              const EyelerConfig(apiBaseUrl: 'https://example.invalid'),
              _NoSession(),
              client)),
        ],
        child: MaterialApp(theme: EyelerTheme.dark, home: const AuthScreen()),
      ));
      await tester.pump();
      await tester.tap(find.text('SIGN IN WITH PASSKEY'));
      await tester.pumpAndSettle();
      await tester.drag(find.byType(ListView), const Offset(0, -650));
      await tester.pumpAndSettle();
      expect(
          find.text('Ask the operator to add this address.'), findsOneWidget);
      expect(find.text(address), findsOneWidget);
      expect(find.byTooltip('Copy wallet address'), findsOneWidget);
      await tester.tap(find.byTooltip('Copy wallet address'));
      await tester.pump();
      expect(copiedAddress, address);
      expect(tester.takeException(), isNull);
    });
  }
}
