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

  test('rejects PRF output with the wrong length', () {
    expect(() => deriveMeraKey(Uint8List(31)), throwsArgumentError);
  });
}
