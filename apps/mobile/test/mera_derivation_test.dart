import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:eyeler_mobile/core/wallet/mera_derivation.dart';

void main() {
  test('uses the Mera salt and deterministic BIP-44 account derivation', () {
    expect(meraPrfSalt.length, 32);
    final prf = Uint8List.fromList(List<int>.generate(32, (index) => index));
    final first = deriveMeraKey(prf).address.hexEip55;
    final second = deriveMeraKey(prf).address.hexEip55;
    expect(first, second);
    expect(first, startsWith('0x'));
    expect(first.length, 42);
  });

  test('matches the Mera reference BIP-39 and EVM account-zero vector', () {
    // Public, synthetic PRF bytes 00..1f, independently derived using the
    // reference @scure/bip39 + viem BIP-44 account-zero recipe. Not a funded key.
    final prf = Uint8List.fromList(List<int>.generate(32, (index) => index));
    expect(
        meraPrfSalt
            .map((byte) => byte.toRadixString(16).padLeft(2, '0'))
            .join(),
        '896d46ac4ac191885c46137439db7bb52fb05cff3ecd34af7cdae0a1e0c00db9');
    final key = deriveMeraKey(prf);
    try {
      expect(
          key.address.hexEip55, '0xF9297b542BDb5DA50C364f9AE4Cbe1F3933bA40F');
    } finally {
      prf.fillRange(0, prf.length, 0);
      key.privateKey.fillRange(0, key.privateKey.length, 0);
    }
  });

  test('rejects PRF output with the wrong length', () {
    expect(() => deriveMeraKey(Uint8List(31)), throwsArgumentError);
  });
}
