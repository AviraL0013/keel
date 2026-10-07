import 'package:eyeler_mobile/features/activation/perpl_activation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'dart:convert';

const exchange = '0x34B6552d57a35a1D042CcAe1951BD1C370112a6F';
const token = '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a';

void main() {
  final context = PerplActivationContext.fromJson({
    'chain': {'chain_id': 143},
    'instances': [
      {
        'id': 1,
        'address': exchange,
        'collateral_token_id': 1,
        'min_account_open_amount': '10000000'
      }
    ],
    'tokens': [
      {'id': 1, 'address': token, 'symbol': 'AUSD', 'decimals': 6}
    ]
  });
  test('strict Perpl mainnet context rejects wrong chain or contract', () {
    expect(context.minimumDepositMicros, BigInt.from(10000000));
    expect(
        () => PerplActivationContext.fromJson({
              'chain': {'chain_id': 10143},
              'instances': [
                {
                  'id': 1,
                  'address': exchange,
                  'collateral_token_id': 1,
                  'min_account_open_amount': '10000000'
                }
              ],
              'tokens': [
                {'id': 1, 'address': token, 'symbol': 'AUSD', 'decimals': 6}
              ]
            }),
        throwsException);
    expect(
        () => PerplActivationContext.fromJson({
              'chain': {'chain_id': 143},
              'instances': [
                {
                  'id': 1,
                  'address': '0x${'11' * 20}',
                  'collateral_token_id': 1,
                  'min_account_open_amount': '10000000'
                }
              ],
              'tokens': [
                {'id': 1, 'address': token, 'symbol': 'AUSD', 'decimals': 6}
              ]
            }),
        throwsException);
  });
  test('resumable activation planner skips completed steps', () {
    ActivationStep step({
      int? accountId,
      BigInt? ausd,
      BigInt? allowance,
      bool? forwarding,
      bool pending = false,
    }) =>
        planPerplActivation(
            context,
            PerplActivationState(
                accountId: accountId,
                ausdMicros: ausd ?? BigInt.from(10000000),
                allowanceMicros: allowance ?? BigInt.zero,
                forwardingEnabled: forwarding,
                pendingTransaction: pending));
    expect(step(ausd: BigInt.from(9999999)), ActivationStep.needsAusd);
    expect(step(), ActivationStep.approve);
    expect(
        step(allowance: BigInt.from(10000000)), ActivationStep.createAccount);
    expect(step(accountId: 642), ActivationStep.connectPerpl);
    expect(step(accountId: 642, forwarding: false),
        ActivationStep.enableForwarding);
    expect(step(accountId: 642, forwarding: true), ActivationStep.ready);
    expect(step(pending: true), ActivationStep.waitForReceipt);
  });
  test('backend account state must agree with the on-chain account', () {
    final noAccount = PerplActivationState(
        accountId: null,
        ausdMicros: BigInt.zero,
        allowanceMicros: BigInt.zero,
        forwardingEnabled: null,
        pendingTransaction: false);
    final existing = PerplActivationState(
        accountId: 642,
        ausdMicros: BigInt.zero,
        allowanceMicros: BigInt.zero,
        forwardingEnabled: null,
        pendingTransaction: false);
    expect(() => verifyPerplAccountState({'status': 'NO_ACCOUNT'}, existing),
        throwsStateError);
    expect(
        () => verifyPerplAccountState({
              'status': 'AVAILABLE',
              'accountId': 642,
              'forwardingEnabled': true
            }, noAccount),
        throwsStateError);
    expect(
        () => verifyPerplAccountState({
              'status': 'AVAILABLE',
              'accountId': 643,
              'forwardingEnabled': true
            }, existing),
        throwsStateError);
    expect(
        verifyPerplAccountState({'status': 'NOT_CONNECTED'}, existing), isNull);
    expect(
        verifyPerplAccountState({'status': 'NO_ACCOUNT'}, noAccount), isNull);
    expect(
        verifyPerplAccountState({
          'status': 'AVAILABLE',
          'accountId': 642,
          'forwardingEnabled': true
        }, existing),
        isTrue);
  });
  test('activation calldata matches independent viem vectors', () {
    expect(activationCall(context, ActivationStep.approve).dataHex,
        '0x095ea7b300000000000000000000000034b6552d57a35a1d042ccae1951bd1c370112a6f0000000000000000000000000000000000000000000000000000000000989680');
    expect(activationCall(context, ActivationStep.createAccount).dataHex,
        '0xcab139150000000000000000000000000000000000000000000000000000000000989680');
    expect(activationCall(context, ActivationStep.enableForwarding).dataHex,
        '0x7962f9100000000000000000000000000000000000000000000000000000000000000001');
    expect(
        activationCall(context, ActivationStep.approve).exactAmount, '10 AUSD');
  });
  test('fake RPC loads unsigned context, AUSD and on-chain account state',
      () async {
    final methods = <String>[];
    final client = MockClient((request) async {
      if (request.method == 'GET') {
        expect(
            request.url.toString(), 'https://app.perpl.xyz/api/v1/pub/context');
        return http.Response(
            jsonEncode({
              'chain': {'chain_id': 143},
              'instances': [
                {
                  'id': 1,
                  'address': exchange,
                  'collateral_token_id': 1,
                  'min_account_open_amount': '10000000'
                }
              ],
              'tokens': [
                {'id': 1, 'address': token, 'symbol': 'AUSD', 'decimals': 6}
              ]
            }),
            200);
      }
      final body = jsonDecode(request.body) as Map<String, dynamic>;
      final method = body['method'] as String;
      methods.add(method);
      Object? result;
      if (method == 'eth_chainId') result = '0x8f';
      if (method == 'eth_call') {
        final call = (body['params'] as List).first as Map;
        final data = call['data'] as String;
        if (data.startsWith('0x70a08231')) result = '0x989680';
        if (data.startsWith('0xdd62ed3e')) result = '0x0';
        if (data.startsWith('0x12e8eb2c')) {
          return http.Response(
              jsonEncode({
                'jsonrpc': '2.0',
                'id': body['id'],
                'error': {'code': -32000, 'message': 'execution reverted'}
              }),
              200);
        }
      }
      return http.Response(
          jsonEncode({'jsonrpc': '2.0', 'id': body['id'], 'result': result}),
          200);
    });
    final gateway = PerplActivationGateway(client);
    final loaded =
        await gateway.load('0xF9297b542BDb5DA50C364f9AE4Cbe1F3933bA40F');
    expect(planPerplActivation(loaded.context, loaded.state),
        ActivationStep.approve);
    expect(methods, containsAll(['eth_chainId', 'eth_call']));
    client.close();
  });
  test('fake receipt distinguishes pending, success and revert', () async {
    Object? receipt;
    final client = MockClient((request) async {
      final body = jsonDecode(request.body) as Map<String, dynamic>;
      expect(body['method'], 'eth_getTransactionReceipt');
      return http.Response(
          jsonEncode({'jsonrpc': '2.0', 'id': body['id'], 'result': receipt}),
          200);
    });
    final gateway = PerplActivationGateway(client);
    final hash = '0x${'aa' * 32}';
    expect(await gateway.receipt(hash), ActivationReceipt.pending);
    receipt = {'transactionHash': hash, 'status': '0x1'};
    expect(await gateway.receipt(hash), ActivationReceipt.success);
    receipt = {'transactionHash': hash, 'status': '0x0'};
    expect(await gateway.receipt(hash), ActivationReceipt.reverted);
    client.close();
  });
}
