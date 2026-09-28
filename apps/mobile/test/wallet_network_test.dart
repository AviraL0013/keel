import 'package:flutter_test/flutter_test.dart';
import 'package:eyeler_mobile/core/wallet/eip1193_wallet_connector.dart';
import 'package:eyeler_mobile/core/wallet/wallet_types.dart';

const network = WalletNetworkConfig(
  chainId: 10143,
  chainName: 'Monad Testnet',
  rpcUrl: 'https://rpc.example',
  currencyName: 'MON',
  currencySymbol: 'MON',
  explorerUrl: 'https://explorer.example',
);

void main() {
  test('sign-in switches to Monad testnet before returning account', () async {
    final calls = <String>[];
    var chain = '0x1';
    final wallet = Eip1193WalletConnector((method, [params]) async {
      calls.add(method);
      if (method == 'eth_requestAccounts') return ['0xabc'];
      if (method == 'eth_chainId') return chain;
      if (method == 'wallet_switchEthereumChain') {
        chain = '0x279f';
        return null;
      }
      return null;
    }, network: network);
    expect((await wallet.connect()).chainId, 10143);
    expect(calls, [
      'eth_requestAccounts',
      'eth_chainId',
      'wallet_switchEthereumChain',
      'eth_chainId'
    ]);
  });

  test('adds unknown chain with configured RPC, currency and explorer',
      () async {
    final calls = <String>[];
    Map<String, Object?>? added;
    var chain = '0x1';
    var known = false;
    final wallet = Eip1193WalletConnector((method, [params]) async {
      calls.add(method);
      if (method == 'eth_requestAccounts') return ['0xabc'];
      if (method == 'eth_chainId') return chain;
      if (method == 'wallet_switchEthereumChain') {
        if (!known) throw const Eip1193Exception(4902);
        chain = '0x279f';
      }
      if (method == 'wallet_addEthereumChain') {
        added = params!.first as Map<String, Object?>;
        known = true;
      }
      return null;
    }, network: network);
    await wallet.connect();
    expect(calls, [
      'eth_requestAccounts',
      'eth_chainId',
      'wallet_switchEthereumChain',
      'wallet_addEthereumChain',
      'wallet_switchEthereumChain',
      'eth_chainId'
    ]);
    expect(added, {
      'chainId': '0x279f',
      'chainName': 'Monad Testnet',
      'rpcUrls': ['https://rpc.example'],
      'nativeCurrency': {'name': 'MON', 'symbol': 'MON', 'decimals': 18},
      'blockExplorerUrls': ['https://explorer.example']
    });
  });

  test('declined switch shows a clear message', () async {
    final wallet = Eip1193WalletConnector((method, [params]) async {
      if (method == 'eth_requestAccounts') return ['0xabc'];
      if (method == 'eth_chainId') return '0x1';
      if (method == 'wallet_switchEthereumChain') {
        throw const Eip1193Exception(4001);
      }
      return null;
    }, network: network);
    await expectLater(
        wallet.connect(),
        throwsA(isA<WalletException>().having(
            (error) => error.message, 'message', contains('Monad Testnet'))));
  });

  test('unknown chain without configured URLs fails before add request',
      () async {
    final calls = <String>[];
    final wallet = Eip1193WalletConnector((method, [params]) async {
      calls.add(method);
      if (method == 'eth_requestAccounts') return ['0xabc'];
      if (method == 'eth_chainId') return '0x1';
      if (method == 'wallet_switchEthereumChain') {
        throw const Eip1193Exception(4902);
      }
      return null;
    }, network: const WalletNetworkConfig());
    await expectLater(
        wallet.connect(),
        throwsA(isA<WalletException>().having((error) => error.message,
            'message', contains('RPC and explorer URLs'))));
    expect(calls, isNot(contains('wallet_addEthereumChain')));
  });

  test('typed-data signing rechecks chain before requesting a signature',
      () async {
    final calls = <String>[];
    var chain = '0x1';
    final wallet = Eip1193WalletConnector((method, [params]) async {
      calls.add(method);
      if (method == 'eth_chainId') return chain;
      if (method == 'wallet_switchEthereumChain') {
        chain = '0x279f';
        return null;
      }
      if (method == 'eth_signTypedData_v4') return '0xsigned';
      return null;
    }, network: network);
    expect(await wallet.signTypedData('0xabc', {'types': <String, Object?>{}}),
        '0xsigned');
    expect(calls, [
      'eth_chainId',
      'wallet_switchEthereumChain',
      'eth_chainId',
      'eth_signTypedData_v4'
    ]);
  });
}
