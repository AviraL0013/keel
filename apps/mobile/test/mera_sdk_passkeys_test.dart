import 'dart:convert';

import 'package:eyeler_mobile/core/wallet/mera_sdk_passkeys.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const sdk = MethodChannel('test/mera_sdk');
  const ceremony = MethodChannel('test/mera_ceremony');
  final messenger =
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;

  tearDown(() => messenger.setMockMethodCallHandler(sdk, null));

  test('SDK PRF result is used only for the pinned RP and valid length',
      () async {
    messenger.setMockMethodCallHandler(sdk, (call) async {
      expect(call.method, 'get');
      expect((call.arguments as Map)['rpId'], 'app.eyeler.xyz');
      return {'prfOutput': base64Url.encode(List<int>.generate(32, (i) => i))};
    });
    final passkeys =
        MeraSdkPasskeys(sdkChannel: sdk, ceremonyChannel: ceremony);
    final prf = await passkeys.getPrf();
    expect(prf, List<int>.generate(32, (i) => i));
    prf.fillRange(0, prf.length, 0);
  });

  test('invalid SDK PRF length is rejected', () async {
    messenger.setMockMethodCallHandler(sdk,
        (_) async => {'prfOutput': base64Url.encode(List<int>.filled(31, 7))});
    final passkeys =
        MeraSdkPasskeys(sdkChannel: sdk, ceremonyChannel: ceremony);
    await expectLater(passkeys.getPrf(), throwsException);
  });
}
