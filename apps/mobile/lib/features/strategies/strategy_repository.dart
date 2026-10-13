import 'dart:math';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/networking/api_client.dart';
import '../auth/data/auth_repository.dart';

class StrategyEntry {
  const StrategyEntry({
    required this.id,
    required this.mode,
    required this.kind,
    required this.status,
    required this.marketId,
    required this.accountId,
    required this.capital,
    required this.state,
  });
  final String id, mode, kind, status;
  final int marketId, accountId;
  final double capital;
  final Map<String, dynamic> state;
  factory StrategyEntry.fromJson(Map<String, dynamic> json) => StrategyEntry(
        id: json['id'] as String,
        mode: json['mode'] as String,
        kind: json['kind'] as String,
        status: json['status'] as String,
        marketId: int.parse(json['market_id'].toString()),
        accountId: int.parse(json['account_id'].toString()),
        capital: double.parse(json['capital'].toString()),
        state: Map<String, dynamic>.from(json['state'] as Map),
      );
}

class StrategyAccount {
  const StrategyAccount(this.connectionId, this.accountId, this.environment);
  final String connectionId, environment;
  final int accountId;
  factory StrategyAccount.fromJson(Map<String, dynamic> json) =>
      StrategyAccount(
        json['connectionId'] as String,
        int.parse(json['accountId'].toString()),
        json['environment'] as String,
      );
}

class StrategyMarket {
  const StrategyMarket(this.id, this.symbol);
  final int id;
  final String symbol;
  factory StrategyMarket.fromJson(Map<String, dynamic> json) => StrategyMarket(
        int.parse(json['id'].toString()),
        json['symbol'] as String,
      );
}

class StrategyAccountingRow {
  const StrategyAccountingRow({
    required this.environment,
    required this.strategyId,
    required this.marketId,
    required this.positionSize,
    required this.averageEntry,
    required this.realizedPnl,
    required this.feesPaid,
    required this.fundingPaid,
    required this.lastSequence,
    required this.appliedCount,
  });

  final String environment;
  final String strategyId;
  final int marketId;
  final String positionSize;
  final String? averageEntry;
  final String realizedPnl;
  final String feesPaid;
  final String fundingPaid;
  final Map<String, dynamic> lastSequence;
  final int appliedCount;

  factory StrategyAccountingRow.fromJson(Map<String, dynamic> json) =>
      StrategyAccountingRow(
        environment: json['environment'] as String,
        strategyId: json['strategyId'] as String,
        marketId: int.parse(json['marketId'].toString()),
        positionSize: json['positionSize'] as String,
        averageEntry: json['averageEntry'] as String?,
        realizedPnl: json['realizedPnl'] as String,
        feesPaid: json['feesPaid'] as String,
        fundingPaid: json['fundingPaid'] as String,
        lastSequence: Map<String, dynamic>.from(json['lastSequence'] as Map),
        appliedCount: int.parse(json['appliedCount'].toString()),
      );
}

class StrategySetup {
  const StrategySetup(
    this.accounts,
    this.markets, {
    this.liveEnabled = false,
    this.liveReason,
  });
  final List<StrategyAccount> accounts;
  final List<StrategyMarket> markets;
  final bool liveEnabled;
  final String? liveReason;
  factory StrategySetup.fromJson(Map<String, dynamic> json) => StrategySetup(
        (json['accounts'] as List)
            .map(
              (row) => StrategyAccount.fromJson(
                  Map<String, dynamic>.from(row as Map)),
            )
            .toList(),
        (json['markets'] as List)
            .map(
              (row) => StrategyMarket.fromJson(
                  Map<String, dynamic>.from(row as Map)),
            )
            .toList(),
        liveEnabled: json['liveEnabled'] == true,
        liveReason: json['liveReason'] as String?,
      );
}

class StrategyPublication {
  const StrategyPublication({required this.id, required this.url});
  final String id;
  final String url;
}

abstract class StrategyRepository {
  Future<List<StrategyEntry>> list();
  Future<StrategySetup> setup();
  Future<StrategyEntry> create(
    String connectionId,
    Map<String, dynamic> config,
  );
  Future<StrategyEntry> control(String id, String action);
  Future<Map<String, dynamic>> livePreview(String id, int maxRunMs);
  Future<StrategyEntry> confirmLive(
    String id,
    String previewId,
    String idempotencyKey,
  );
  Future<Map<String, dynamic>> status(String id);
  Future<List<StrategyPublication>> publications(String strategyId);
  Future<StrategyPublication> publishEvidence(
      String strategyId, DateTime from, DateTime to);
  Future<void> revokePublication(String publicationId);
  Future<Map<String, dynamic>> pnl(String id);
  Future<List<StrategyAccountingRow>> verifiedAccounting(String id);
  Future<List<Map<String, dynamic>>> orders(String id);
  Future<List<Map<String, dynamic>>> fills(String id);
  Future<List<Map<String, dynamic>>> riskEvents(String id);
  Future<bool> killed();
  Future<void> kill();
  Future<void> resetKill();
}

class HttpStrategyRepository implements StrategyRepository {
  const HttpStrategyRepository(this.api);
  final EyelerApiClient api;
  List<Map<String, dynamic>> rows(dynamic value) => (value as List)
      .map((row) => Map<String, dynamic>.from(row as Map))
      .toList();
  @override
  Future<List<StrategyEntry>> list() => api.get(
        '/strategies',
        (value) => rows(value).map(StrategyEntry.fromJson).toList(),
      );
  @override
  Future<StrategySetup> setup() => api.get(
        '/strategies/setup',
        (value) =>
            StrategySetup.fromJson(Map<String, dynamic>.from(value as Map)),
      );
  @override
  Future<StrategyEntry> create(
    String connectionId,
    Map<String, dynamic> config,
  ) =>
      api.post(
        '/strategies',
        body: {'connectionId': connectionId, 'config': config},
        decode: (value) =>
            StrategyEntry.fromJson(Map<String, dynamic>.from(value as Map)),
      );
  @override
  Future<StrategyEntry> control(String id, String action) => api.post(
        '/strategies/$id/$action',
        decode: (value) =>
            StrategyEntry.fromJson(Map<String, dynamic>.from(value as Map)),
      );
  @override
  Future<Map<String, dynamic>> livePreview(String id, int maxRunMs) => api.post(
        '/strategies/$id/live-preview',
        body: {'maxRunMs': maxRunMs},
        decode: (value) => Map<String, dynamic>.from(value as Map),
      );
  @override
  Future<StrategyEntry> confirmLive(
    String id,
    String previewId,
    String idempotencyKey,
  ) =>
      api.post(
        '/strategies/$id/live-confirm',
        body: {
          'previewId': previewId,
          'idempotencyKey': idempotencyKey,
          'acknowledgeRealOrders': true,
        },
        decode: (value) =>
            StrategyEntry.fromJson(Map<String, dynamic>.from(value as Map)),
      );
  @override
  Future<Map<String, dynamic>> status(String id) => api.get(
        '/strategies/$id/status',
        (value) => Map<String, dynamic>.from(value as Map),
      );
  @override
  Future<List<StrategyPublication>> publications(String strategyId) => api.get(
        '/strategies/evidence-publications?strategyId=${Uri.encodeQueryComponent(strategyId)}',
        (value) => rows(value)
            .map((row) => StrategyPublication(
                  id: row['id'] as String,
                  url: api.resolve(row['path'] as String),
                ))
            .toList(),
      );
  @override
  Future<StrategyPublication> publishEvidence(
          String strategyId, DateTime from, DateTime to) =>
      api.post(
        '/strategies/evidence-publications',
        body: {
          'strategyId': strategyId,
          'from': from.toUtc().toIso8601String(),
          'to': to.toUtc().toIso8601String(),
          'ownerReviewed': true
        },
        decode: (value) => StrategyPublication(
            id: (value as Map)['id'] as String,
            url: api.resolve(value['path'] as String)),
      );
  @override
  Future<void> revokePublication(String publicationId) => api.delete(
        '/strategies/evidence-publications/$publicationId',
        decode: (_) {},
      );
  @override
  Future<Map<String, dynamic>> pnl(String id) => api.get(
        '/strategies/$id/pnl',
        (value) => Map<String, dynamic>.from(value as Map),
      );
  @override
  Future<List<StrategyAccountingRow>> verifiedAccounting(String id) => api.get(
        '/strategies/$id/verified-accounting',
        (value) => rows(value).map(StrategyAccountingRow.fromJson).toList(),
      );
  @override
  Future<List<Map<String, dynamic>>> orders(String id) =>
      api.get('/strategies/$id/orders', rows);
  @override
  Future<List<Map<String, dynamic>>> fills(String id) =>
      api.get('/strategies/$id/fills', rows);
  @override
  Future<List<Map<String, dynamic>>> riskEvents(String id) =>
      api.get('/strategies/$id/risk-events', rows);
  @override
  Future<bool> killed() => api.get(
        '/strategies/kill-switch',
        (value) => (value as Map)['killed'] == true,
      );
  @override
  Future<void> kill() => api.post('/strategies/kill-switch', decode: (_) {});
  @override
  Future<void> resetKill() =>
      api.post('/strategies/kill-switch/reset', decode: (_) {});
}

final strategyRepositoryProvider = Provider<StrategyRepository>((ref) {
  ref.watch(
    authProvider.select((state) => (state.authenticated, state.address)),
  );
  return HttpStrategyRepository(ref.watch(apiClientProvider));
});

String strategyIdempotencyKey() {
  final random = Random.secure();
  final bytes = List<int>.generate(16, (_) => random.nextInt(256));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  final hex =
      bytes.map((value) => value.toRadixString(16).padLeft(2, '0')).join();
  return '${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-'
      '${hex.substring(16, 20)}-${hex.substring(20)}';
}
