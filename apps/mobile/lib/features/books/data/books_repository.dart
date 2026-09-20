import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../core/networking/api_client.dart';
import '../domain/book.dart';
import '../../positions/domain/position.dart';

class BooksRepository {
  const BooksRepository(this.api);
  final KeelApiClient api;
  Future<List<Book>> list() async { final value = await api.get('/books', (body) => body); if (value is! List) return const []; return value.map((item) => Book.fromJson(Map<String, dynamic>.from(item as Map))).toList(); }
  Future<Book> create(Position position, BookConfiguration config) { final error = config.validate(); if (error != null) throw ArgumentError(error); return api.post('/books', body: {'market': position.market, 'marketId': position.marketId, 'venueAccountId': position.accountId, 'venuePositionId': position.positionId, 'side': position.side, 'stance': config.stance, 'liquidationFloor': config.liquidationFloor, 'defenseCap': config.defenseCap, 'timeLimitMs': config.timeLimit.inMilliseconds, 'automationEnabled': config.automation, 'reserveAvailable': config.reserve}, decode: (value) => Book.fromJson(Map<String, dynamic>.from(value as Map))); }
  Future<Map<String, dynamic>> action(String id, String kind) => api.post('/books/$id/actions', body: {'kind': kind}, decode: (value) => Map<String, dynamic>.from(value as Map));
  Future<Map<String, dynamic>> close(String id) => api.post('/books/$id/close', decode: (value) => Map<String, dynamic>.from(value as Map));
  Future<Book> control(String id, String action) => api.post('/books/$id/$action', decode: (value) => Book.fromJson(Map<String, dynamic>.from(value as Map)));
  Future<BookTelemetry> telemetry(String id) async {
    final risk = await api.get('/books/$id/risk', (value) => value);
    final market = await api.get('/books/$id/telemetry', (value) => value);
    final position = await api.get('/books/$id/position', (value) => value);
    final actions = await api.get('/books/$id/actions', (value) => value);
    final reserve = await api.get('/books/$id/reserve', (value) => value);
    final riskMap = risk is Map ? Map<String, dynamic>.from(risk) : <String, dynamic>{};
    final marketMap = market is Map ? Map<String, dynamic>.from(market) : <String, dynamic>{};
    final positionMap = position is Map ? Map<String, dynamic>.from(position) : <String, dynamic>{};
    final actionRows = actions is List ? actions : const [];
    final executionState = actionRows.isNotEmpty && actionRows.first is Map ? (actionRows.first as Map)['status'] as String? : null;
    final reserveMap = reserve is Map ? Map<String, dynamic>.from(reserve) : <String, dynamic>{};
    double? number(Object? value) => value is num ? value.toDouble() : value is String ? double.tryParse(value) : null;
    return BookTelemetry(size: number(positionMap['size']), entryPrice: number(positionMap['entryPrice']), mark: number(marketMap['mark']), oracle: number(marketMap['oracle']), bid: number(marketMap['bid']), ask: number(marketMap['ask']), pnl: number(positionMap['unrealizedPnl']), leverage: number(positionMap['leverage']), margin: number(positionMap['margin']), liquidationPrice: number(positionMap['liquidationPrice']), fundingRate: number(marketMap['fundingRate']), depthNotional: number(marketMap['depthNotional']), reserveAvailable: number(reserveMap['available']), reserveDeployed: number(reserveMap['deployed']), freshnessMs: marketMap['freshnessMs'] is num ? (marketMap['freshnessMs'] as num).toInt() : null, riskState: riskMap['state'] as String?, reasonCodes: riskMap['reasonCodes'] is List ? (riskMap['reasonCodes'] as List).whereType<String>().toList() : const [], reasons: riskMap['humanReadableReasons'] is List ? (riskMap['humanReadableReasons'] as List).whereType<String>().toList() : const [], executionState: executionState, positionStatus: positionMap['status'] as String?);
  }
}
final booksRepositoryProvider = Provider<BooksRepository>((ref) => BooksRepository(ref.watch(apiClientProvider)));
final booksProvider = FutureProvider.autoDispose<List<Book>>((ref) => ref.watch(booksRepositoryProvider).list());
final bookTelemetryProvider = FutureProvider.family.autoDispose<BookTelemetry, String>((ref, id) => ref.watch(booksRepositoryProvider).telemetry(id));
