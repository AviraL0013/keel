import 'dart:async';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../core/networking/api_client.dart';
import '../domain/book.dart';
import '../../positions/domain/position.dart';
import '../../../shared/models/telemetry_freshness.dart';

class BooksRepository {
  const BooksRepository(this.api);
  final KeelApiClient api;
  Future<List<Book>> list() async {
    final value = await api.get('/books', (body) => body);
    if (value is! List) return const [];
    return value
        .map((item) => Book.fromJson(Map<String, dynamic>.from(item as Map)))
        .toList();
  }

  Future<Book> create(Position position, BookConfiguration config) {
    final error = config.validate();
    if (error != null) throw ArgumentError(error);
    return api.post('/books',
        body: {
          'market': position.market,
          'marketId': position.marketId,
          'venueAccountId': position.accountId,
          'venuePositionId': position.positionId,
          'side': position.side,
          'stance': config.stance,
          'liquidationFloor': config.liquidationFloor,
          'defenseCap': config.defenseCap,
          'timeLimitMs': config.timeLimit.inMilliseconds,
          'automationEnabled': config.automation,
          'reserveAvailable': config.reserve
        },
        decode: (value) =>
            Book.fromJson(Map<String, dynamic>.from(value as Map)));
  }

  Future<Map<String, dynamic>> action(String id, String kind) =>
      api.post('/books/$id/actions',
          body: {'kind': kind},
          decode: (value) => Map<String, dynamic>.from(value as Map));
  Future<Map<String, dynamic>> close(String id) => api.post('/books/$id/close',
      decode: (value) => Map<String, dynamic>.from(value as Map));
  Future<Book> control(String id, String action) =>
      api.post('/books/$id/$action',
          decode: (value) =>
              Book.fromJson(Map<String, dynamic>.from(value as Map)));
  Future<BookDashboardState> state(String id) async {
    final raw = await api.get('/books/$id/state', (value) => value);
    final value = Map<String, dynamic>.from(raw as Map);
    final book = Book.fromJson(Map<String, dynamic>.from(value['book'] as Map));
    final marketMap = value['telemetry'] is Map
        ? Map<String, dynamic>.from(value['telemetry'] as Map)
        : <String, dynamic>{};
    final positionMap = value['position'] is Map
        ? Map<String, dynamic>.from(value['position'] as Map)
        : <String, dynamic>{};
    final riskMap = value['risk'] is Map
        ? Map<String, dynamic>.from(value['risk'] as Map)
        : <String, dynamic>{};
    final executionMap = value['execution'] is Map
        ? Map<String, dynamic>.from(value['execution'] as Map)
        : <String, dynamic>{};
    final reserveMap = value['reserve'] is Map
        ? Map<String, dynamic>.from(value['reserve'] as Map)
        : <String, dynamic>{};
    double? number(Object? value) => value is num
        ? value.toDouble()
        : value is String
            ? double.tryParse(value)
            : null;
    return BookDashboardState(
        book: book,
        telemetry: BookTelemetry(
            size: number(positionMap['size']),
            entryPrice: number(positionMap['entryPrice']),
            mark: number(marketMap['mark']),
            oracle: number(marketMap['oracle']),
            bid: number(marketMap['bid']),
            ask: number(marketMap['ask']),
            pnl: number(positionMap['unrealizedPnl']),
            leverage: number(positionMap['leverage']),
            margin: number(positionMap['margin']),
            liquidationPrice: number(positionMap['liquidationPrice']),
            fundingRate: number(marketMap['fundingRate']),
            depthNotional: number(marketMap['depthNotional']),
            reserveAvailable: number(reserveMap['available']),
            reserveDeployed: number(reserveMap['deployed']),
            liquidationDistance: number(marketMap['liquidationDistance']),
            freshnessMs: marketMap['freshnessMs'] is num
                ? (marketMap['freshnessMs'] as num).toInt()
                : null,
            freshness: marketMap['freshness'] == null
                ? null
                : TelemetryFreshnessModel.fromJson(marketMap['freshness']),
            riskState: riskMap['state'] as String?,
            riskStatus: riskMap['status'] as String?,
            riskReason: riskMap['reason'] as String?,
            reasonCodes: riskMap['reasonCodes'] is List
                ? (riskMap['reasonCodes'] as List)
                    .map((item) => item.toString())
                    .toList()
                : const [],
            reasons: riskMap['reasons'] is List
                ? (riskMap['reasons'] as List)
                    .map((item) => item.toString())
                    .toList()
                : const [],
            executionState: executionMap['status'] as String?,
            executionReason: executionMap['reason'] as String?,
            executionActionId: executionMap['actionId'] as String?,
            positionStatus: positionMap['status'] as String?));
  }

  Future<BookTelemetry> telemetry(String id) async {
    return (await state(id)).telemetry;
  }
}

final booksRepositoryProvider = Provider<BooksRepository>(
    (ref) => BooksRepository(ref.watch(apiClientProvider)));
final booksProvider = FutureProvider.autoDispose<List<Book>>(
    (ref) => ref.watch(booksRepositoryProvider).list());
final bookDashboardProvider = AsyncNotifierProvider.autoDispose
    .family<BookDashboardController, BookDashboardState, String>(
        BookDashboardController.new);

class BookDashboardController
    extends AutoDisposeFamilyAsyncNotifier<BookDashboardState, String> {
  Timer? _timer;
  var _disposed = false;

  @override
  Future<BookDashboardState> build(String id) async {
    ref.onDispose(() {
      _disposed = true;
      _timer?.cancel();
    });
    final value = await ref.watch(booksRepositoryProvider).state(id);
    _timer = Timer.periodic(const Duration(seconds: 3), (_) => refreshNow());
    return value;
  }

  Future<void> refreshNow() async {
    if (_disposed || state.isLoading) return;
    final current = state.value;
    try {
      state = AsyncData(await ref.read(booksRepositoryProvider).state(arg));
    } catch (error, stack) {
      if (current != null) {
        state = AsyncData(current);
      } else {
        state = AsyncError(error, stack);
      }
    }
  }
}

final bookTelemetryProvider = FutureProvider.family.autoDispose<BookTelemetry, String>(
    (ref, id) async => (await ref.watch(bookDashboardProvider(id).future)).telemetry);
