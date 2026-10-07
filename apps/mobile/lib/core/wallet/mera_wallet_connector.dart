import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:passkeys/authenticator.dart';
import 'package:passkeys/types.dart';
import 'package:web3dart/crypto.dart';
import 'package:web3dart/web3dart.dart';

import 'mera_derivation.dart';
import 'mera_transaction.dart';
import 'perpl_enrollment_signing.dart';
import 'wallet_types.dart';

enum MeraNetwork { testnet, mainnet }

/// Mera-compatible passkey wallet for native builds.
///
/// PRF output remains in process memory only long enough to derive account 0.
/// The derived key is held by this connector until [dispose] and is never sent
/// to Eyeler or persisted.
class MeraWalletConnector extends WalletConnector
    implements MeraTransactionActions {
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
  MeraTransactionQuote? _prepared;
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
  Future<MeraTransactionQuote> prepareTransaction({
    required MeraTransactionRpc rpc,
    required String contract,
    required String function,
    required String exactAmount,
    required Uint8List data,
  }) async {
    final key = _key;
    if (key == null) throw const WalletException('Connect Mera first.');
    final generation = _generation;
    if (_chainId != 143 || await rpc.chainId() != 143) {
      throw const WalletException('Monad mainnet chain 143 required.');
    }
    final address = key.address.hexEip55;
    final to = EthereumAddress.fromHex(contract);
    final nonce = await rpc.pendingNonce(address);
    final gas = await rpc.estimateGas(address, to.hexEip55, data);
    final baseFee = await rpc.baseFeePerGas();
    final priority = await rpc.priorityFeePerGas();
    if (nonce < 0 ||
        gas <= BigInt.zero ||
        gas > BigInt.from(10000000) ||
        baseFee <= BigInt.zero ||
        priority < BigInt.zero) {
      throw const WalletException('Monad transaction estimate unavailable.');
    }
    final maxFeePerGas = baseFee * BigInt.two + priority;
    if (await rpc.nativeBalance(address) < gas * maxFeePerGas) {
      throw const WalletException(
          'Not enough MON for the maximum network fee.');
    }
    _assertCurrent(generation);
    final quote = MeraTransactionQuote(
      address: address,
      chainId: 143,
      contract: to.hexEip55,
      function: function,
      exactAmount: exactAmount,
      data: Uint8List.fromList(data),
      nonce: nonce,
      gasLimit: gas.toInt(),
      maxFeePerGas: maxFeePerGas,
      priorityFeePerGas: priority,
      generation: generation,
    );
    _prepared = quote;
    return quote;
  }

  @override
  Future<String> confirmAndSendTransaction({
    required MeraTransactionQuote quote,
    required MeraTransactionRpc rpc,
    required Future<bool> Function(MeraTransactionQuote) confirm,
  }) async {
    if (!identical(_prepared, quote)) {
      throw const WalletException('Prepare a new transaction.');
    }
    _prepared =
        null; // Consume before any await; an uncertain send is never replayed.
    _assertCurrent(quote.generation);
    if (_chainId != 143 ||
        quote.chainId != 143 ||
        _key?.address.hexEip55 != quote.address ||
        await rpc.chainId() != 143) {
      throw const WalletException('Monad mainnet wallet required.');
    }
    if (!await confirm(quote)) {
      throw const WalletException('Transaction cancelled.');
    }
    _assertCurrent(quote.generation);
    if (await rpc.chainId() != 143) {
      throw const WalletException('Monad mainnet chain changed.');
    }
    if (await rpc.nativeBalance(quote.address) < quote.maximumFeeWei) {
      throw const WalletException(
          'Not enough MON for the maximum network fee.');
    }
    final transaction = Transaction(
      from: _key!.address,
      to: EthereumAddress.fromHex(quote.contract),
      value: EtherAmount.zero(),
      data: quote.data,
      nonce: quote.nonce,
      maxGas: quote.gasLimit,
      maxFeePerGas: EtherAmount.inWei(quote.maxFeePerGas),
      maxPriorityFeePerGas: EtherAmount.inWei(quote.priorityFeePerGas),
    );
    final signed = prependTransactionType(
        0x02, signTransactionRaw(transaction, _key!, chainId: 143));
    return rpc.sendRawTransaction(bytesToHex(signed, include0x: true));
  }

  @override
  void dispose() {
    _generation++;
    _prepared = null;
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
    final accountLabel =
        'EYELER ${DateTime.now().toIso8601String().substring(0, 16)} ${_encode(_randomBytes(3))}';
    final registered = await _authenticator.register(RegisterRequestType(
      challenge: _encode(_randomBytes(32)),
      relyingParty: RelyingPartyType(name: _rpName, id: _rpId),
      user: UserType(
          displayName: accountLabel,
          name: accountLabel,
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
