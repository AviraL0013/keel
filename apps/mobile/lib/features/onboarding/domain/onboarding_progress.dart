import '../../capital/domain/capital_snapshot.dart';

enum OnboardingStep {
  fundWallet,
  activatePerpl,
  fundCollateral,
  firstTrade,
  protectPosition,
  complete,
  unavailable,
}

/// Progress is rebuilt from wallet/venue evidence, never a local "done" flag.
class OnboardingProgress {
  const OnboardingProgress({
    required this.step,
    required this.environment,
    required this.walletBalance,
    required this.collateral,
    required this.canOpenTrade,
    this.accountId,
    this.reason,
    this.operatorMode = false,
  });
  final OnboardingStep step;
  final String environment;
  final CapitalAmount walletBalance;
  final CapitalAmount collateral;
  final bool canOpenTrade;
  final int? accountId;
  final String? reason;
  final bool operatorMode;
  bool get activated => [
        OnboardingStep.fundCollateral,
        OnboardingStep.firstTrade,
        OnboardingStep.protectPosition,
        OnboardingStep.complete,
      ].contains(step);
}

bool hasFreshPositiveAmount(CapitalAmount amount) {
  if (!amount.isAvailable || amount.freshness != 'FRESH') return false;
  final value = amount.amount!;
  // Avoid floating point rounding for balances and very small token amounts.
  if (!RegExp(r'^\d+(\.\d+)?$').hasMatch(value)) return false;
  return BigInt.parse(value.replaceAll('.', '')) > BigInt.zero;
}

OnboardingProgress planOnboarding({
  required String environment,
  required CapitalSnapshot capital,
  required Map<String, dynamic> account,
  required int openPositions,
  required int books,
  bool operatorMode = false,
}) {
  final wallet = capital.walletAgoraAusd;
  final collateral = capital.perplAvailable;
  final id = account['accountId'];
  final ready = account['status'] == 'AVAILABLE' &&
      id is int &&
      id > 0 &&
      account['forwardingEnabled'] == true;
  final identityMatches = ready && capital.accountId == id;
  final validCollateral = collateral.isAvailable &&
      collateral.freshness == 'FRESH' &&
      collateral.asset == (environment == 'mainnet' ? 'AUSD' : 'USD') &&
      RegExp(r'^\d+(\.\d+)?$').hasMatch(collateral.amount!);
  final canTrade =
      identityMatches && validCollateral && hasFreshPositiveAmount(collateral);
  OnboardingProgress result(OnboardingStep step, [String? reason]) =>
      OnboardingProgress(
        step: step,
        environment: environment,
        walletBalance: wallet,
        collateral: collateral,
        canOpenTrade: canTrade,
        accountId: id is int ? id : null,
        reason: reason,
        operatorMode: operatorMode,
      );
  if (!['AVAILABLE', 'NOT_CONNECTED', 'NO_ACCOUNT']
      .contains(account['status'])) {
    return result(OnboardingStep.unavailable,
        'Perpl account state could not be verified. Refresh to retry.');
  }
  if (!ready) {
    if (environment == 'mainnet' && account['status'] != 'AVAILABLE') {
      final chain = wallet.onChain;
      if (wallet.asset != 'AUSD' ||
          !wallet.isAvailable ||
          wallet.freshness != 'FRESH' ||
          chain?['chainId'] != 143) {
        return result(OnboardingStep.unavailable,
            'The AUSD wallet balance could not be verified on Monad mainnet.');
      }
      if (!hasFreshPositiveAmount(wallet)) {
        return result(OnboardingStep.fundWallet);
      }
    }
    return result(OnboardingStep.activatePerpl);
  }
  if (!identityMatches || !validCollateral) {
    return result(OnboardingStep.unavailable,
        'A fresh balance for this Perpl account is required. Refresh to retry.');
  }
  if (books > 0) return result(OnboardingStep.complete);
  if (openPositions > 0) return result(OnboardingStep.protectPosition);
  return result(
      canTrade ? OnboardingStep.firstTrade : OnboardingStep.fundCollateral);
}
