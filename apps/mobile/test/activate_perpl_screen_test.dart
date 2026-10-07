import 'dart:typed_data';

import 'package:eyeler_mobile/core/wallet/mera_transaction.dart';
import 'package:eyeler_mobile/features/activation/activate_perpl_screen.dart';
import 'package:eyeler_mobile/features/activation/activation_coordinator.dart';
import 'package:eyeler_mobile/features/activation/perpl_activation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

class Journal implements ActivationJournal {
  @override
  Future<PendingActivation?> read(String address) async => null;
  @override
  Future<void> save(PendingActivation pending) async {}
  @override
  Future<void> clear(String address) async {}
}

void main() {
  final context = PerplActivationContext.fromJson({
    'chain': {'chain_id': 143},
    'instances': [
      {
        'id': 1,
        'address': perplMainnetExchange,
        'collateral_token_id': 1,
        'min_account_open_amount': '10000000'
      }
    ],
    'tokens': [
      {'id': 1, 'address': monadMainnetAusd, 'symbol': 'AUSD', 'decimals': 6}
    ]
  });
  for (final width in [320.0, 360.0]) {
    testWidgets('activation confirms exact approval on ${width.toInt()} dp',
        (tester) async {
      tester.view.physicalSize = Size(width, 740);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      var sends = 0;
      final coordinator = PerplActivationCoordinator(
          walletAddress: '0xF9297b542BDb5DA50C364f9AE4Cbe1F3933bA40F',
          journal: Journal(),
          load: () async => LoadedPerplActivation(
              context,
              PerplActivationState(
                  accountId: null,
                  ausdMicros: BigInt.from(10000000),
                  allowanceMicros: BigInt.zero,
                  forwardingEnabled: null,
                  pendingTransaction: false)),
          receipt: (_) async => ActivationReceipt.pending,
          prepare: (call) async => MeraTransactionQuote(
              address: '0xF9297b542BDb5DA50C364f9AE4Cbe1F3933bA40F',
              chainId: 143,
              contract: call.contract,
              function: call.function,
              exactAmount: call.exactAmount,
              data: Uint8List(0),
              nonce: 0,
              gasLimit: 50000,
              maxFeePerGas: BigInt.from(2000000000),
              priorityFeePerGas: BigInt.one,
              generation: 0),
          send: (_) async {
            sends++;
            return '0x${'aa' * 32}';
          });
      await tester.pumpWidget(
          MaterialApp(home: ActivatePerplScreen(coordinator: coordinator)));
      await tester.pumpAndSettle();
      expect(find.text('APPROVE EXACTLY 10 AUSD'), findsOneWidget);
      await tester.tap(find.text('APPROVE EXACTLY 10 AUSD'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.textContaining('approve(address,uint256)'), findsOneWidget);
      expect(find.textContaining('0.0001 MON'), findsOneWidget);
      expect(find.text('Monad mainnet · 143'), findsOneWidget);
      await tester.tap(find.text('CANCEL'));
      await tester.pumpAndSettle();
      expect(sends, 0);
      expect(tester.takeException(), isNull);
    });
  }
}
