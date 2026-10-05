import 'dart:typed_data';

import 'package:bip32/bip32.dart';
import 'package:bip39/bip39.dart' as bip39;
import 'package:crypto/crypto.dart';
import 'package:web3dart/crypto.dart';
import 'package:web3dart/web3dart.dart';

/// The default salt used by Mera's passkey PRF integration.
final Uint8List meraPrfSalt = Uint8List.fromList(
  sha256.convert('mera.prf.salt.v1'.codeUnits).bytes,
);

EthPrivateKey deriveMeraKey(Uint8List prf) {
  if (prf.length != 32) {
    throw ArgumentError.value(prf.length, 'prf', 'must contain 32 bytes');
  }
  final mnemonic = bip39.entropyToMnemonic(bytesToHex(prf));
  final seed = bip39.mnemonicToSeed(mnemonic);
  try {
    var node = BIP32.fromSeed(seed);
    for (final index in [
      44 | 0x80000000,
      60 | 0x80000000,
      0 | 0x80000000,
      0,
      0,
    ]) {
      node = node.derive(index);
    }
    final privateKey = node.privateKey;
    if (privateKey == null) throw StateError('Mera account derivation failed');
    return EthPrivateKey(Uint8List.fromList(privateKey));
  } finally {
    seed.fillRange(0, seed.length, 0);
  }
}
