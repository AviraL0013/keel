import 'dart:convert';

import 'package:eyeler_mobile/core/wallet/mera_wallet_connector.dart';
import 'package:eyeler_mobile/core/wallet/mera_wallet_export.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:passkeys/authenticator.dart';
import 'package:passkeys/types.dart';

class ExportAuthenticator extends PasskeyAuthenticator {
  int assertions = 0;

  @override
  Future<AuthenticateResponseType> authenticate(
      AuthenticateRequestType request) async {
    assertions++;
    return AuthenticateResponseType(
        id: 'fixture',
        rawId: 'fixture',
        clientDataJSON: '',
        authenticatorData: '',
        signature: '',
        userHandle: '',
        clientExtensionResults: {
          'prf': {
            'results': {
              'first': base64Url.encode(List<int>.generate(32, (i) => i))
            }
          }
        });
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('export shows no key before re-authentication and blocks capture',
      (tester) async {
    tester.view.physicalSize = const Size(320, 640);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    const secure = MethodChannel('test/secure_export');
    final events = <String>[];
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(secure, (call) async {
      events.add(call.method);
      return null;
    });
    addTearDown(() => messenger.setMockMethodCallHandler(secure, null));
    messenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
      if (call.method == 'Clipboard.getData') return null;
      return null;
    });
    addTearDown(() =>
        messenger.setMockMethodCallHandler(SystemChannels.platform, null));
    final authenticator = ExportAuthenticator();
    final wallet = MeraWalletConnector(
        authenticator: authenticator, network: MeraNetwork.mainnet);
    final connection = await wallet.connect();
    await tester.pumpWidget(MaterialApp(
        home: Scaffold(
            body: Builder(
                builder: (context) => FilledButton(
                    onPressed: () => showMeraPrivateKeyExport(
                        context, wallet, connection.address,
                        secureDisplay: secure),
                    child: const Text('EXPORT'))))));
    await tester.tap(find.text('EXPORT'));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('mera-private-key')), findsNothing);
    expect(authenticator.assertions, 1);
    await tester.tap(find.text('VERIFY PASSKEY'));
    await tester.pumpAndSettle();
    expect(events, contains('enable'));
    expect(authenticator.assertions, 2);
    expect(find.byKey(const Key('mera-private-key')), findsOneWidget);
    await tester.tap(find.text('DONE'));
    await tester.pumpAndSettle();
    await tester.pump();
    expect(events.last, 'disable');
    wallet.dispose();
  });
}
