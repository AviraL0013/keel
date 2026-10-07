import 'package:eyeler_mobile/features/activation/activation_coordinator.dart';
import 'package:eyeler_mobile/features/activation/perpl_activation.dart';
import 'package:eyeler_mobile/core/wallet/mera_transaction.dart';
import 'package:flutter_test/flutter_test.dart';

const wallet = '0xF9297b542BDb5DA50C364f9AE4Cbe1F3933bA40F';

class MemoryJournal implements ActivationJournal {
  PendingActivation? current;
  @override
  Future<PendingActivation?> read(String address) async => current;
  @override
  Future<void> save(PendingActivation pending) async => current = pending;
  @override
  Future<void> clear(String address) async => current = null;
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
  test('approve resumes after restart and never submits twice', () async {
    final journal = MemoryJournal();
    var allowance = BigInt.zero;
    var receipt = ActivationReceipt.pending;
    var sends = 0;
    LoadedPerplActivation load() => LoadedPerplActivation(
        context,
        PerplActivationState(
            accountId: null,
            ausdMicros: BigInt.from(10000000),
            allowanceMicros: allowance,
            forwardingEnabled: null,
            pendingTransaction: false));
    PerplActivationCoordinator coordinator() => PerplActivationCoordinator(
          walletAddress: wallet,
          journal: journal,
          load: () async => load(),
          receipt: (_) async => receipt,
          prepare: (call) async => MeraTransactionQuote(
              address: wallet,
              chainId: 143,
              contract: call.contract,
              function: call.function,
              exactAmount: call.exactAmount,
              data: call.data,
              nonce: 1,
              gasLimit: 50000,
              maxFeePerGas: BigInt.one,
              priorityFeePerGas: BigInt.one,
              generation: 1),
          send: (_) async {
            sends++;
            return '0x${'aa' * 32}';
          },
        );
    final first = coordinator();
    expect((await first.refresh()).step, ActivationStep.approve);
    await first.submit(ActivationStep.approve, (_) async => true);
    expect(sends, 1);
    final restarted = coordinator();
    expect((await restarted.refresh()).step, ActivationStep.waitForReceipt);
    await expectLater(
        restarted.submit(ActivationStep.approve, (_) async => true),
        throwsException);
    receipt = ActivationReceipt.success;
    allowance = BigInt.from(10000000);
    expect((await restarted.refresh()).step, ActivationStep.createAccount);
    expect(journal.current, isNull);
    expect(sends, 1);
  });
  test(
      'dropped or unknown send stays blocked; reverted receipt reports failure',
      () async {
    final journal = MemoryJournal()
      ..current = const PendingActivation(
          walletAddress: wallet,
          step: ActivationStep.createAccount,
          transactionHash: null);
    var receipt = ActivationReceipt.pending;
    final coordinator = PerplActivationCoordinator(
        walletAddress: wallet,
        journal: journal,
        load: () async => LoadedPerplActivation(
            context,
            PerplActivationState(
                accountId: null,
                ausdMicros: BigInt.from(10000000),
                allowanceMicros: BigInt.from(10000000),
                forwardingEnabled: null,
                pendingTransaction: false)),
        receipt: (_) async => receipt,
        prepare: (_) => throw UnimplementedError(),
        send: (_) => throw UnimplementedError());
    expect((await coordinator.refresh()).step, ActivationStep.waitForReceipt);
    expect(journal.current, isNotNull);
    journal.current = PendingActivation(
        walletAddress: wallet,
        step: ActivationStep.createAccount,
        transactionHash: '0x${'aa' * 32}');
    expect((await coordinator.refresh()).step, ActivationStep.waitForReceipt);
    receipt = ActivationReceipt.reverted;
    expect((await coordinator.refresh()).error, 'TRANSACTION_REVERTED');
    expect(journal.current, isNull);
  });
}
