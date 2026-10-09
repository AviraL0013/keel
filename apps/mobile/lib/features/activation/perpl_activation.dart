import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;
import 'package:web3dart/crypto.dart';

import '../../core/wallet/wallet_types.dart';

const perplMainnetExchange = '0x34B6552d57a35a1D042CcAe1951BD1C370112a6F';
const monadMainnetAusd = '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a';

class PerplActivationContext {
  const PerplActivationContext._(
      {required this.exchange,
      required this.ausd,
      required this.minimumDepositMicros});
  final String exchange;
  final String ausd;
  final BigInt minimumDepositMicros;

  factory PerplActivationContext.fromJson(Map<String, dynamic> json) {
    try {
      final chain = Map<String, dynamic>.from(json['chain'] as Map);
      final instances = (json['instances'] as List).whereType<Map>();
      final instance = instances
          .map((item) => Map<String, dynamic>.from(item))
          .singleWhere((item) => item['id'] == 1);
      final tokens = (json['tokens'] as List).whereType<Map>();
      final token = tokens
          .map((item) => Map<String, dynamic>.from(item))
          .singleWhere((item) => item['id'] == instance['collateral_token_id']);
      final minimum =
          BigInt.parse(instance['min_account_open_amount'] as String);
      if (chain['chain_id'] != 143 ||
          (instance['address'] as String).toLowerCase() !=
              perplMainnetExchange.toLowerCase() ||
          (token['address'] as String).toLowerCase() !=
              monadMainnetAusd.toLowerCase() ||
          token['symbol'] != 'AUSD' ||
          token['decimals'] != 6 ||
          minimum < BigInt.from(10000000)) {
        throw const WalletException('Perpl mainnet context mismatch.');
      }
      return PerplActivationContext._(
          exchange: perplMainnetExchange,
          ausd: monadMainnetAusd,
          minimumDepositMicros: minimum);
    } on WalletException {
      rethrow;
    } catch (_) {
      throw const WalletException('Perpl mainnet context unavailable.');
    }
  }
}

class LoadedPerplActivation {
  const LoadedPerplActivation(this.context, this.state);
  final PerplActivationContext context;
  final PerplActivationState state;
}

enum ActivationReceipt { pending, success, reverted }

/// Reads public Perpl context and Monad chain state. No key or signature is sent.
class PerplActivationGateway {
  PerplActivationGateway(this.client);
  final http.Client client;
  static final contextUri =
      Uri.parse('https://app.perpl.xyz/api/v1/pub/context');
  static final rpcUri = Uri.parse('https://rpc.monad.xyz');
  int _id = 0;

  Future<PerplActivationContext> _context() async {
    final response = await client.get(contextUri);
    if (response.statusCode != 200) {
      throw WalletException('Perpl context HTTP ${response.statusCode}.');
    }
    final body = jsonDecode(response.body);
    if (body is! Map) {
      throw const WalletException('Perpl context unavailable.');
    }
    return PerplActivationContext.fromJson(Map<String, dynamic>.from(body));
  }

  Future<Object?> _rpc(String method, List<Object?> params,
      {bool noAccountRevert = false, bool allowNull = false}) async {
    final response = await client.post(rpcUri,
        headers: {'content-type': 'application/json'},
        body: jsonEncode({
          'jsonrpc': '2.0',
          'id': ++_id,
          'method': method,
          'params': params
        }));
    if (response.statusCode != 200) {
      throw WalletException('Monad RPC HTTP ${response.statusCode}.');
    }
    final body = jsonDecode(response.body);
    if (body is! Map) throw const WalletException('Monad RPC unavailable.');
    final error = body['error'];
    if (noAccountRevert &&
        error is Map &&
        (error['code'] == -32000 || error['code'] == 3) &&
        error['message'] == 'execution reverted') {
      return null;
    }
    if (error != null || (body['result'] == null && !allowNull)) {
      throw const WalletException('Monad RPC returned no usable result.');
    }
    return body['result'];
  }

  Future<ActivationReceipt> receipt(String hash) async {
    if (!RegExp(r'^0x[0-9a-fA-F]{64}$').hasMatch(hash)) {
      throw const WalletException('Invalid transaction hash.');
    }
    final result =
        await _rpc('eth_getTransactionReceipt', [hash], allowNull: true);
    if (result == null) return ActivationReceipt.pending;
    if (result is! Map ||
        (result['transactionHash'] as String?)?.toLowerCase() !=
            hash.toLowerCase()) {
      throw const WalletException('Monad receipt invalid.');
    }
    return switch (result['status']) {
      '0x1' => ActivationReceipt.success,
      '0x0' => ActivationReceipt.reverted,
      _ => throw const WalletException('Monad receipt status unavailable.'),
    };
  }

  BigInt _quantity(Object? value) {
    if (value is! String || !RegExp(r'^0x[0-9a-fA-F]+$').hasMatch(value)) {
      throw const WalletException('Monad RPC returned invalid chain data.');
    }
    return BigInt.parse(value.substring(2), radix: 16);
  }

  Future<LoadedPerplActivation> load(String address,
      {bool? forwardingEnabled, bool pendingTransaction = false}) async {
    if (!RegExp(r'^0x[0-9a-fA-F]{40}$').hasMatch(address)) {
      throw const WalletException('Invalid Mera wallet address.');
    }
    final context = await _context();
    if (_quantity(await _rpc('eth_chainId', const [])) != BigInt.from(143)) {
      throw const WalletException('Monad mainnet chain 143 required.');
    }
    final balance = _quantity(await _rpc('eth_call', [
      {
        'to': context.ausd,
        'data':
            '0x${_selector('balanceOf(address)').substring(2)}${_addressWord(address)}'
      },
      'latest'
    ]));
    final allowance = _quantity(await _rpc('eth_call', [
      {
        'to': context.ausd,
        'data':
            '0x${_selector('allowance(address,address)').substring(2)}${_addressWord(address)}${_addressWord(context.exchange)}'
      },
      'latest'
    ]));
    final rawAccount = await _rpc(
        'eth_call',
        [
          {
            'from': address,
            'to': context.exchange,
            'data':
                '0x${_selector('getAccountByAddr(address)').substring(2)}${_addressWord(address)}'
          },
          'latest'
        ],
        noAccountRevert: true);
    final account = rawAccount == null ? BigInt.zero : _quantity(rawAccount);
    if (account > BigInt.from(0x7fffffff)) {
      throw const WalletException('Perpl account ID unavailable.');
    }
    return LoadedPerplActivation(
        context,
        PerplActivationState(
            accountId: account == BigInt.zero ? null : account.toInt(),
            ausdMicros: balance,
            allowanceMicros: allowance,
            forwardingEnabled: forwardingEnabled,
            pendingTransaction: pendingTransaction));
  }
}

enum ActivationStep {
  waitForReceipt,
  needsAusd,
  approve,
  createAccount,
  connectPerpl,
  enableForwarding,
  ready,
}

class PerplActivationState {
  const PerplActivationState({
    required this.accountId,
    required this.ausdMicros,
    required this.allowanceMicros,
    required this.forwardingEnabled,
    required this.pendingTransaction,
  });
  final int? accountId;
  final BigInt ausdMicros;
  final BigInt allowanceMicros;
  final bool? forwardingEnabled;
  final bool pendingTransaction;
}

/// Reconcile the signed Perpl wallet snapshot with the independent chain read.
bool? verifyPerplAccountState(
    Map<String, dynamic> remote, PerplActivationState chainState) {
  switch (remote['status']) {
    case 'NOT_CONNECTED':
      return null;
    case 'NO_ACCOUNT':
      if (chainState.accountId != null) {
        throw StateError('Perpl account identity mismatch.');
      }
      return null;
    case 'AVAILABLE':
      final accountId = remote['accountId'];
      final forwarding = remote['forwardingEnabled'];
      if (accountId is! int ||
          accountId <= 0 ||
          accountId != chainState.accountId ||
          forwarding is! bool) {
        throw StateError('Perpl account identity mismatch.');
      }
      return forwarding;
    default:
      throw StateError('Perpl account state unavailable.');
  }
}

ActivationStep planPerplActivation(
    PerplActivationContext context, PerplActivationState state) {
  if (state.pendingTransaction) return ActivationStep.waitForReceipt;
  if (state.accountId == null) {
    if (state.ausdMicros < context.minimumDepositMicros) {
      return ActivationStep.needsAusd;
    }
    if (state.allowanceMicros < context.minimumDepositMicros) {
      return ActivationStep.approve;
    }
    return ActivationStep.createAccount;
  }
  if (state.accountId! <= 0) {
    throw const WalletException('Perpl account state unavailable.');
  }
  if (state.forwardingEnabled == null) return ActivationStep.connectPerpl;
  return state.forwardingEnabled!
      ? ActivationStep.ready
      : ActivationStep.enableForwarding;
}

class ActivationCall {
  const ActivationCall(
      {required this.contract,
      required this.function,
      required this.exactAmount,
      required this.dataHex});
  final String contract;
  final String function;
  final String exactAmount;
  final String dataHex;
  Uint8List get data => hexToBytes(dataHex);
}

String _word(BigInt value) => value.toRadixString(16).padLeft(64, '0');
String _addressWord(String address) =>
    address.substring(2).toLowerCase().padLeft(64, '0');
String _selector(String signature) =>
    '0x${keccakUtf8(signature).take(4).map((byte) => byte.toRadixString(16).padLeft(2, '0')).join()}';
String _ausd(BigInt micros) {
  final whole = micros ~/ BigInt.from(1000000);
  final fractional = (micros % BigInt.from(1000000))
      .toString()
      .padLeft(6, '0')
      .replaceFirst(RegExp(r'0+$'), '');
  return fractional.isEmpty ? '$whole' : '$whole.$fractional';
}

ActivationCall activationCall(
    PerplActivationContext context, ActivationStep step) {
  final amount = context.minimumDepositMicros;
  switch (step) {
    case ActivationStep.approve:
      return ActivationCall(
          contract: context.ausd,
          function: 'approve(address,uint256)',
          exactAmount: '${_ausd(amount)} AUSD',
          dataHex:
              '0x${_selector('approve(address,uint256)').substring(2)}${_addressWord(context.exchange)}${_word(amount)}');
    case ActivationStep.createAccount:
      return ActivationCall(
          contract: context.exchange,
          function: 'createAccount(uint256)',
          exactAmount: '${_ausd(amount)} AUSD',
          dataHex:
              '0x${_selector('createAccount(uint256)').substring(2)}${_word(amount)}');
    case ActivationStep.enableForwarding:
      return ActivationCall(
          contract: context.exchange,
          function: 'allowOrderForwarding(bool)',
          exactAmount: '0 AUSD',
          dataHex:
              '0x${_selector('allowOrderForwarding(bool)').substring(2)}${_word(BigInt.one)}');
    default:
      throw const WalletException('No transaction for this activation state.');
  }
}
