import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'analytics_models.dart';
import 'dashboard_data.dart';
import 'dashboard_export.dart';
import 'dashboard_style.dart';

enum DashboardChartType { bar, line, area }

enum DashboardGrain { day, week, month }

List<AnalyticsPoint> aggregateAnalyticsDays(
    List<AnalyticsPoint> points, DashboardGrain grain) {
  if (grain == DashboardGrain.day) return points;
  final groups = <DateTime, List<AnalyticsPoint>>{};
  for (final point in points) {
    final date = point.at.toUtc();
    final day = DateTime.utc(date.year, date.month, date.day);
    final bucket = grain == DashboardGrain.month
        ? DateTime.utc(date.year, date.month)
        : day.subtract(Duration(days: day.weekday - 1));
    groups.putIfAbsent(bucket, () => []).add(point);
  }
  return groups.entries.map((group) {
    final values = group.value;
    final continuous =
        values.last.at.difference(values.first.at).inDays == values.length - 1;
    return AnalyticsPoint(group.key,
        continuous ? AnalyticsDecimal.sum(values.map((v) => v.value)) : null);
  }).toList();
}

/// Cumulative volume starts at the first observed bucket. An unknown bucket
/// makes all subsequent cumulative values unknown, rather than starting over.
List<AnalyticsPoint> cumulativeAnalyticsPoints(List<AnalyticsPoint> points) {
  AnalyticsDecimal? sum;
  DateTime? previous;
  var gap = false;
  return points.map((point) {
    if (point.value == null ||
        (previous != null && point.at.difference(previous!).inDays > 1)) {
      gap = true;
    }
    previous = point.at;
    if (gap) return AnalyticsPoint(point.at, null);
    final value = AnalyticsDecimal.parse(point.value!);
    sum = sum == null ? value : sum! + value;
    return AnalyticsPoint(point.at, sum.toString());
  }).toList();
}

String analyticsCsv(List<DashboardSeries> series) {
  String cell(String value) {
    // Excel/Sheets must not evaluate a user-controlled series name as a formula.
    final safe = RegExp(r'^[=+@\t\r]').hasMatch(value) ||
            (value.startsWith('-') &&
                !RegExp(r'^-\d+(\.\d+)?$').hasMatch(value))
        ? "'$value"
        : value;
    return '"${safe.replaceAll('"', '""')}"';
  }

  final times = series.expand((s) => s.points.map((p) => p.at)).toSet().toList()
    ..sort();
  final values = [
    for (final s in series) {for (final p in s.points) p.at: p.value}
  ];
  return '${[
    ['time_utc', ...series.map((s) => s.label)].map(cell).join(','),
    for (final at in times)
      [wireTime(at), for (final column in values) column[at] ?? '']
          .map(cell)
          .join(','),
  ].join('\r\n')}\r\n';
}

class DashboardChartCard extends ConsumerStatefulWidget {
  const DashboardChartCard(
      {super.key,
      required this.title,
      required this.description,
      required this.series,
      this.source,
      this.asOf,
      this.stale = false,
      this.loading = false,
      this.unavailableReason = 'No observed values in this range.',
      this.coverage,
      this.initialType = DashboardChartType.bar,
      this.money = true,
      this.percent = false,
      this.cumulative = false,
      this.granularity = false,
      this.brush = false,
      this.stacked = false,
      this.snapshot,
      this.retry,
      this.colors,
      this.lineSeries = const {},
      this.note});
  final String title, description, unavailableReason;
  final List<DashboardSeries> series;
  final String? source, coverage, snapshot, note;
  final DateTime? asOf;
  final bool stale,
      loading,
      money,
      percent,
      cumulative,
      granularity,
      brush,
      stacked;
  final DashboardChartType initialType;
  final VoidCallback? retry;
  final List<Color>? colors;
  final Set<String> lineSeries;
  @override
  ConsumerState<DashboardChartCard> createState() => _DashboardChartCardState();
}

class _DashboardChartCardState extends ConsumerState<DashboardChartCard> {
  late DashboardChartType type = widget.initialType;
  DashboardGrain grain = DashboardGrain.day;
  final hidden = <String>{};
  RangeValues range = const RangeValues(0, 1);
  int? selected;
  @override
  void didUpdateWidget(covariant DashboardChartCard oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.series != widget.series) selected = null;
    if (oldWidget.series.isNotEmpty &&
        widget.series.isNotEmpty &&
        (oldWidget.series.first.points.firstOrNull?.at !=
                widget.series.first.points.firstOrNull?.at ||
            oldWidget.series.first.points.lastOrNull?.at !=
                widget.series.first.points.lastOrNull?.at)) {
      range = const RangeValues(0, 1);
    }
  }

  List<DashboardSeries> get visible {
    final active =
        widget.series.where((s) => !hidden.contains(s.label)).toList();
    if (active.isEmpty) return [];
    final times = active
        .expand((s) => s.points.where((p) => p.value != null).map((p) => p.at))
        .toList()
      ..sort();
    if (times.isEmpty) return [];
    // Trim only unsupported tails; preserve every gap between observations.
    final from = times.first;
    final to = times.last;
    final aligned = active
        .map((s) => DashboardSeries(
            s.label,
            s.points
                .where((p) => !p.at.isBefore(from) && !p.at.isAfter(to))
                .toList(),
            marketId: s.marketId))
        .toList();
    final count = aligned.first.points.length;
    if (count == 0) return [];
    final first = (range.start * (count - 1)).floor();
    final last = (range.end * (count - 1)).ceil();
    final lower = aligned.first.points[first].at;
    final upper = aligned.first.points[last].at;
    final cropped = [
      for (final s in aligned)
        DashboardSeries(
            s.label,
            s.points
                .where((p) => !p.at.isBefore(lower) && !p.at.isAfter(upper))
                .toList(),
            marketId: s.marketId)
    ];
    final aggregated = [
      for (final s in cropped)
        DashboardSeries(s.label, aggregateAnalyticsDays(s.points, grain),
            marketId: s.marketId)
    ];
    if (widget.cumulative && cropped.isNotEmpty) {
      final points = cropped.first.points;
      final sums = [
        for (var i = 0; i < points.length; i++)
          AnalyticsPoint(
              points[i].at,
              AnalyticsDecimal.sum(cropped.map((s) =>
                  s.points.length > i && s.points[i].at == points[i].at
                      ? s.points[i].value
                      : null)))
      ];
      final cumulative = cumulativeAnalyticsPoints(sums);
      // Weekly/monthly cumulative values are last known values, never sums.
      final grouped = <DateTime, AnalyticsPoint>{};
      for (var i = 0; i < sums.length; i++) {
        final key = aggregateAnalyticsDays([sums[i]], grain).first.at;
        grouped[key] = AnalyticsPoint(key, cumulative[i].value);
      }
      aggregated.add(DashboardSeries(
          'Cumulative · visible period', grouped.values.toList()));
    }
    return aggregated;
  }

  Future<void> _export(List<DashboardSeries> series) async {
    try {
      final result = await exportAnalyticsCsv(
          'eyeler-${widget.title.toLowerCase().replaceAll(RegExp(r'[^a-z0-9]+'), '-')}.csv',
          analyticsCsv(series));
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(result)));
      }
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
            content: Text('CSV export unavailable. Please retry.')));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final series = visible;
    final hasData = series.any((s) => s.points.any((p) => p.value != null));
    final times = series
        .expand((s) => s.points.map((p) => p.at))
        .toSet()
        .toList()
      ..sort();
    final selectedAt =
        selected != null && selected! < times.length ? times[selected!] : null;
    final age = widget.asOf == null
        ? null
        : ref
            .watch(dashboardNowProvider)()
            .toUtc()
            .difference(widget.asOf!)
            .inSeconds
            .clamp(0, 999999999);
    final freshness = age == null
        ? ''
        : age < 60
            ? 'updated ${age}s ago'
            : age < 3600
                ? 'updated ${age ~/ 60}m ago'
                : 'observed ${utcDate(widget.asOf!)}';
    return DashboardCard(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Expanded(
            child:
                Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(widget.title,
              style:
                  const TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
          const SizedBox(height: 6),
          Text(
              widget.granularity && grain != DashboardGrain.day
                  ? '${grain == DashboardGrain.week ? 'Weekly' : 'Monthly'} sums of visible daily buckets; edge buckets can cover fewer days.'
                  : widget.description,
              style: const TextStyle(
                  fontSize: 12, height: 1.5, color: AnalyticsPalette.muted)),
        ])),
        IconButton(
            tooltip: 'Export ${widget.title} CSV',
            onPressed: hasData ? () => _export(series) : null,
            icon: const Icon(Icons.download_outlined, size: 19)),
      ]),
      if (widget.loading) ...[
        const SizedBox(height: 22),
        const DashboardSkeleton()
      ] else if (!hasData) ...[
        if (widget.snapshot != null)
          Padding(
              padding: const EdgeInsets.only(top: 22),
              child: Tooltip(
                  message: widget.snapshot!,
                  child: Text(
                      AnalyticsNumbers.compact(widget.snapshot, places: 2),
                      style: const TextStyle(
                          fontSize: 40, fontWeight: FontWeight.w600)))),
        if (widget.snapshot == null)
          DashboardUnavailable(
              hidden.length == widget.series.length && hidden.isNotEmpty
                  ? 'Select a series to show its values.'
                  : widget.unavailableReason,
              retry: widget.retry)
        else
          Padding(
              padding: const EdgeInsets.symmetric(vertical: 16),
              child: Text(widget.unavailableReason,
                  style: const TextStyle(
                      fontSize: 12, color: AnalyticsPalette.muted))),
      ] else ...[
        const SizedBox(height: 12),
        Wrap(
            spacing: 12,
            runSpacing: 4,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              Row(mainAxisSize: MainAxisSize.min, children: [
                for (final kind in DashboardChartType.values)
                  Tooltip(
                      message: '${kind.name} chart',
                      child: IconButton(
                          key: ValueKey('${widget.title}_${kind.name}'),
                          onPressed: () => setState(() => type = kind),
                          style: IconButton.styleFrom(
                              backgroundColor: type == kind
                                  ? AnalyticsPalette.elevated
                                  : Colors.transparent,
                              foregroundColor: type == kind
                                  ? AnalyticsPalette.text
                                  : AnalyticsPalette.muted),
                          icon: Icon(
                              switch (kind) {
                                DashboardChartType.bar => Icons.bar_chart,
                                DashboardChartType.line => Icons.show_chart,
                                DashboardChartType.area =>
                                  Icons.area_chart_outlined
                              },
                              size: 18))),
              ]),
              if (widget.granularity)
                Row(mainAxisSize: MainAxisSize.min, children: [
                  for (final item in DashboardGrain.values)
                    TextButton(
                        key: ValueKey('${widget.title}_${item.name}'),
                        onPressed: () => setState(() {
                              grain = item;
                              selected = null;
                            }),
                        style: TextButton.styleFrom(
                            foregroundColor: grain == item
                                ? AnalyticsPalette.text
                                : AnalyticsPalette.muted,
                            backgroundColor: grain == item
                                ? AnalyticsPalette.elevated
                                : null),
                        child: Text(switch (item) {
                          DashboardGrain.day => 'D',
                          DashboardGrain.week => 'W',
                          DashboardGrain.month => 'M'
                        })),
                ]),
            ]),
        const SizedBox(height: 14),
        LayoutBuilder(builder: (context, constraints) {
          final height = constraints.maxWidth < 500 ? 190.0 : 230.0;
          return Semantics(
              label:
                  '${widget.title} chart. ${times.length} dates. Use left and right to inspect exact values.',
              onIncrease: () => setState(() =>
                  selected = ((selected ?? -1) + 1).clamp(0, times.length - 1)),
              onDecrease: () => setState(() =>
                  selected = ((selected ?? 1) - 1).clamp(0, times.length - 1)),
              child: Focus(
                onKeyEvent: (_, event) {
                  if (event is! KeyDownEvent ||
                      (event.logicalKey != LogicalKeyboardKey.arrowLeft &&
                          event.logicalKey != LogicalKeyboardKey.arrowRight)) {
                    return KeyEventResult.ignored;
                  }
                  setState(() => selected = ((selected ?? -1) +
                          (event.logicalKey == LogicalKeyboardKey.arrowRight
                              ? 1
                              : -1))
                      .clamp(0, times.length - 1));
                  return KeyEventResult.handled;
                },
                child: MouseRegion(
                    onHover: (event) => _select(
                        event.localPosition.dx, constraints.maxWidth, times),
                    child: GestureDetector(
                      behavior: HitTestBehavior.opaque,
                      onTapDown: (event) => _select(
                          event.localPosition.dx, constraints.maxWidth, times),
                      onHorizontalDragUpdate: (event) => _select(
                          event.localPosition.dx, constraints.maxWidth, times),
                      child: CustomPaint(
                          key: ValueKey('plot_${widget.title}'),
                          size: Size(constraints.maxWidth, height),
                          painter: _DashboardPainter(series, type,
                              stacked: widget.stacked,
                              cumulative: widget.cumulative,
                              selectedAt: selectedAt,
                              colors: [
                                for (final s in series)
                                  (widget.colors ??
                                      AnalyticsPalette.series)[math.max(
                                          0,
                                          widget.series.indexWhere((original) =>
                                              original.label == s.label)) %
                                      (widget.colors ?? AnalyticsPalette.series)
                                          .length]
                              ],
                              fontFamily: Theme.of(context)
                                  .textTheme
                                  .bodyMedium
                                  ?.fontFamily,
                              money: widget.money,
                              percent: widget.percent,
                              lineSeries: widget.lineSeries,
                              grain: grain)),
                    )),
              ));
        }),
        if (selectedAt != null)
          Container(
              key: ValueKey('tooltip_${widget.title}'),
              width: double.infinity,
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                  color: AnalyticsPalette.elevated,
                  borderRadius: BorderRadius.circular(6)),
              child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(utcExact(selectedAt),
                        style: const TextStyle(
                            fontSize: 11, color: AnalyticsPalette.muted)),
                    for (final s in series)
                      Text(
                          '${s.label}: ${s.points.where((p) => p.at == selectedAt).firstOrNull?.value ?? '—'}${widget.percent ? '%' : ''}',
                          style: const TextStyle(fontSize: 12, height: 1.7)),
                  ])),
        if (widget.brush && times.length > 1) ...[
          const SizedBox(height: 4),
          Semantics(
              label: 'Visible date range',
              child: RangeSlider(
                  key: ValueKey('brush_${widget.title}'),
                  values: range,
                  labels: RangeLabels('${(range.start * 100).round()}%',
                      '${(range.end * 100).round()}%'),
                  onChanged: (value) => setState(() {
                        range = value;
                        selected = null;
                      }))),
          const Text(
              'Drag to inspect a date range. CSV exports only visible values.',
              style: TextStyle(fontSize: 11, color: AnalyticsPalette.muted)),
        ],
      ],
      if (widget.series.any((s) => s.points.any((p) => p.value != null)) &&
          !widget.loading)
        Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Wrap(spacing: 6, runSpacing: 4, children: [
              for (var i = 0; i < widget.series.length; i++)
                FilterChip(
                    key: ValueKey(
                        'legend_${widget.title}_${widget.series[i].label}'),
                    selected: !hidden.contains(widget.series[i].label),
                    showCheckmark: false,
                    avatar: CircleAvatar(
                        radius: 4,
                        backgroundColor:
                            (widget.colors ?? AnalyticsPalette.series)[i %
                                (widget.colors ?? AnalyticsPalette.series)
                                    .length]),
                    label: Text(widget.series[i].label,
                        style: const TextStyle(fontSize: 11)),
                    materialTapTargetSize: MaterialTapTargetSize.padded,
                    onSelected: (value) => setState(() {
                          value
                              ? hidden.remove(widget.series[i].label)
                              : hidden.add(widget.series[i].label);
                          selected = null;
                        })),
              if (widget.cumulative && hasData)
                const Padding(
                    padding: EdgeInsets.all(12),
                    child: Text('Cumulative · right axis',
                        style: TextStyle(
                            fontSize: 11, color: AnalyticsPalette.muted))),
            ])),
      if (widget.note != null)
        Padding(
            padding: const EdgeInsets.only(top: 10),
            child: Text(widget.note!,
                style: const TextStyle(
                    fontSize: 11, height: 1.5, color: AnalyticsPalette.muted))),
      const SizedBox(height: 16),
      const Divider(),
      const SizedBox(height: 12),
      Text(
          [
            widget.source ?? 'Source unavailable',
            if (freshness.isNotEmpty) freshness,
            if (widget.stale) dashboardDataNotice,
            if (widget.coverage != null) widget.coverage!
          ].join(' · '),
          style: const TextStyle(
              fontSize: 10, height: 1.6, color: AnalyticsPalette.muted)),
    ]));
  }

  void _select(double dx, double width, List<DateTime> times) {
    if (times.isEmpty) return;
    final ratio =
        ((dx - 50) / math.max(1, width - (widget.cumulative ? 108 : 62)))
            .clamp(0.0, 1.0);
    final stamp = times.first.millisecondsSinceEpoch +
        ratio *
            (times.last.millisecondsSinceEpoch -
                times.first.millisecondsSinceEpoch);
    var closest = 0;
    for (var i = 1; i < times.length; i++) {
      if ((times[i].millisecondsSinceEpoch - stamp).abs() <
          (times[closest].millisecondsSinceEpoch - stamp).abs()) {
        closest = i;
      }
    }
    setState(() => selected = closest);
  }
}

class _DashboardPainter extends CustomPainter {
  _DashboardPainter(this.series, this.type,
      {required this.stacked,
      required this.cumulative,
      required this.selectedAt,
      required this.colors,
      required this.money,
      required this.percent,
      required this.lineSeries,
      required this.grain,
      this.fontFamily});
  final List<DashboardSeries> series;
  final DashboardChartType type;
  final bool stacked, cumulative, money, percent;
  final List<Color> colors;
  final Set<String> lineSeries;
  final DateTime? selectedAt;
  final DashboardGrain grain;
  final String? fontFamily;

  @override
  void paint(Canvas canvas, Size size) {
    final rect = Rect.fromLTRB(
        50, 14, size.width - (cumulative ? 58 : 12), size.height - 30);
    if (rect.width <= 0) return;
    final times = series
        .expand((s) => s.points.map((p) => p.at))
        .toSet()
        .toList()
      ..sort();
    if (times.isEmpty) return;
    final ordinary =
        cumulative ? series.take(series.length - 1).toList() : series;
    double value(String? raw) => double.tryParse(raw ?? '') ?? 0;
    final numbers = ordinary
        .expand((s) =>
            s.points.where((p) => p.value != null).map((p) => value(p.value)))
        .toList();
    if (numbers.isEmpty) return;
    var low = math.min(0.0, numbers.reduce(math.min));
    var high = math.max(0.0, numbers.reduce(math.max));
    if (stacked && ordinary.length > 1) {
      high = math.max(
          high,
          times
              .map((at) => ordinary.fold(
                  0.0,
                  (sum, s) =>
                      sum +
                      math.max(
                          0,
                          value(s.points
                              .where((p) => p.at == at)
                              .firstOrNull
                              ?.value))))
              .reduce(math.max));
    }
    if (high == low) high = low + 1;
    final pad = (high - low) * .06;
    high += pad;
    if (low < 0) low -= pad;
    final span = times.last.difference(times.first).inMilliseconds;
    final pointWidth =
        math.min(26.0, rect.width / math.max(times.length, 1) * .72);
    double x(DateTime at) => span == 0
        ? rect.center.dx
        : rect.left +
            pointWidth / 2 +
            at.difference(times.first).inMilliseconds /
                span *
                (rect.width - pointWidth);
    double y(double v) => rect.bottom - (v - low) / (high - low) * rect.height;
    String axis(double v) =>
        '${AnalyticsNumbers.compact(v.toStringAsFixed(percent ? 6 : 2), money: money, places: percent ? 3 : 0)}${percent ? '%' : ''}';
    final grid = Paint()
      ..color = AnalyticsPalette.border.withValues(alpha: .5)
      ..strokeWidth = 1;
    for (var i = 0; i <= 3; i++) {
      final v = low + (high - low) * i / 3;
      final py = y(v);
      canvas.drawLine(Offset(rect.left, py), Offset(rect.right, py), grid);
      _text(canvas, axis(v), Offset(0, py - 6), 48);
    }
    const months = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec'
    ];
    for (final at in {times.first, times[times.length ~/ 2], times.last}) {
      _text(
          canvas,
          '${months[at.month - 1]} ${at.day}',
          Offset(
              (x(at) - 20).clamp(rect.left, rect.right - 42), rect.bottom + 12),
          46);
    }
    canvas.save();
    canvas.clipRect(Rect.fromLTRB(rect.left - pointWidth, rect.top,
        rect.right + pointWidth, rect.bottom + 1));
    final stacks = <DateTime, double>{};
    for (var index = 0; index < ordinary.length; index++) {
      final s = ordinary[index];
      final color = colors[index % colors.length];
      final kind =
          lineSeries.contains(s.label) ? DashboardChartType.line : type;
      if (kind == DashboardChartType.bar) {
        for (final p in s.points) {
          if (p.value == null) continue;
          final v = value(p.value);
          final base = stacked ? stacks[p.at] ?? 0 : 0.0;
          final w = stacked
              ? pointWidth
              : pointWidth /
                  math.max(
                      ordinary
                          .where((s) => !lineSeries.contains(s.label))
                          .length,
                      1);
          final dx = x(p.at) - pointWidth / 2 + (stacked ? 0 : index * w);
          final top = y(base + v), bottom = y(base);
          canvas.drawRect(
              Rect.fromLTRB(dx, math.min(top, bottom), dx + w * .92,
                  math.max(top, bottom)),
              Paint()..color = color);
          if (stacked) stacks[p.at] = base + v;
        }
      } else {
        final segments = <List<Offset>>[];
        var segment = <Offset>[];
        DateTime? previous;
        final maxGap = grain == DashboardGrain.day
            ? 1
            : grain == DashboardGrain.week
                ? 7
                : 31;
        for (final p in s.points) {
          if (p.value == null ||
              (previous != null && p.at.difference(previous).inDays > maxGap)) {
            if (segment.isNotEmpty) segments.add(segment);
            segment = [];
          }
          if (p.value != null) segment.add(Offset(x(p.at), y(value(p.value))));
          previous = p.at;
        }
        if (segment.isNotEmpty) segments.add(segment);
        for (final points in segments) {
          final path = Path()..moveTo(points.first.dx, points.first.dy);
          for (final point in points.skip(1)) {
            path.lineTo(point.dx, point.dy);
          }
          if (kind == DashboardChartType.area) {
            final area = Path.from(path)
              ..lineTo(points.last.dx, y(0))
              ..lineTo(points.first.dx, y(0))
              ..close();
            canvas.drawPath(
                area,
                Paint()
                  ..shader = LinearGradient(
                      begin: Alignment.topCenter,
                      end: Alignment.bottomCenter,
                      colors: [
                        color.withValues(alpha: .28),
                        color.withValues(alpha: .015)
                      ]).createShader(rect));
          }
          canvas.drawPath(
              path,
              Paint()
                ..color = color
                ..style = PaintingStyle.stroke
                ..strokeWidth = 2);
          if (points.length == 1) {
            canvas.drawCircle(points.first, 3, Paint()..color = color);
          }
        }
      }
    }
    if (cumulative) {
      final cumulativePoints =
          series.last.points.where((p) => p.value != null).toList();
      if (cumulativePoints.isNotEmpty) {
        final maxCumulative = math.max(
            1.0, cumulativePoints.map((p) => value(p.value)).reduce(math.max));
        final path = Path();
        for (var i = 0; i < cumulativePoints.length; i++) {
          final p = cumulativePoints[i];
          final px = x(p.at),
              py = rect.bottom - value(p.value) / maxCumulative * rect.height;
          i == 0 ? path.moveTo(px, py) : path.lineTo(px, py);
        }
        canvas.drawPath(
            path,
            Paint()
              ..color = AnalyticsPalette.text
              ..style = PaintingStyle.stroke
              ..strokeWidth = 1.6);
        canvas.restore();
        for (var i = 0; i <= 3; i++) {
          _text(
              canvas,
              axis(maxCumulative * i / 3),
              Offset(rect.right + 8, rect.bottom - i / 3 * rect.height - 6),
              50);
        }
        canvas.save();
      }
    }
    if (selectedAt != null) {
      canvas.drawLine(
          Offset(x(selectedAt!), rect.top),
          Offset(x(selectedAt!), rect.bottom),
          Paint()
            ..color = AnalyticsPalette.muted
            ..strokeWidth = 1);
    }
    canvas.restore();
  }

  void _text(Canvas canvas, String text, Offset offset, double width) {
    final painter = TextPainter(
        text: TextSpan(
            text: text,
            style: TextStyle(
                fontSize: 9,
                color: AnalyticsPalette.muted,
                fontFamily: fontFamily)),
        textDirection: TextDirection.ltr,
        maxLines: 1)
      ..layout(maxWidth: width);
    painter.paint(canvas, offset);
  }

  @override
  bool shouldRepaint(covariant _DashboardPainter oldDelegate) => true;
}
