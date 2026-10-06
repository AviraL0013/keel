import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:passkeys/authenticator.dart';
import 'package:passkeys/types.dart';
import 'package:web3dart/crypto.dart';
import 'package:web3dart/web3dart.dart';

import 'mera_derivation.dart';
import 'perpl_enrollment_signing.dart';
import 'wallet_types.dart';

enum MeraNetwork { testnet, mainnet }

/// Mera-compatible passkey wallet for native builds.
///
/// PRF output remains in process memory only long enough to derive account 0.
/// The derived key is held by this connector until [dispose] and is never sent
/// to Eyeler or persisted.
class MeraWalletConnector extends WalletConnector {
  MeraWalletConnector(
      {PasskeyAuthenticator? authenticator,
      DateTime Function()? now,
      MeraNetwork network = const String.fromEnvironment('EYELER_DEPLOYMENT',
                  defaultValue: 'testnet') ==
              'mainnet'
          ? MeraNetwork.mainnet
          : MeraNetwork.testnet})
      : _authenticator = authenticator ?? PasskeyAuthenticator(),
        _chainId = network == MeraNetwork.mainnet ? 143 : 10143,
        _now = now ?? DateTime.now;

  static const _rpId = String.fromEnvironment('EYELER_MERA_RP_ID',
      defaultValue: 'app.eyeler.xyz');
  static const _rpName = 'EYELER';
  final int _chainId;
  final PasskeyAuthenticator _authenticator;
  final DateTime Function() _now;
  EthPrivateKey? _key;
  int _generation = 0;

  @override
  Future<WalletConnection> connect() async {
    dispose();
    final generation = _generation;
    final prf = await _authenticate();
    try {
      _assertCurrent(generation);
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
        Uint8List.fromList(utf8.encode(message)));
    return bytesToHex(signature, include0x: true);
  }

  @override
  Future<String> signTypedData(
      String address, Map<String, Object?> typedData) async {
    final key = _key;
    if (key == null ||
        key.address.hexEip55.toLowerCase() != address.toLowerCase()) {
      throw const WalletException('Connect Mera passkey before signing.');
    }
    final preimage = perplEnrollmentPreimage(typedData,
        address: address,
        chainId: _chainId,
        origin: 'https://$_rpId',
        now: _now());
    return bytesToHex(key.signToUint8List(preimage), include0x: true);
  }

  @override
  void dispose() {
    _generation++;
    final key = _key;
    if (key != null) key.privateKey.fillRange(0, key.privateKey.length, 0);
    _key = null;
  }

  void _assertCurrent(int generation) {
    if (generation != _generation) {
      throw const WalletException('Passkey request expired. Sign in again.');
    }
  }

  @override
  bool get supportsAccountCreation => true;

  @override
  Future<WalletConnection> createAccount() async {
    dispose();
    final generation = _generation;
    final registered = await _authenticator.register(RegisterRequestType(
      challenge: _encode(_randomBytes(32)),
      relyingParty: RelyingPartyType(name: _rpName, id: _rpId),
      user: UserType(
          displayName: 'EYELER user',
          name: 'eyeler',
          id: _encode(_randomBytes(32))),
      excludeCredentials: const [],
      authSelectionType: AuthenticatorSelectionType(
          requireResidentKey: true,
          residentKey: 'required',
          userVerification: 'required'),
      pubKeyCredParams: [
        PubKeyCredParamType(type: 'public-key', alg: -7),
        PubKeyCredParamType(type: 'public-key', alg: -257)
      ],
      attestation: 'none',
      prf: _encode(meraPrfSalt),
    ));
    _assertCurrent(generation);
    if (registered.id.isEmpty) {
      throw const WalletException('Passkey creation returned no credential.');
    }
    final prf = await _authenticate(credentialId: registered.id);
    try {
      _assertCurrent(generation);
      _key = _keyFromPrf(prf);
    } finally {
      prf.fillRange(0, prf.length, 0);
    }
    return WalletConnection(address: _key!.address.hexEip55, chainId: _chainId);
  }

  Future<Uint8List> _authenticate({String? credentialId}) async {
    final response = await _authenticator.authenticate(AuthenticateRequestType(
      relyingPartyId: _rpId,
      challenge: _encode(_randomBytes(32)),
      mediation: MediationType.Required,
      preferImmediatelyAvailableCredentials: false,
      userVerification: 'required',
      prf: _encode(meraPrfSalt),
      allowCredentials: credentialId == null
          ? null
          : [
              CredentialType(
                  type: 'public-key', id: credentialId, transports: const [])
            ],
    ));
    if (credentialId != null && response.id != credentialId) {
      throw const WalletException(
          'Passkey response did not match the new wallet credential.');
    }
    return _prfFromResponse(response.clientExtensionResults);
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
