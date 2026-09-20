enum WalletStatus {
  disconnected,
  connecting,
  connected,
  signing,
  authenticated,
  wrongNetwork,
  error
}

class AuthState {
  const AuthState(
      {required this.authenticated,
      this.error,
      this.loading = false,
      this.restoring = false,
      this.walletStatus = WalletStatus.disconnected,
      this.address,
      this.chainId,
      this.challengeMessage});
  final bool authenticated;
  final String? error;
  final bool loading;
  final bool restoring;
  final WalletStatus walletStatus;
  final String? address;
  final int? chainId;
  final String? challengeMessage;
}
