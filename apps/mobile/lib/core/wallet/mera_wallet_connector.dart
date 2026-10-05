import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:passkeys/authenticator.dart';
import 'package:passkeys/types.dart';
import 'package:web3dart/crypto.dart';
import 'package:web3dart/web3dart.dart';

import 'mera_derivation.dart';
import 'wallet_types.dart';

/// Mera-compatible passkey wallet for native builds.
///
/// PRF output remains in process memory only long enough to derive account 0.
/// The derived key is held by this connector until [dispose] and is never sent
/// to Eyeler or persisted.
class MeraWalletConnector implements WalletConnector {
  MeraWalletConnector({PasskeyAuthenticator? authenticator})
      : _authenticator = authenticator ?? PasskeyAuthenticator();

  static const _rpId = String.fromEnvironment('EYELER_MERA_RP_ID',
      defaultValue: 'app.eyeler.xyz');
  static const _rpName = 'EYELER';
  static const _chainId = 10143;
  final PasskeyAuthenticator _authenticator;
  EthPrivateKey? _key;

  @override
  Future<WalletConnection> connect() async {
    dispose();
    final prf = await _authenticateOrRegister();
    try {
      _key = _keyFromPrf(prf);
    } finally {
      prf.fillRange(0, prf.length, 0);
    }
    return WalletConnection(address: _key!.address.hexEip55, chainId: _chainId);
  }

  @override
  Future<String> signMessage(String address, String message) async {
    final key = _key;
    if (key == null ||
        key.address.hexEip55.toLowerCase() != address.toLowerCase()) {
      throw const WalletException('Connect Mera passkey before signing.');
    }
    final signature = key.signPersonalMessageToUint8List(
        Uint8List.fromList(utf8.encode(message)),
        chainId: _chainId);
    return bytesToHex(signature, include0x: true);
  }

  @override
  Future<String> signTypedData(
      String address, Map<String, Object?> typedData) async {
    throw const WalletException(
        'Mera typed-data signing is unavailable until Perpl enrollment is enabled.');
  }

  @override
  void dispose() {
    final key = _key;
    if (key != null) key.privateKey.fillRange(0, key.privateKey.length, 0);
    _key = null;
  }

  Future<Uint8List> _authenticateOrRegister() async {
    final challenge = _randomBytes(32);
    final encodedChallenge = _encode(challenge);
    try {
      final response =
          await _authenticator.authenticate(AuthenticateRequestType(
        relyingPartyId: _rpId,
        challenge: encodedChallenge,
        mediation: MediationType.Required,
        preferImmediatelyAvailableCredentials: false,
        userVerification: 'required',
        prf: _encode(meraPrfSalt),
      ));
      return _prfFromResponse(response.clientExtensionResults);
    } on NoCredentialsAvailableException {
      final userId = _randomBytes(32);
      await _authenticator.register(RegisterRequestType(
        challenge: encodedChallenge,
        relyingParty: RelyingPartyType(name: _rpName, id: _rpId),
        user: UserType(
            displayName: 'EYELER user', name: 'eyeler', id: _encode(userId)),
        excludeCredentials: const [],
        pubKeyCredParams: [
          PubKeyCredParamType(type: 'public-key', alg: -7),
          PubKeyCredParamType(type: 'public-key', alg: -257),
        ],
        attestation: 'none',
        prf: _encode(meraPrfSalt),
      ));
      final response =
          await _authenticator.authenticate(AuthenticateRequestType(
        relyingPartyId: _rpId,
        challenge: _encode(_randomBytes(32)),
        mediation: MediationType.Required,
        preferImmediatelyAvailableCredentials: false,
        userVerification: 'required',
        prf: _encode(meraPrfSalt),
      ));
      return _prfFromResponse(response.clientExtensionResults);
    }
  }

  Uint8List _prfFromResponse(Map<String?, Object?>? extensions) {
    final prf = extensions?['prf'];
    final results = prf is Map ? prf['results'] : null;
    final first = results is Map ? results['first'] : null;
    if (first is! String || first.isEmpty) {
      throw const WalletException(
          'This device passkey does not support Mera PRF.');
    }
    try {
      return base64Url.decode(base64Url.normalize(first));
    } catch (_) {
      throw const WalletException('Mera passkey returned invalid PRF data.');
    }
  }

  EthPrivateKey _keyFromPrf(Uint8List prf) {
    try {
      return deriveMeraKey(prf);
    } on ArgumentError {
      throw const WalletException('Mera PRF output must be 32 bytes.');
    } on StateError catch (error) {
      throw WalletException(error.message);
    }
  }

  static Uint8List _randomBytes(int length) {
    final random = Random.secure();
    return Uint8List.fromList(
        List<int>.generate(length, (_) => random.nextInt(256)));
  }

  static String _encode(Uint8List bytes) =>
      base64Url.encode(bytes).replaceAll('=', '');
}
