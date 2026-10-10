import 'dart:convert';
import 'dart:typed_data';

import 'package:web3dart/crypto.dart';

import 'wallet_types.dart';

const _domainFields = [
  ['name', 'string'],
  ['version', 'string'],
  ['chainId', 'uint256'],
  ['verifyingContract', 'address'],
  ['salt', 'bytes32'],
];
const _messageFields = [
  ['signer', 'address'],
  ['statement', 'string'],
  ['publicKey', 'string'],
  ['scope', 'string'],
  ['label', 'string'],
  ['expiresAt', 'string'],
  ['ipCidrs', 'string'],
  ['origin', 'string'],
  ['builderId', 'string'],
  ['maxBuilderFeePer100K', 'string'],
  ['time', 'uint64'],
];

/// A deliberately restricted EIP-712 signer: no permit, transfer or arbitrary
/// contract calls. Fields follow Perpl's observed PerplRegisterApiKey schema.
Uint8List perplEnrollmentPreimage(
  Map<String, Object?> typed, {
  required String address,
  required int chainId,
  required String origin,
  required DateTime now,
}) {
  try {
    final domain = Map<String, dynamic>.from(typed['domain'] as Map);
    final message = Map<String, dynamic>.from(typed['message'] as Map);
    final types = typed['types'] as Map;
    if (!_keys(typed, ['domain', 'types', 'primaryType', 'message']) ||
        typed['primaryType'] != 'PerplRegisterApiKey' ||
        !_keys(types, ['EIP712Domain', 'PerplRegisterApiKey']) ||
        !_keys(domain, _domainFields.map((f) => f[0]).toList()) ||
        !_keys(message, _messageFields.map((f) => f[0]).toList())) {
      throw const FormatException();
    }
    _validateFields(types['EIP712Domain'], _domainFields, unordered: true);
    _validateFields(types['PerplRegisterApiKey'], _messageFields);
    if (![10143, 143].contains(chainId) ||
        domain['name'] != 'perpl.xyz' ||
        domain['version'] != '1' ||
        BigInt.parse('${domain['chainId']}') != BigInt.from(chainId) ||
        domain['verifyingContract'] != '0x${'00' * 20}' ||
        !RegExp(r'^0x[0-9a-fA-F]{64}$').hasMatch('${domain['salt']}')) {
      throw const FormatException();
    }
    if ('${message['signer']}'.toLowerCase() != address.toLowerCase() ||
        message['scope'] != '3' ||
        message['label'] != 'EYELER' ||
        message['origin'] != origin ||
        message['ipCidrs'] != '' ||
        !_validPublicKey(message['publicKey']) ||
        message['maxBuilderFeePer100K'] != '0' ||
        !['0', '25'].contains(message['builderId'])) {
      throw const FormatException();
    }
    final statement = message['builderId'] == '25'
        ? 'Authorize Eyeler (builder code 25) to place orders from this wallet and to charge a builder fee of up to 0.000% per order. This does not permit withdrawals.'
        : 'I authorize the creation of Perpl API key with the specified scope and parameters';
    if (message['statement'] != statement) throw const FormatException();
    final milliseconds = BigInt.from(now.millisecondsSinceEpoch);
    final issued = BigInt.parse('${message['time']}');
    final expires = BigInt.parse('${message['expiresAt']}');
    if (issued < milliseconds - BigInt.from(600000) ||
        issued > milliseconds + BigInt.from(30000) ||
        expires <= milliseconds ||
        expires > milliseconds + BigInt.from(90 * 86400000 + 30000)) {
      throw const FormatException();
    }
    return Uint8List.fromList([
      0x19,
      0x01,
      ..._hashStruct('EIP712Domain', _domainFields, domain),
      ..._hashStruct('PerplRegisterApiKey', _messageFields, message),
    ]);
  } catch (_) {
    throw const WalletException(
        'Perpl enrollment terms do not match this wallet, network or zero-fee permission.');
  }
}

bool _validPublicKey(Object? value) {
  if (value is! String) return false;
  if (RegExp(r'^0x[0-9a-fA-F]{64}$').hasMatch(value)) return true;
  if (!RegExp(r'^[A-Za-z0-9_-]{43}$').hasMatch(value)) return false;
  final bytes = base64Url.decode(base64Url.normalize(value));
  return bytes.length == 32 &&
      base64Url.encode(bytes).replaceAll('=', '') == value;
}

bool _keys(Map object, List<String> names) =>
    object.length == names.length && names.every(object.containsKey);

void _validateFields(Object? actual, List<List<String>> expected,
    {bool unordered = false}) {
  if (actual is! List || actual.length != expected.length) {
    throw const FormatException();
  }
  bool matches(Object? entry, List<String> field) =>
      entry is Map &&
      _keys(entry, ['name', 'type']) &&
      entry['name'] == field[0] &&
      entry['type'] == field[1];
  for (var i = 0; i < expected.length; i++) {
    if (unordered
        ? actual.where((e) => matches(e, expected[i])).length != 1
        : !matches(actual[i], expected[i])) {
      throw const FormatException();
    }
  }
}

Uint8List _hashStruct(
    String name, List<List<String>> fields, Map<String, dynamic> values) {
  final encoded = BytesBuilder();
  encoded.add(
      keccakUtf8('$name(${fields.map((f) => '${f[1]} ${f[0]}').join(',')})'));
  for (final field in fields) {
    final value = values[field[0]];
    switch (field[1]) {
      case 'string':
        if (value is! String) throw const FormatException();
        encoded.add(keccak256(Uint8List.fromList(utf8.encode(value))));
      case 'address':
        if (value is! String ||
            !RegExp(r'^0x[0-9a-fA-F]{40}$').hasMatch(value)) {
          throw const FormatException();
        }
        encoded.add([...List<int>.filled(12, 0), ...hexToBytes(value)]);
      case 'bytes32':
        final bytes = hexToBytes(value as String);
        if (bytes.length != 32) throw const FormatException();
        encoded.add(bytes);
      default:
        final integer = BigInt.parse('$value');
        final bits = int.parse(field[1].substring(4));
        if (integer.isNegative || integer >= (BigInt.one << bits)) {
          throw const FormatException();
        }
        encoded.add(hexToBytes(integer.toRadixString(16).padLeft(64, '0')));
    }
  }
  return keccak256(encoded.toBytes());
}
