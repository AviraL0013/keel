import 'dart:math';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../core/networking/api_client.dart';

class OpeningMarket {
  const OpeningMarket(
      {required this.id, required this.symbol, required this.status});
  final int id;
  final String symbol, status;
  factory OpeningMarket.fromJson(Map<String, dynamic> json) => OpeningMarket(
      id: (json['id'] as num).toInt(),
      symbol: json['symbol'] as String,
      status: json['status'] as String);
}

class OpeningPreview {
  const OpeningPreview(
      {required this.id,
      required this.accountId,
      required this.connectionId,
      required this.expiresAt,
      required this.quote});
  final String id, connectionId;
  final int accountId, expiresAt;
  final Map<String, dynamic> quote;
  factory OpeningPreview.fromJson(Map<String, dynamic> json) => OpeningPreview(
      id: json['id'] as String,
      accountId: (json['accountId'] as num).toInt(),
      connectionId: json['connectionId'] as String,
      expiresAt: (json['expiresAt'] as num).toInt(),
      quote: Map<String, dynamic>.from(json['quote'] as Map));
}

class OpeningOrder {
  const OpeningOrder(
      {required this.id,
      required this.status,
      required this.environment,
      required this.accountId,
      required this.marketId,
      required this.side,
      this.positionId,
      this.filledSize,
      this.averagePrice,
      this.txHash,
      this.error});
  final String id, status, environment, side;
  final int accountId, marketId;
  final int? positionId;
  final String? filledSize, averagePrice, txHash, error;
  factory OpeningOrder.fromJson(Map<String, dynamic> json) => OpeningOrder(
      id: json['id'] as String,
      status: json['status'] as String,
      environment: json['environment'] as String,
      accountId: int.parse(json['account_id'].toString()),
      marketId: int.parse(json['market_id'].toString()),
      side: json['side'] as String,
      positionId: json['position_id'] == null
          ? null
          : int.parse(json['position_id'].toString()),
      filledSize: json['filled_size']?.toString(),
      averagePrice: json['average_price']?.toString(),
      txHash: json['tx_hash'] as String?,
      error: json['error'] as String?);
}

abstract class OpeningRepository {
  Future<List<OpeningMarket>> listMarkets();
  Future<Map<String, dynamic>> snapshot(int marketId);
  Future<OpeningPreview> preview(
      int marketId, String side, String size, String leverage, int slippageBps);
  Future<OpeningOrder> confirm(String previewId, String key);
  Future<OpeningOrder> order(String id);
}

class HttpOpeningRepository extends OpeningRepository {
  HttpOpeningRepository(this.api);
  final EyelerApiClient api;
  @override
  Future<List<OpeningMarket>> listMarkets() => api.get(
      '/openings/markets',
      (value) => (value as List)
          .map((row) =>
              OpeningMarket.fromJson(Map<String, dynamic>.from(row as Map)))
          .toList());
  @override
  Future<Map<String, dynamic>> snapshot(int marketId) => api.get(
      '/openings/markets/$marketId/snapshot',
      (value) => Map<String, dynamic>.from(value as Map));
  @override
  Future<OpeningPreview> preview(int marketId, String side, String size,
          String leverage, int slippageBps) =>
      api.post('/openings/previews',
          body: {
            'marketId': marketId,
            'side': side,
            'size': size,
            'leverage': leverage,
            'slippageBps': slippageBps,
          },
          decode: (value) =>
              OpeningPreview.fromJson(Map<String, dynamic>.from(value as Map)));
  @override
  Future<OpeningOrder> confirm(String previewId, String key) =>
      api.post('/openings/confirm',
          body: {'previewId': previewId, 'idempotencyKey': key},
          decode: (value) =>
              OpeningOrder.fromJson(Map<String, dynamic>.from(value as Map)));
  @override
  Future<OpeningOrder> order(String id) => api.get(
      '/openings/$id',
      (value) =>
          OpeningOrder.fromJson(Map<String, dynamic>.from(value as Map)));
}

final openingRepositoryProvider = Provider<OpeningRepository>(
    (ref) => HttpOpeningRepository(ref.watch(apiClientProvider)));

String openingIdempotencyKey() {
  final bytes = List<int>.generate(16, (_) => Random.secure().nextInt(256));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  final hex =
      bytes.map((value) => value.toRadixString(16).padLeft(2, '0')).join();
  return '${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-'
      '${hex.substring(16, 20)}-${hex.substring(20)}';
}
