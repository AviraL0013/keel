import 'analytics_contract.dart';
import 'analytics_models.dart';
import 'dashboard_data.dart';

/// A current wallet snapshot can support risk calculations only when the
/// Exchange verified its complete position bitmap and every open mark.
String? walletSnapshotReason(
    V1Envelope<V1WalletProfile>? snapshot, String address) {
  if (snapshot == null) return 'Current wallet snapshot is unavailable.';
  if (snapshot.data.address.toLowerCase() != address.toLowerCase()) {
    return 'Wallet snapshot address does not match.';
  }
  if (snapshot.source != 'monad_exchange' ||
      snapshot.stale ||
      snapshot.block == null ||
      snapshot.block! <= 0) {
    return 'A current verified Exchange snapshot is unavailable.';
  }
  if (snapshot.data.margin.equity == null) {
    return 'Complete position enumeration or marks are unavailable.';
  }
  final accounts = snapshot.data.accountIds.toSet();
  if (accounts.length != snapshot.data.accountIds.length) {
    return 'Linked account enumeration is invalid.';
  }
  final ids = <String>{};
  try {
    for (final position in snapshot.data.positions) {
      if (position.id.isEmpty ||
          !ids.add(position.id) ||
          position.marketId <= 0 ||
          (position.side != 'long' && position.side != 'short') ||
          position.notional == null ||
          position.markPrice == null) {
        return 'Verified position details are unavailable.';
      }
      if (AnalyticsDecimal.parse(position.size).units <= BigInt.zero ||
          AnalyticsDecimal.parse(position.markPrice!).units <= BigInt.zero ||
          AnalyticsDecimal.parse(position.notional!).units.isNegative) {
        return 'Verified position details are unavailable.';
      }
    }
  } on FormatException {
    return 'Verified position details are unavailable.';
  }
  return null;
}

AnalyticsDecimal decimalProduct(AnalyticsDecimal a, AnalyticsDecimal b) =>
    AnalyticsDecimal(a.units * b.units, a.scale + b.scale);

AnalyticsDecimal decimalDifference(AnalyticsDecimal a, AnalyticsDecimal b) =>
    a + b.negative;

String signedMoney(AnalyticsDecimal value) {
  if (value.units == BigInt.zero) return r'$0';
  final absolute = value.units.isNegative ? value.negative : value;
  final formatted = analyticsMoney(absolute);
  return value.units.isNegative ? '-$formatted' : '+$formatted';
}

String analyticsMoney(AnalyticsDecimal value) {
  final absolute = value.units.isNegative ? value.negative : value;
  if (absolute.compareTo(AnalyticsDecimal.parse('100000')) >= 0) {
    return AnalyticsNumbers.compact(value.toString(), places: 2);
  }
  final units = value.units.abs();
  final divisor = BigInt.from(10).pow(value.scale);
  final cents = (units * BigInt.from(100) + divisor ~/ BigInt.two) ~/ divisor;
  final whole = cents ~/ BigInt.from(100);
  final fraction = (cents % BigInt.from(100)).toString().padLeft(2, '0');
  return '${value.units.isNegative ? '-' : ''}\$$whole.$fraction';
}

String positionMarket(V1Position position) => position.symbol.trim().isEmpty
    ? 'Market ${position.marketId}'
    : '${position.symbol} · market ${position.marketId}';
