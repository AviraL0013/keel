import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../../core/wallet/mera_transaction.dart';
import '../../core/wallet/wallet_types.dart';
import 'perpl_activation.dart';

class PendingActivation {
  const PendingActivation({
    required this.walletAddress,
    required this.step,
    required this.transactionHash,
  });
  final String walletAddress;
  final ActivationStep step;
  final String? transactionHash;
  PendingActivation withHash(String hash) => PendingActivation(
      walletAddress: walletAddress, step: step, transactionHash: hash);
}

abstract class ActivationJournal {
  Future<PendingActivation?> read(String address);
  Future<void> save(PendingActivation pending);
  Future<void> clear(String address);
}

class SecureActivationJournal implements ActivationJournal {
  const SecureActivationJournal();
  static const _storage = FlutterSecureStorage();
  String _key(String address) => 'eyeler_activation_${address.toLowerCase()}';

  @override
  Future<PendingActivation?> read(String address) async {
    final value = await _storage.read(key: _key(address));
    if (value == null) return null;
    try {
      final json = jsonDecode(value) as Map<String, dynamic>;
      final wallet = json['walletAddress'] as String;
      final step = ActivationStep.values.byName(json['step'] as String);
      final hash = json['transactionHash'] as String?;
      if (wallet.toLowerCase() != address.toLowerCase() ||
          ![
            ActivationStep.approve,
            ActivationStep.createAccount,
            ActivationStep.enableForwarding
          ].contains(step) ||
          (hash != null && !RegExp(r'^0x[0-9a-fA-F]{64}$').hasMatch(hash))) {
        throw const WalletException('Activation journal invalid.');
      }
      return PendingActivation(
          walletAddress: wallet, step: step, transactionHash: hash);
    } catch (_) {
      throw const WalletException(
          'Activation journal unreadable. Review pending transaction before continuing.');
    }
  }

  @override
  Future<void> save(PendingActivation pending) => _storage.write(
      key: _key(pending.walletAddress),
      value: jsonEncode({
        'walletAddress': pending.walletAddress,
        'step': pending.step.name,
        'transactionHash': pending.transactionHash,
      }));

  @override
  Future<void> clear(String address) => _storage.delete(key: _key(address));
}

class ActivationProgress {
  const ActivationProgress(
      {required this.step, this.transactionHash, this.error, this.nextCall});
  final ActivationStep step;
  final String? transactionHash;
  final String? error;
  final ActivationCall? nextCall;
}

class PerplActivationCoordinator {
  PerplActivationCoordinator({
    required this.walletAddress,
    required this.journal,
    required this.load,
    required this.receipt,
    required this.prepare,
    required this.send,
  });
  final String walletAddress;
  final ActivationJournal journal;
  final Future<LoadedPerplActivation> Function() load;
  final Future<ActivationReceipt> Function(String) receipt;
  final Future<MeraTransactionQuote> Function(ActivationCall) prepare;
  final Future<String> Function(MeraTransactionQuote) send;
  bool _busy = false;

  Future<ActivationProgress> refresh() async {
    final pending = await journal.read(walletAddress);
    if (pending != null) {
      if (pending.walletAddress.toLowerCase() != walletAddress.toLowerCase()) {
        throw const WalletException('Activation wallet changed.');
      }
      final hash = pending.transactionHash;
      if (hash == null) {
        return const ActivationProgress(
            step: ActivationStep.waitForReceipt,
            error: 'TRANSACTION_OUTCOME_UNKNOWN');
      }
      final status = await receipt(hash);
      if (status == ActivationReceipt.pending) {
        return ActivationProgress(
            step: ActivationStep.waitForReceipt, transactionHash: hash);
      }
      if (status == ActivationReceipt.reverted) {
        await journal.clear(walletAddress);
        return ActivationProgress(
            step: ActivationStep.waitForReceipt,
            transactionHash: hash,
            error: 'TRANSACTION_REVERTED');
      }
      final loaded = await load();
      final verified = switch (pending.step) {
        ActivationStep.approve =>
          loaded.state.allowanceMicros >= loaded.context.minimumDepositMicros,
        ActivationStep.createAccount => loaded.state.accountId != null,
        ActivationStep.enableForwarding =>
          loaded.state.forwardingEnabled == true,
        _ => false,
      };
      if (!verified) {
        return ActivationProgress(
            step: ActivationStep.waitForReceipt,
            transactionHash: hash,
            error: 'WAITING_FOR_CHAIN_STATE');
      }
      await journal.clear(walletAddress);
      final step = planPerplActivation(loaded.context, loaded.state);
      return ActivationProgress(
          step: step, nextCall: _callFor(loaded.context, step));
    }
    final loaded = await load();
    final step = planPerplActivation(loaded.context, loaded.state);
    return ActivationProgress(
        step: step, nextCall: _callFor(loaded.context, step));
  }

  ActivationCall? _callFor(
          PerplActivationContext context, ActivationStep step) =>
      [
        ActivationStep.approve,
        ActivationStep.createAccount,
        ActivationStep.enableForwarding
      ].contains(step)
          ? activationCall(context, step)
          : null;

  Future<ActivationProgress> submit(ActivationStep step,
      Future<bool> Function(MeraTransactionQuote) confirm) async {
    if (_busy) throw const WalletException('Activation already in progress.');
    _busy = true;
    try {
      final progress = await refresh();
      if (progress.step != step ||
          ![
            ActivationStep.approve,
            ActivationStep.createAccount,
            ActivationStep.enableForwarding
          ].contains(step)) {
        throw const WalletException('Refresh activation state before acting.');
      }
      final loaded = await load();
      if (planPerplActivation(loaded.context, loaded.state) != step) {
        throw const WalletException('Activation state changed. Refresh first.');
      }
      final quote = await prepare(activationCall(loaded.context, step));
      if (!await confirm(quote)) {
        throw const WalletException('Transaction cancelled.');
      }
      final pending = PendingActivation(
          walletAddress: walletAddress, step: step, transactionHash: null);
      await journal.save(pending); // Durable before signing or sending.
      final hash = await send(quote);
      if (!RegExp(r'^0x[0-9a-fA-F]{64}$').hasMatch(hash)) {
        throw const WalletException('Transaction hash unavailable.');
      }
      await journal.save(pending.withHash(hash));
      return ActivationProgress(
          step: ActivationStep.waitForReceipt, transactionHash: hash);
    } finally {
      _busy = false;
    }
  }
}
