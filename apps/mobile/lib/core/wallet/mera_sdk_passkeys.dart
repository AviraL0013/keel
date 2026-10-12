import 'dart:convert';

import 'package:flutter/services.dart';
import 'package:passkeys/authenticator.dart';
import 'package:passkeys/types.dart';

import 'mera_derivation.dart';
import 'wallet_types.dart';

/// Android bridge to the bundled, official @category-labs/mera SDK.
/// Its WebAuthn client delegates only the credential ceremony to Android.
class MeraSdkPasskeys {
  MeraSdkPasskeys(
      {PasskeyAuthenticator? authenticator,
      MethodChannel? sdkChannel,
      MethodChannel? ceremonyChannel})
      : _authenticator = authenticator ?? PasskeyAuthenticator(),
        _sdk = sdkChannel ?? const MethodChannel('xyz.eyeler.app/mera_sdk'),
        _ceremony = ceremonyChannel ??
            const MethodChannel('xyz.eyeler.app/mera_ceremony') {
    _ceremony.setMethodCallHandler(_handleCeremony);
  }

  static const rpId = 'app.eyeler.xyz';
  final PasskeyAuthenticator _authenticator;
  final MethodChannel _sdk;
  final MethodChannel _ceremony;

  Future<Uint8List> getPrf({String? credentialId}) =>
      _run('get', credentialId: credentialId);

  Future<Uint8List> createPrf(String label) => _run('create', label: label);

  Future<Uint8List> _run(String method,
      {String? label, String? credentialId}) async {
    final response = await _sdk.invokeMapMethod<String, dynamic>(method, {
      'rpId': rpId,
      if (label != null) 'label': label,
      if (credentialId != null) 'credentialId': credentialId,
    });
    final encoded = response?['prfOutput'];
    if (encoded is! String) {
      throw const WalletException('Mera SDK did not return PRF output.');
    }
    final prf = _decode(encoded);
    if (prf.length != 32) {
      prf.fillRange(0, prf.length, 0);
      throw const WalletException('Mera SDK returned invalid PRF output.');
    }
    return prf;
  }

  Future<String> _handleCeremony(MethodCall call) async {
    try {
      final input =
          jsonDecode(call.arguments as String) as Map<String, dynamic>;
      if (call.method == 'create') {
        final rp = input['rp'] as Map<String, dynamic>;
        final user = input['user'] as Map<String, dynamic>;
        _checkRequest(rp['id'], input);
        final registered = await _authenticator.register(RegisterRequestType(
          challenge: input['challenge'] as String,
          relyingParty: RelyingPartyType(name: rp['name'] as String, id: rpId),
          user: UserType(
              displayName: user['displayName'] as String,
              name: user['name'] as String,
              id: user['id'] as String),
          excludeCredentials: const [],
          authSelectionType: AuthenticatorSelectionType(
              requireResidentKey: true,
              residentKey: 'required',
              userVerification: 'required'),
          pubKeyCredParams: [
            PubKeyCredParamType(type: 'public-key', alg: -7),
            PubKeyCredParamType(type: 'public-key', alg: -257),
          ],
          attestation: 'none',
          prf: input['prfSalt'] as String,
        ));
        if (registered.id.isEmpty) {
          throw const WalletException(
              'Passkey creation returned no credential.');
        }
        // Android plugin does not expose PRF enablement during registration.
        // Mera performs its fallback assertion and validates actual output.
        return jsonEncode({
          'credentialId': registered.id,
          'prfEnabled': true,
          'transports': <String>[],
        });
      }
      if (call.method == 'get') {
        _checkRequest(input['rpId'], input);
        final allowed = input['allowCredential'];
        final allowedId =
            allowed is Map ? allowed['credentialId'] as String? : null;
        final response =
            await _authenticator.authenticate(AuthenticateRequestType(
          relyingPartyId: rpId,
          challenge: input['challenge'] as String,
          mediation: MediationType.Required,
          preferImmediatelyAvailableCredentials: false,
          userVerification: 'required',
          prf: input['prfSalt'] as String,
          allowCredentials: allowedId == null
              ? null
              : [
                  CredentialType(
                      type: 'public-key', id: allowedId, transports: const [])
                ],
        ));
        if (allowedId != null && response.id != allowedId) {
          throw const WalletException('Unexpected passkey credential.');
        }
        final prf = response.clientExtensionResults?['prf'];
        final results = prf is Map ? prf['results'] : null;
        final first = results is Map ? results['first'] : null;
        return jsonEncode({
          'credentialId': response.id,
          if (first is String) 'prfOutput': first,
        });
      }
      throw const WalletException('Unsupported Mera ceremony.');
    } catch (_) {
      // Never send exception details or passkey data to platform logs.
      return jsonEncode({'error': 'PASSKEY_OPERATION_FAILED'});
    }
  }

  void _checkRequest(Object? requestedRp, Map<String, dynamic> input) {
    if (requestedRp != rpId ||
        input['userVerification'] != 'required' ||
        input['prfSalt'] != _encode(meraPrfSalt)) {
      throw const WalletException('Unexpected Mera passkey request.');
    }
  }

  static Uint8List _decode(String value) =>
      Uint8List.fromList(base64Url.decode(base64Url.normalize(value)));
  static String _encode(Uint8List value) =>
      base64Url.encode(value).replaceAll('=', '');
}
