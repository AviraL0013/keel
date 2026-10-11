// Browser download stays dependency-free; other platforms use the clipboard.
// Conditional import keeps this browser-only adapter out of native builds.
// ignore: deprecated_member_use, avoid_web_libraries_in_flutter
import 'dart:html' as html;

Future<String> exportAnalyticsCsv(String filename, String content) async {
  final blob = html.Blob([content], 'text/csv;charset=utf-8');
  final url = html.Url.createObjectUrlFromBlob(blob);
  final anchor = html.AnchorElement(href: url)..download = filename;
  html.document.body!.append(anchor);
  anchor.click();
  anchor.remove();
  // Let the browser consume the URL before releasing it.
  Future<void>.delayed(
      const Duration(seconds: 2), () => html.Url.revokeObjectUrl(url));
  return 'CSV downloaded';
}
