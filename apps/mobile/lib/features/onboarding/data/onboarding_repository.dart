import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/networking/api_client.dart';
import '../../auth/data/auth_repository.dart';
import '../../books/data/books_repository.dart';
import '../../capital/data/capital_repository.dart';
import '../../positions/data/perpl_connection_repository.dart';
import '../../positions/data/positions_repository.dart';
import '../domain/onboarding_progress.dart';

final onboardingProvider =
    FutureProvider.autoDispose<OnboardingProgress>((ref) async {
  final auth = ref.watch(authProvider);
  if (!auth.authenticated || auth.address == null) {
    throw StateError('Sign in to continue setup.');
  }
  final api = ref.watch(apiClientProvider);
  final capability = await ref.watch(enrollmentProvider.future);
  const deployment =
      String.fromEnvironment('EYELER_DEPLOYMENT', defaultValue: 'testnet');
  final environment = capability['environment'] as String? ?? deployment;
  // Test/development use the deterministic operator venue. Live builds must
  // agree with their server; never sign against a mixed environment.
  if (['mainnet', 'testnet'].contains(environment) &&
      environment != deployment) {
    throw StateError('App and server networks differ. Use a matching build.');
  }
  final operator = capability['reason'] == 'OPERATOR_ACCOUNT_MODE';
  if (capability['status'] != 'AVAILABLE' && !operator) {
    throw StateError('Perpl enrollment is unavailable in this deployment.');
  }
  Map<String, dynamic> account;
  if (operator) {
    final connection = await ref.watch(perplConnectionProvider.future);
    account = {
      'status': connection.status == 'VALID' ? 'AVAILABLE' : 'NOT_CONNECTED',
      'accountId': connection.accountId,
      'forwardingEnabled': connection.status == 'VALID',
    };
  } else {
    account = await api.get('/connections/perpl/account-state',
        (v) => Map<String, dynamic>.from(v as Map));
  }
  final capital = await ref.watch(capitalProvider.future);
  var positionCount = 0;
  var bookCount = 0;
  if (account['status'] == 'AVAILABLE' &&
      account['forwardingEnabled'] == true) {
    final positions = await ref.watch(positionsProvider.future);
    if (positions.any((p) => p.accountId != account['accountId'])) {
      throw StateError('Perpl position account differs from this wallet.');
    }
    positionCount = positions.where((p) => p.status == 'OPEN').length;
    bookCount = (await ref.watch(booksProvider.future)).length;
  }
  return planOnboarding(
      environment: environment,
      capital: capital,
      account: account,
      openPositions: positionCount,
      books: bookCount,
      operatorMode: operator);
});

void refreshOnboarding(WidgetRef ref) {
  ref.invalidate(enrollmentProvider);
  ref.invalidate(capitalProvider);
  ref.invalidate(perplConnectionProvider);
  ref.invalidate(positionsProvider);
  ref.invalidate(booksProvider);
  ref.invalidate(onboardingProvider);
}
