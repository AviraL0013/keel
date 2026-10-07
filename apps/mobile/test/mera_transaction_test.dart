import 'dart:typed_data';

import 'package:eyeler_mobile/core/wallet/mera_transaction.dart';
import 'package:eyeler_mobile/core/wallet/mera_wallet_connector.dart';
import 'package:flutter_test/flutter_test.dart';

import 'mera_wallet_connector_test.dart' show FixtureAuthenticator;

class FakeRpc implements MeraTransactionRpc {
  int network = 143;
  int sends = 0;
  String? raw;
  BigInt balance = BigInt.from(10).pow(18);

  @override
  Future<int> chainId() async => network;
  @override
  Future<int> pendingNonce(String address) async => 5;
  @override
  Future<BigInt> estimateGas(String from, String to, Uint8List data) async =>
      BigInt.from(50000);
  @override
  Future<BigInt> baseFeePerGas() async => BigInt.from(500000000);
  @override
  Future<BigInt> priorityFeePerGas() async => BigInt.from(1000000000);
  @override
  Future<BigInt> nativeBalance(String address) async => balance;
  @override
  Future<String> sendRawTransaction(String signed) async {
    sends++;
    raw = signed;
    return '0x${'aa' * 32}';
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test('Mera signs EIP-1559 Monad 143 transaction matching viem vector',
      () async {
    final wallet = MeraWalletConnector(
        authenticator: FixtureAuthenticator(), network: MeraNetwork.mainnet);
    await wallet.connect();
    final rpc = FakeRpc();
    final quote = await wallet.prepareTransaction(
      rpc: rpc,
      contract: '0x34B6552d57a35a1D042CcAe1951BD1C370112a6F',
      function: 'fixture()',
      exactAmount: '0 AUSD',
      data: Uint8List.fromList([0xab, 0xcd, 0xef, 0x12]),
    );
    expect(quote.chainId, 143);
    expect(quote.maximumFeeMon, '0.0001');
    final result = await wallet.confirmAndSendTransaction(
        quote: quote, rpc: rpc, confirm: (_) async => true);
    expect(result, '0x${'aa' * 32}');
    expect(rpc.sends, 1);
    expect(rpc.raw,
        '0x02f86f818f05843b9aca00847735940082c3509434b6552d57a35a1d042ccae1951bd1c370112a6f8084abcdef12c080a0a1833d16970a2f6820c6a1de01cefce27662ddc05326756d4f204f2e89578925a007664e0818dd09dff1d26d64234bcbbde747babfa8136e087154e51f5a1c4925');
    wallet.dispose();
  });

  test('wrong chain and rejected confirmation never send', () async {
    final wallet = MeraWalletConnector(
        authenticator: FixtureAuthenticator(), network: MeraNetwork.mainnet);
    await wallet.connect();
    final rpc = FakeRpc()..network = 10143;
    await expectLater(
        wallet.prepareTransaction(
            rpc: rpc,
            contract: '0x34B6552d57a35a1D042CcAe1951BD1C370112a6F',
            function: 'fixture()',
            exactAmount: '0 AUSD',
            data: Uint8List(0)),
        throwsException);
    rpc.network = 143;
    final quote = await wallet.prepareTransaction(
        rpc: rpc,
        contract: '0x34B6552d57a35a1D042CcAe1951BD1C370112a6F',
        function: 'fixture()',
        exactAmount: '0 AUSD',
        data: Uint8List(0));
    await expectLater(
        wallet.confirmAndSendTransaction(
            quote: quote, rpc: rpc, confirm: (_) async => false),
        throwsException);
    expect(rpc.sends, 0);
    wallet.dispose();
  });

  test('insufficient MON and mutated confirmation data never send', () async {
    final wallet = MeraWalletConnector(
        authenticator: FixtureAuthenticator(), network: MeraNetwork.mainnet);
    await wallet.connect();
    final rpc = FakeRpc()..balance = BigInt.from(99999999999999);
    await expectLater(
        wallet.prepareTransaction(
            rpc: rpc,
            contract: '0x34B6552d57a35a1D042CcAe1951BD1C370112a6F',
            function: 'fixture()',
            exactAmount: '0 AUSD',
            data: Uint8List.fromList([1])),
        throwsException);
    rpc.balance = BigInt.from(10).pow(18);
    final quote = await wallet.prepareTransaction(
        rpc: rpc,
        contract: '0x34B6552d57a35a1D042CcAe1951BD1C370112a6F',
        function: 'fixture()',
        exactAmount: '0 AUSD',
        data: Uint8List.fromList([1]));
    quote.data[0] = 2;
    expect(quote.data[0], 1);
    await wallet.confirmAndSendTransaction(
        quote: quote, rpc: rpc, confirm: (_) async => true);
    expect(rpc.sends, 1);
    wallet.dispose();
  });

  test('unprepared quote and repeat send are refused', () async {
    final wallet = MeraWalletConnector(
        authenticator: FixtureAuthenticator(), network: MeraNetwork.mainnet);
    await wallet.connect();
    final rpc = FakeRpc();
    final quote = await wallet.prepareTransaction(
        rpc: rpc,
        contract: '0x34B6552d57a35a1D042CcAe1951BD1C370112a6F',
        function: 'fixture()',
        exactAmount: '0 AUSD',
        data: Uint8List(0));
    final forged = MeraTransactionQuote(
        address: quote.address,
        chainId: quote.chainId,
        contract: quote.contract,
        function: quote.function,
        exactAmount: quote.exactAmount,
        data: quote.data,
        nonce: quote.nonce,
        gasLimit: quote.gasLimit,
        maxFeePerGas: quote.maxFeePerGas,
        priorityFeePerGas: quote.priorityFeePerGas,
        generation: quote.generation);
    await expectLater(
        wallet.confirmAndSendTransaction(
            quote: forged, rpc: rpc, confirm: (_) async => true),
        throwsException);
    expect(rpc.sends, 0);
    await wallet.confirmAndSendTransaction(
        quote: quote, rpc: rpc, confirm: (_) async => true);
    await expectLater(
        wallet.confirmAndSendTransaction(
            quote: quote, rpc: rpc, confirm: (_) async => true),
        throwsException);
    expect(rpc.sends, 1);
    wallet.dispose();
  });
}
