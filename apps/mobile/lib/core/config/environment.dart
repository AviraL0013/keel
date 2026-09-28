import 'package:flutter_riverpod/flutter_riverpod.dart';

class EyelerConfig {
  const EyelerConfig({required this.apiBaseUrl});
  final String apiBaseUrl;
  factory EyelerConfig.fromEnvironment() => const EyelerConfig(
        apiBaseUrl: String.fromEnvironment('EYELER_API_URL',
            defaultValue: String.fromEnvironment('KEEL_API_URL',
                defaultValue: 'http://localhost:8787')),
      );
}

final configProvider =
    Provider<EyelerConfig>((_) => EyelerConfig.fromEnvironment());
