import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

import 'wallet_types.dart';

abstract class MeraTransactionRpc {
  Future<int> chainId();
  Future<int> pendingNonce(String address);
  Future<BigInt> estimateGas(String from, String to, Uint8List data);
  Future<BigInt> baseFeePerGas();
  Future<BigInt> priorityFeePerGas();
  Future<BigInt> nativeBalance(String address);
  Future<String> sendRawTransaction(String signed);
}

abstract class MeraTransactionActions {
  Future<MeraTransactionQuote> prepareTransaction({
    required MeraTransactionRpc rpc,
    required String contract,
    required String function,
    required String exactAmount,
    required Uint8List data,
  });
  Future<String> confirmAndSendTransaction({
    required MeraTransactionQuote quote,
    required MeraTransactionRpc rpc,
    required Future<bool> Function(MeraTransactionQuote) confirm,
  });
}

/// Monad mainnet only. All RPC writes pass through explicit transaction confirmation.
class MonadMainnetRpc implements MeraTransactionRpc {
  MonadMainnetRpc(this.client);
  final http.Client client;
  static final uri = Uri.parse('https://rpc.monad.xyz');
  int _id = 0;

  Future<Object?> _call(String method, List<Object?> params) async {
    final response = await client.post(uri,
        headers: {'content-type': 'application/json'},
        body: jsonEncode({
          'jsonrpc': '2.0',
          'id': ++_id,
          'method': method,
          'params': params,
        }));
    if (response.statusCode != 200) {
      throw const WalletException('Monad RPC unavailable.');
    }
    final body = jsonDecode(response.body);
    if (body is! Map || body['error'] != null || body['result'] == null) {
      throw const WalletException('Monad RPC returned no usable result.');
    }
    return body['result'];
  }

  BigInt _quantity(Object? value) {
    if (value is! String || !RegExp(r'^0x[0-9a-fA-F]+$').hasMatch(value)) {
      throw const WalletException('Monad RPC returned an invalid quantity.');
    }
    return BigInt.parse(value.substring(2), radix: 16);
  }

  @override
  Future<int> chainId() async =>
      _quantity(await _call('eth_chainId', const [])).toInt();

  @override
  Future<int> pendingNonce(String address) async =>
      _quantity(await _call('eth_getTransactionCount', [address, 'pending']))
          .toInt();

  @override
  Future<BigInt> estimateGas(String from, String to, Uint8List data) async =>
      _quantity(await _call('eth_estimateGas', [
        {'from': from, 'to': to, 'data': '0x${_hex(data)}', 'value': '0x0'}
      ]));

  @override
  Future<BigInt> baseFeePerGas() async {
    final block = await _call('eth_getBlockByNumber', ['latest', false]);
    if (block is! Map) {
      throw const WalletException('Monad base fee unavailable.');
    }
    return _quantity(block['baseFeePerGas']);
  }

  @override
  Future<BigInt> priorityFeePerGas() async =>
      _quantity(await _call('eth_maxPriorityFeePerGas', const []));

  @override
  Future<BigInt> nativeBalance(String address) async =>
      _quantity(await _call('eth_getBalance', [address, 'latest']));

  @override
  Future<String> sendRawTransaction(String signed) async {
    final result = await _call('eth_sendRawTransaction', [signed]);
    if (result is! String || !RegExp(r'^0x[0-9a-fA-F]{64}$').hasMatch(result)) {
      throw const WalletException('Monad transaction hash unavailable.');
    }
    return result;
  }
}

String _hex(Uint8List bytes) =>
    bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();

class MeraTransactionQuote {
  MeraTransactionQuote({
    required this.address,
    required this.chainId,
    required this.contract,
    required this.function,
    required this.exactAmount,
    required Uint8List data,
    required this.nonce,
    required this.gasLimit,
    required this.maxFeePerGas,
    required this.priorityFeePerGas,
    required this.generation,
  }) : _data = Uint8List.fromList(data);
  final String address;
  final int chainId;
  final String contract;
  final String function;
  final String exactAmount;
  final Uint8List _data;
  Uint8List get data => Uint8List.fromList(_data);
  final int nonce;
  final int gasLimit;
  final BigInt maxFeePerGas;
  final BigInt priorityFeePerGas;
  final int generation;

  BigInt get maximumFeeWei => BigInt.from(gasLimit) * maxFeePerGas;
  String get maximumFeeMon {
    final wei = maximumFeeWei;
    final units = BigInt.from(10).pow(18);
    final whole = wei ~/ units;
    final fraction = (wei % units).toString().padLeft(18, '0');
    final trimmed = fraction.replaceFirst(RegExp(r'0+$'), '');
    return trimmed.isEmpty ? '$whole' : '$whole.$trimmed';
  }
}
