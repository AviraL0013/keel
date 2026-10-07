import 'package:flutter/material.dart';

import '../../../core/wallet/mera_transaction.dart';

Future<String> readMainnetMonBalance(
    MeraTransactionRpc rpc, String address) async {
  if (await rpc.chainId() != 143) {
    throw StateError('Monad mainnet chain 143 required.');
  }
  final wei = await rpc.nativeBalance(address);
  if (wei < BigInt.zero) throw StateError('Invalid MON balance.');
  final units = BigInt.from(10).pow(18);
  final whole = wei ~/ units;
  final fraction = (wei % units)
      .toString()
      .padLeft(18, '0')
      .replaceFirst(RegExp(r'0+$'), '');
  return fraction.isEmpty ? '$whole' : '$whole.$fraction';
}

class MonBalanceTile extends StatelessWidget {
  const MonBalanceTile(
      {super.key, required this.amount, required this.lowForGas});
  final String amount;
  final bool lowForGas;

  @override
  Widget build(BuildContext context) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text('MON for network fees'),
          Text('$amount MON'),
          if (lowForGas)
            const Text('Add MON on Monad mainnet to pay network fees.'),
        ],
      );
}
