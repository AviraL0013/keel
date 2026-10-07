import 'dart:typed_data';

import 'package:eyeler_mobile/features/capital/presentation/mon_balance.dart';
import 'package:eyeler_mobile/core/wallet/mera_transaction.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

class BalanceRpc implements MeraTransactionRpc {
  int network = 143;
  BigInt balance = BigInt.parse('1234567890000000000');
  @override
  Future<int> chainId() async => network;
  @override
  Future<BigInt> nativeBalance(String address) async => balance;
  @override
  Future<BigInt> baseFeePerGas() => throw UnimplementedError();
  @override
  Future<BigInt> priorityFeePerGas() => throw UnimplementedError();
  @override
  Future<BigInt> estimateGas(String from, String to, Uint8List data) =>
      throw UnimplementedError();
  @override
  Future<int> pendingNonce(String address) => throw UnimplementedError();
  @override
  Future<String> sendRawTransaction(String signed) =>
      throw UnimplementedError();
}

void main() {
  test('reads exact MON balance only from chain 143', () async {
    final rpc = BalanceRpc();
    expect(await readMainnetMonBalance(rpc, '0x${'11' * 20}'), '1.23456789');
    rpc.network = 10143;
    await expectLater(readMainnetMonBalance(rpc, '0x${'11' * 20}'),
        throwsA(isA<StateError>()));
  });
  for (final width in [320.0, 360.0]) {
    testWidgets('MON balance and gas warning fit ${width.toInt()} dp',
        (tester) async {
      tester.view.physicalSize = Size(width, 700);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await tester.pumpWidget(const MaterialApp(
          home: Scaffold(
              body: MonBalanceTile(amount: '0.00001', lowForGas: true))));
      expect(find.textContaining('0.00001 MON'), findsOneWidget);
      expect(find.textContaining('network fees'), findsWidgets);
      expect(tester.takeException(), isNull);
    });
  }
}
