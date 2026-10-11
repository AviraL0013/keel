import 'package:flutter/services.dart';

Future<String> exportAnalyticsCsv(String filename, String content) async {
  await Clipboard.setData(ClipboardData(text: content));
  return 'CSV copied';
}
