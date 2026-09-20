import 'package:flutter_riverpod/flutter_riverpod.dart';

class KeelConfig {
  const KeelConfig({required this.apiBaseUrl});
  final String apiBaseUrl;
  factory KeelConfig.fromEnvironment() => const KeelConfig(
        apiBaseUrl: String.fromEnvironment('KEEL_API_URL',
            defaultValue: 'http://localhost:8787'),
      );
}

final configProvider =
    Provider<KeelConfig>((_) => KeelConfig.fromEnvironment());
