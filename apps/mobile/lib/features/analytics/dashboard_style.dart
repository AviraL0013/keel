import 'package:flutter/material.dart';

import '../../core/theme/app_theme.dart';
import 'analytics_models.dart';

abstract final class AnalyticsPalette {
  static const background = Color(0xFF090B11);
  static const surface = Color(0xFF10131C);
  static const elevated = Color(0xFF171B27);
  static const border = Color(0xFF292E3D);
  static const muted = Color(0xFFA6ADBF);
  static const text = Color(0xFFF0F2F8);
  static const accent = EyelerColors.accent;
  static const up = EyelerColors.defend;
  static const down = EyelerColors.exit;
  static const series = [
    accent,
    Color(0xFFB7BCFF),
    Color(0xFF777E93),
    Color(0xFFD2D7E5)
  ];
}

const dashboardDataNotice = 'Data may be delayed or incomplete';

class AnalyticsDark extends StatelessWidget {
  const AnalyticsDark({super.key, required this.child});
  final Widget child;
  @override
  Widget build(BuildContext context) {
    final base = EyelerTheme.dark;
    final font = base.textTheme.bodyMedium?.fontFamily;
    return Theme(
        data: base.copyWith(
          scaffoldBackgroundColor: AnalyticsPalette.background,
          colorScheme: base.colorScheme.copyWith(
              surface: AnalyticsPalette.surface,
              onSurface: AnalyticsPalette.text,
              outline: AnalyticsPalette.border),
          textTheme: base.textTheme.apply(
              bodyColor: AnalyticsPalette.text,
              displayColor: AnalyticsPalette.text),
          appBarTheme: base.appBarTheme.copyWith(
              backgroundColor: AnalyticsPalette.background,
              titleTextStyle: base.textTheme.titleLarge),
          cardTheme: const CardThemeData(
              color: AnalyticsPalette.surface,
              elevation: 0,
              margin: EdgeInsets.zero,
              shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.all(Radius.circular(12)),
                  side: BorderSide(color: AnalyticsPalette.border))),
          dividerTheme:
              const DividerThemeData(color: AnalyticsPalette.border, space: 1),
          iconButtonTheme: IconButtonThemeData(
              style: IconButton.styleFrom(
                  minimumSize: const Size(48, 48),
                  foregroundColor: AnalyticsPalette.muted)),
          textButtonTheme: TextButtonThemeData(
              style: TextButton.styleFrom(
                  minimumSize: const Size(48, 48),
                  foregroundColor: AnalyticsPalette.text,
                  textStyle: TextStyle(fontSize: 12, fontFamily: font),
                  shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(8)))),
          chipTheme: base.chipTheme.copyWith(
              labelStyle: base.textTheme.bodyMedium?.copyWith(fontSize: 11),
              shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(6)),
              backgroundColor: AnalyticsPalette.surface,
              selectedColor: AnalyticsPalette.elevated,
              side: const BorderSide(color: AnalyticsPalette.border)),
          outlinedButtonTheme: OutlinedButtonThemeData(
              style: OutlinedButton.styleFrom(
                  minimumSize: const Size(48, 48),
                  foregroundColor: AnalyticsPalette.text,
                  side: const BorderSide(color: AnalyticsPalette.border),
                  shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(8)))),
          inputDecorationTheme: InputDecorationTheme(
              filled: true,
              fillColor: AnalyticsPalette.surface,
              isDense: true,
              hintStyle:
                  const TextStyle(color: AnalyticsPalette.muted, fontSize: 13),
              border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(8),
                  borderSide: const BorderSide(color: AnalyticsPalette.border)),
              enabledBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(8),
                  borderSide:
                      const BorderSide(color: AnalyticsPalette.border))),
        ),
        child: child);
  }
}

class DashboardGrid extends StatelessWidget {
  const DashboardGrid(
      {super.key, required this.children, this.columns = 2, this.gap = 16});
  final List<Widget> children;
  final int columns;
  final double gap;
  @override
  Widget build(BuildContext context) =>
      LayoutBuilder(builder: (context, constraints) {
        final count = constraints.maxWidth >= 1000
            ? columns
            : constraints.maxWidth >= 650
                ? 2
                : 1;
        final width = (constraints.maxWidth - gap * (count - 1)) / count;
        if (columns == 4 && count > 1) {
          // KPI rows share a baseline even when coverage or missing-data
          // explanations wrap. Chart cards keep their natural content height.
          return Column(children: [
            for (var start = 0; start < children.length; start += count) ...[
              if (start > 0) SizedBox(height: gap),
              IntrinsicHeight(
                  child: Row(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                    for (var index = start;
                        index < children.length && index < start + count;
                        index++) ...[
                      if (index > start) SizedBox(width: gap),
                      SizedBox(width: width, child: children[index]),
                    ],
                  ])),
            ],
          ]);
        }
        return Wrap(spacing: gap, runSpacing: gap, children: [
          for (final child in children) SizedBox(width: width, child: child)
        ]);
      });
}

class DashboardCard extends StatelessWidget {
  const DashboardCard({super.key, required this.child, this.padding = 24});
  final Widget child;
  final double padding;
  @override
  Widget build(BuildContext context) => Card(
      child: Padding(
          padding: EdgeInsets.all(
              MediaQuery.sizeOf(context).width < 600 ? 18 : padding),
          child: child));
}

class DashboardKpi extends StatelessWidget {
  const DashboardKpi(
      {super.key,
      required this.label,
      required this.value,
      required this.coverage,
      this.reason,
      this.delta,
      this.money = true,
      this.percent = false,
      this.loading = false,
      this.bare = false,
      this.color});
  final String label, coverage;
  final String? value, reason, delta;
  final bool money, percent, loading, bare;
  final Color? color;
  @override
  Widget build(BuildContext context) {
    final text = value == null
        ? '—'
        : percent
            ? '$value%'
            : AnalyticsNumbers.compact(value, money: money, places: 2);
    final content =
        Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text(label,
          style: const TextStyle(color: AnalyticsPalette.muted, fontSize: 12)),
      const SizedBox(height: 14),
      if (loading)
        const DashboardSkeleton(height: 45)
      else
        Tooltip(
            message: value == null
                ? reason ?? 'The source has not supplied this value.'
                : '${money ? r'$' : ''}$value${percent ? '%' : ''}',
            child: Semantics(
                label: '$label: ${value ?? 'unavailable'}. $coverage',
                child: Text(text,
                    key: ValueKey('value_$label'),
                    maxLines: 1,
                    style: TextStyle(
                        fontSize: bare ? 30 : 38,
                        height: 1.18,
                        fontWeight: FontWeight.w600,
                        color: color ?? AnalyticsPalette.text,
                        letterSpacing: -1.2,
                        fontFeatures: const [FontFeature.tabularFigures()])))),
      const SizedBox(height: 12),
      Wrap(spacing: 8, runSpacing: 5, children: [
        if (delta != null)
          Text('${delta!.startsWith('-') ? '' : '+'}$delta% · 24h',
              style: TextStyle(
                  fontSize: 11,
                  color: delta!.startsWith('-')
                      ? AnalyticsPalette.down
                      : AnalyticsPalette.up)),
        Text(coverage,
            style:
                const TextStyle(fontSize: 11, color: AnalyticsPalette.muted)),
      ]),
      if (!loading && value == null)
        Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Tooltip(
                message: reason ?? 'Not supplied by the source.',
                child: Text(reason ?? 'Not supplied by the source.',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                        fontSize: 11, color: AnalyticsPalette.muted)))),
    ]);
    return bare
        ? Padding(padding: const EdgeInsets.all(20), child: content)
        : DashboardCard(child: content);
  }
}

class DashboardSkeleton extends StatelessWidget {
  const DashboardSkeleton({super.key, this.height = 180});
  final double height;
  @override
  Widget build(BuildContext context) => Semantics(
      label: 'Loading analytics',
      child: Container(
          height: height,
          width: double.infinity,
          decoration: BoxDecoration(
              color: AnalyticsPalette.elevated,
              borderRadius: BorderRadius.circular(6))));
}

class DashboardUnavailable extends StatelessWidget {
  const DashboardUnavailable(this.reason, {super.key, this.retry});
  final String reason;
  final VoidCallback? retry;
  @override
  Widget build(BuildContext context) => Padding(
      padding: const EdgeInsets.symmetric(vertical: 22),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        const Text('—',
            style: TextStyle(fontSize: 38, color: AnalyticsPalette.muted)),
        const SizedBox(height: 8),
        Text(reason,
            style: const TextStyle(
                color: AnalyticsPalette.muted, fontSize: 12, height: 1.6)),
        if (retry != null)
          TextButton.icon(
              onPressed: retry,
              icon: const Icon(Icons.refresh, size: 16),
              label: const Text('Retry')),
      ]));
}
