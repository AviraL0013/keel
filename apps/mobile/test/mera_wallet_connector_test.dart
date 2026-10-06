import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:eyeler_mobile/core/wallet/mera_wallet_connector.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:passkeys/authenticator.dart';
import 'package:passkeys/types.dart';

class FixtureAuthenticator extends PasskeyAuthenticator {
  bool noCredential = false;
  int registrations = 0;
  Completer<void>? waitForAuthentication;
  AuthenticateRequestType? lastRequest;
  @override
  Future<RegisterResponseType> register(RegisterRequestType request) async {
    registrations++;
    expect(request.authSelectionType?.residentKey, 'required');
    expect(request.authSelectionType?.userVerification, 'required');
    noCredential = false;
    return const RegisterResponseType(
        id: 'new-passkey',
        rawId: 'new-passkey',
        clientDataJSON: '',
        attestationObject: '',
        transports: ['internal']);
  }

  @override
  Future<AuthenticateResponseType> authenticate(
      AuthenticateRequestType request) async {
    lastRequest = request;
    await waitForAuthentication?.future;
    if (noCredential) throw NoCredentialsAvailableException();
    expect(request.userVerification, 'required');
    return AuthenticateResponseType(
      id: request.allowCredentials?.single.id ?? 'fixture',
      rawId: 'fixture',
      clientDataJSON: '',
      authenticatorData: '',
      signature: '',
      userHandle: '',
      clientExtensionResults: {
        'prf': {
          'results': {
            'first': base64Url.encode(List<int>.generate(32, (i) => i)),
          }
        }
      },
    );
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test(
      'mainnet selection reports Monad 143 without changing the derived wallet',
      () async {
    final connector = MeraWalletConnector(
        authenticator: FixtureAuthenticator(), network: MeraNetwork.mainnet);
    final wallet = await connector.connect();
    expect(wallet.chainId, 143);
    expect(wallet.address, '0xF9297b542BDb5DA50C364f9AE4Cbe1F3933bA40F');
    connector.dispose();
  });
  test('background locking invalidates an unfinished passkey ceremony',
      () async {
    final authenticator = FixtureAuthenticator()
      ..waitForAuthentication = Completer<void>();
    final connector = MeraWalletConnector(authenticator: authenticator);
    final attempt = connector.connect();
    final assertion = expectLater(attempt, throwsException);
    connector.dispose();
    authenticator.waitForAuthentication!.complete();
    await assertion;
    await expectLater(
        connector.signMessage(
            '0xF9297b542BDb5DA50C364f9AE4Cbe1F3933bA40F', 'test'),
        throwsException);
  });
  test(
      'missing sign-in never creates another wallet; explicit creation binds the new credential',
      () async {
    final authenticator = FixtureAuthenticator()..noCredential = true;
    final connector = MeraWalletConnector(authenticator: authenticator);
    await expectLater(connector.connect(), throwsException);
    expect(authenticator.registrations, 0);
    expect(connector.supportsAccountCreation, isTrue);
    await connector.createAccount();
    expect(authenticator.registrations, 1);
    expect(
        authenticator.lastRequest!.allowCredentials!.single.id, 'new-passkey');
    connector.dispose();
  });
  test('Mera personal signature matches independent viem EIP-191 vector',
      () async {
    final connector =
        MeraWalletConnector(authenticator: FixtureAuthenticator());
    final wallet = await connector.connect();
    // Synthetic PRF bytes 0..31, derived independently with @scure BIP-39/BIP-32.
    expect(wallet.address, '0xF9297b542BDb5DA50C364f9AE4Cbe1F3933bA40F');
    final signature =
        await connector.signMessage(wallet.address, 'EYELER test fixture only');
    expect(
        signature.length, 132); // 0x + 65 bytes; never EIP-155 transaction v.
    expect(
        signature,
        '0x0b03a71c744f0db6cf7f652fe648c1bd54f8cf90a03ea2468630b4ea4ed0df963'
        '74b0fdb110b40478bd3c9136e6a70d7237036355eb1650d601c1db24187833f1b');
    connector.dispose();
    await expectLater(
        connector.signMessage(wallet.address, 'again'), throwsException);
  });

  test(
      'Mera signs only bounded Perpl enrollment and matches independent viem EIP-712',
      () async {
    final fixture = jsonDecode(
            File('test/fixtures/perpl_enrollment.json').readAsStringSync())
        as Map<String, dynamic>;
    final connector = MeraWalletConnector(
        authenticator: FixtureAuthenticator(),
        now: () => DateTime.fromMillisecondsSinceEpoch(fixture['now'] as int));
    final wallet = await connector.connect();
    final typed = fixture['typedData'] as Map<String, dynamic>;
    expect(await connector.signTypedData(wallet.address, typed),
        fixture['signature']);
    for (final mutation in <void Function(Map<String, dynamic>)>[
      (t) => t['message']['scope'] = '7',
      (t) => t['message']['maxBuilderFeePer100K'] = '1',
      (t) => t['message']['builderId'] = '26',
      (t) => t['message']['origin'] = 'https://evil.invalid',
      (t) => t['message']['signer'] = '0x${'22' * 20}',
      (t) => t['domain']['chainId'] = '0x8f',
      (t) => t['domain']['verifyingContract'] = '0x${'22' * 20}',
      (t) => t['message']['expiresAt'] = '1',
      (t) => t['message']['time'] = '0x1',
      (t) => t['primaryType'] = 'Permit',
      (t) => t['types']['PerplRegisterApiKey'][0]['type'] = 'string',
    ]) {
      final tampered = jsonDecode(jsonEncode(typed)) as Map<String, dynamic>;
      mutation(tampered);
      await expectLater(
          connector.signTypedData(wallet.address, tampered), throwsException);
    }
    connector.dispose();
    await expectLater(
        connector.signTypedData(wallet.address, typed), throwsException);
  });
}
