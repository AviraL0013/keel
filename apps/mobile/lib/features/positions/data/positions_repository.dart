import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../core/networking/api_client.dart';
import '../domain/position.dart';
class PositionsRepository { const PositionsRepository(this.api); final KeelApiClient api; Future<List<Position>> list() async { final result = await api.get('/connections/perpl/positions', (value) => Map<String, dynamic>.from(value as Map)); final rows = result['positions']; if (rows is! List) return const []; return rows.map((item) => Position.fromJson(Map<String, dynamic>.from(item as Map))).toList(); } }
class PerplConnectionState { const PerplConnectionState({required this.status, this.environment}); final String status; final String? environment; factory PerplConnectionState.fromJson(Map<String, dynamic> json) => PerplConnectionState(status: json['status'] as String? ?? 'UNKNOWN', environment: (json['connections'] is List && (json['connections'] as List).isNotEmpty) ? ((json['connections'].first as Map)['environment'] as String?) : null); }
extension PositionsConnection on PositionsRepository { Future<PerplConnectionState> validatePerpl() => api.post('/connections/perpl/validate', decode: (value) => PerplConnectionState.fromJson(Map<String, dynamic>.from(value as Map))); }
final positionsRepositoryProvider = Provider<PositionsRepository>((ref) => PositionsRepository(ref.watch(apiClientProvider)));
final positionsProvider = FutureProvider.autoDispose<List<Position>>((ref) => ref.watch(positionsRepositoryProvider).list());
final perplConnectionProvider = FutureProvider.autoDispose<PerplConnectionState>((ref) => ref.watch(positionsRepositoryProvider).validatePerpl());
