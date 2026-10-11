import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../core/theme/app_theme.dart';
import 'analytics_models.dart';

typedef AnalyticsBody<T> = Widget Function(
  BuildContext context,
  T value,
  Future<void> Function() refresh,
);

class AnalyticsResource<T> extends StatefulWidget {
  const AnalyticsResource({
    super.key,
    required this.load,
    required this.body,
    required this.isEmpty,
    required this.asOf,
    this.isStale,
    this.emptyMessage = 'No data yet',
  });
  final Future<T> Function() load;
  final AnalyticsBody<T> body;
  final bool Function(T) isEmpty;
  final DateTime Function(T) asOf;
  final bool Function(T)? isStale;
  final String emptyMessage;

  @override
  State<AnalyticsResource<T>> createState() => _AnalyticsResourceState<T>();
}

class _AnalyticsResourceState<T> extends State<AnalyticsResource<T>>
    with WidgetsBindingObserver {
  T? _value;
  Object? _error;
  bool _loading = true;
  Timer? _timer;
  Timer? _clock;
  bool _foreground = true;
  int _generation = 0;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _refresh();
    _timer = Timer.periodic(const Duration(seconds: 15), (_) {
      if (_foreground &&
          !_loading &&
          (ModalRoute.of(context)?.isCurrent ?? true)) {
        _refresh();
      }
    });
    _clock = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted && _value != null) setState(() {});
    });
  }

  @override
  void didUpdateWidget(covariant AnalyticsResource<T> oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.key != widget.key) {
      _value = null;
      _error = null;
      _loading = true;
      _refresh();
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
    if (_foreground && (ModalRoute.of(context)?.isCurrent ?? true)) _refresh();
  }

  Future<void> _refresh() async {
    final generation = ++_generation;
    if (mounted) setState(() => _loading = true);
    try {
      final result = await widget.load();
      if (!mounted || generation != _generation) return;
      setState(() {
        _value = result;
        _error = null;
        _loading = false;
      });
    } catch (error) {
      if (!mounted || generation != _generation) return;
      setState(() {
        _error = error;
        _loading = false;
      });
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    _clock?.cancel();
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final value = _value;
    if (value == null && _loading) return const AnalyticsSkeleton();
    if (value == null) {
      return AnalyticsState(
        message: 'Analytics unavailable',
        action: TextButton(onPressed: _refresh, child: const Text('Retry')),
      );
    }
    if (widget.isEmpty(value)) {
      return AnalyticsState(
        message: widget.emptyMessage,
        action: TextButton(onPressed: _refresh, child: const Text('Refresh')),
      );
    }
    final age = DateTime.now().toUtc().difference(widget.asOf(value));
    final stale = age > const Duration(seconds: 45) ||
        _error != null ||
        (widget.isStale?.call(value) ?? false);
    return RefreshIndicator(
      onRefresh: _refresh,
      child: ListView(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
            child: Row(
              children: [
                Icon(
                  stale ? Icons.warning_amber_rounded : Icons.circle,
                  size: stale ? 18 : 9,
                  color: stale ? EyelerColors.reduce : EyelerColors.defend,
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    stale
                        ? 'Stale data · updated ${age.inSeconds < 0 ? 0 : age.inSeconds}s ago'
                        : 'Updated ${age.inSeconds < 0 ? 0 : age.inSeconds}s ago',
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ),
                if (_loading)
                  const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  ),
                IconButton(
                  tooltip: 'Refresh analytics',
                  onPressed: _refresh,
                  icon: const Icon(Icons.refresh_outlined),
                ),
              ],
            ),
          ),
          if (_error != null)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: Text(
                'Refresh failed. Showing last available data.',
                style: TextStyle(color: Theme.of(context).colorScheme.error),
              ),
            ),
          widget.body(context, value, _refresh),
          const SizedBox(height: 24),
        ],
      ),
    );
  }
}

class AnalyticsSkeleton extends StatelessWidget {
  const AnalyticsSkeleton({super.key});
  @override
  Widget build(BuildContext context) => ListView(
        padding: const EdgeInsets.all(16),
        children: [
          for (final height in [74.0, 108.0, 108.0, 210.0, 160.0])
            Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: Container(
                height: height,
                decoration: BoxDecoration(
                  color: Theme.of(context).colorScheme.surface,
                  borderRadius: BorderRadius.circular(18),
                ),
                child: Semantics(label: 'Loading analytics'),
              ),
            ),
        ],
      );
}

class AnalyticsState extends StatelessWidget {
  const AnalyticsState({super.key, required this.message, this.action});
  final String message;
  final Widget? action;
  @override
  Widget build(BuildContext context) => Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.insights_outlined, size: 32),
              const SizedBox(height: 12),
              Text(message, textAlign: TextAlign.center),
              if (action != null) action!,
            ],
          ),
        ),
      );
}

class AnalyticsPanel extends StatelessWidget {
  const AnalyticsPanel({
    super.key,
    required this.title,
    required this.child,
    this.trailing,
  });
  final String title;
  final Widget child;
  final Widget? trailing;
  @override
  Widget build(BuildContext context) => Card(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(
                      title,
                      style: Theme.of(context).textTheme.titleLarge,
                    ),
                  ),
                  if (trailing != null) trailing!,
                ],
              ),
              const SizedBox(height: 14),
              child,
            ],
          ),
        ),
      );
}

class AnalyticsChart extends StatefulWidget {
  const AnalyticsChart({
    super.key,
    required this.points,
    this.label = 'Time series',
    this.percent = false,
    this.color = EyelerColors.accent,
    this.height = 150,
  });
  final List<AnalyticsPoint> points;
  final String label;
  final bool percent;
  final Color color;
  final double height;
  @override
  State<AnalyticsChart> createState() => _AnalyticsChartState();
}

class _AnalyticsChartState extends State<AnalyticsChart> {
  int? selectedIndex;

  String _display(String value) => widget.percent
      ? '${AnalyticsNumbers.compact(value, money: false, places: 4)}%'
      : AnalyticsNumbers.compact(value, places: 2);

  void _step(int direction) {
    final available = [
      for (var i = 0; i < widget.points.length; i++)
        if (widget.points[i].value != null) i,
    ];
    if (available.isEmpty) return;
    final current = available.indexOf(selectedIndex ?? -1);
    final next = (current + direction).clamp(0, available.length - 1);
    setState(() => selectedIndex = available[next]);
  }

  @override
  void didUpdateWidget(covariant AnalyticsChart oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.points != widget.points) selectedIndex = null;
  }

  void select(double x, double width) {
    if (width <= 0 || widget.points.isEmpty) return;
    final index = widget.points.length == 1
        ? 0
        : (x / width * (widget.points.length - 1))
            .round()
            .clamp(0, widget.points.length - 1)
            .toInt();
    setState(() =>
        selectedIndex = widget.points[index].value == null ? null : index);
  }

  @override
  Widget build(BuildContext context) {
    if (widget.points.isEmpty) {
      return const SizedBox(
        height: 100,
        child: Center(child: Text('No chart data')),
      );
    }
    final available =
        widget.points.where((point) => point.value != null).toList();
    if (available.isEmpty) {
      return SizedBox(
        height: widget.height,
        child: const Center(child: Text('No observed chart values')),
      );
    }
    final sorted = [
      ...available
    ]..sort((a, b) => double.parse(a.value!).compareTo(double.parse(b.value!)));
    final low = sorted.first.value!;
    final high = sorted.last.value!;
    final selected =
        selectedIndex == null ? null : widget.points[selectedIndex!];
    final selectedLabel = selected == null
        ? null
        : '${analyticsLocalTime(selected.at, context)} · ${selected.value}${widget.percent ? '%' : ' AUSD'}';
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Semantics(
          label: '${widget.label} chart, ${available.length} observed values. '
              'Low ${_display(low)}, high ${_display(high)}. '
              'Increase or decrease to inspect points.',
          value: selectedLabel ?? 'No point selected',
          increasedValue: 'Next observed value',
          decreasedValue: 'Previous observed value',
          onIncrease: () => _step(1),
          onDecrease: () => _step(-1),
          child: SizedBox(
            height: widget.height,
            width: double.infinity,
            child: Row(
              children: [
                SizedBox(
                  width: 58,
                  child: Padding(
                    padding: const EdgeInsets.only(bottom: 16),
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(_display(high),
                            maxLines: 1,
                            style: Theme.of(context).textTheme.labelSmall),
                        Text(_display(low),
                            maxLines: 1,
                            style: Theme.of(context).textTheme.labelSmall),
                      ],
                    ),
                  ),
                ),
                Expanded(
                  child: Column(
                    children: [
                      Expanded(
                        child: LayoutBuilder(
                          builder: (context, constraints) => GestureDetector(
                            behavior: HitTestBehavior.opaque,
                            onTapDown: (details) => select(
                                details.localPosition.dx, constraints.maxWidth),
                            onHorizontalDragUpdate: (details) => select(
                                details.localPosition.dx, constraints.maxWidth),
                            child: SizedBox.expand(
                              child: CustomPaint(
                                painter: _LinePainter(
                                    widget.points,
                                    widget.color,
                                    Theme.of(context).dividerColor,
                                    selectedIndex),
                              ),
                            ),
                          ),
                        ),
                      ),
                      Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          Text(analyticsAxisTime(widget.points.first.at),
                              style: Theme.of(context).textTheme.labelSmall),
                          Text(analyticsAxisTime(widget.points.last.at),
                              style: Theme.of(context).textTheme.labelSmall),
                        ],
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
        if (selected != null)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Semantics(
              liveRegion: true,
              child: Text(selectedLabel!,
                  style: Theme.of(context).textTheme.bodySmall),
            ),
          ),
      ],
    );
  }
}

class _LinePainter extends CustomPainter {
  _LinePainter(this.points, this.color, this.grid, this.selectedIndex);
  final List<AnalyticsPoint> points;
  final Color color, grid;
  final int? selectedIndex;

  @override
  void paint(Canvas canvas, Size size) {
    final values = points
        .where((e) => e.value != null)
        .map((e) => double.parse(e.value!))
        .toList();
    if (values.isEmpty) return;
    final minimum = values.reduce(math.min);
    final maximum = values.reduce(math.max);
    final flat = maximum == minimum;
    final span = flat ? 1.0 : maximum - minimum;
    final baseline = Paint()
      ..color = grid
      ..strokeWidth = 1;
    for (var i = 1; i <= 3; i++) {
      final y = size.height * i / 4;
      canvas.drawLine(
        Offset.zero.translate(0, y),
        Offset(size.width, y),
        baseline,
      );
    }
    final path = Path();
    var plotted = 0;
    for (var i = 0; i < points.length; i++) {
      if (points[i].value == null) continue;
      final value = double.parse(points[i].value!);
      final x = points.length == 1 ? 0.0 : size.width * i / (points.length - 1);
      final y = flat
          ? size.height / 2
          : size.height - 12 - (value - minimum) / span * (size.height - 24);
      if (plotted == 0 || points[i - 1].value == null) {
        path.moveTo(x, y);
      } else {
        path.lineTo(x, y);
      }
      plotted++;
    }
    canvas.drawPath(
      path,
      Paint()
        ..color = color
        ..strokeWidth = 2.5
        ..style = PaintingStyle.stroke
        ..strokeCap = StrokeCap.round,
    );
    if (plotted == 1) {
      final index = points.indexWhere((point) => point.value != null);
      final x =
          points.length == 1 ? 0.0 : size.width * index / (points.length - 1);
      canvas.drawCircle(Offset(x, size.height / 2), 4, Paint()..color = color);
    }
    if (selectedIndex case final index?) {
      if (points[index].value case final raw?) {
        final x =
            points.length == 1 ? 0.0 : size.width * index / (points.length - 1);
        final y = flat
            ? size.height / 2
            : size.height -
                12 -
                (double.parse(raw) - minimum) / span * (size.height - 24);
        canvas.drawCircle(Offset(x, y), 5, Paint()..color = Colors.white);
        canvas.drawCircle(Offset(x, y), 3, Paint()..color = color);
      }
    }
  }

  @override
  bool shouldRepaint(covariant _LinePainter old) =>
      old.points != points ||
      old.color != color ||
      old.grid != grid ||
      old.selectedIndex != selectedIndex;
}

String analyticsLocalTime(DateTime value, BuildContext context) {
  final local = value.toLocal();
  final time = TimeOfDay.fromDateTime(local).format(context);
  return '${local.day}/${local.month} $time';
}

String analyticsAxisTime(DateTime value) {
  final local = value.toLocal();
  return '${local.day}/${local.month} '
      '${local.hour.toString().padLeft(2, '0')}:'
      '${local.minute.toString().padLeft(2, '0')}';
}

String shortAnalyticsAddress(String address) =>
    '${address.substring(0, 6)}…${address.substring(address.length - 4)}';

class AnalyticsMetricTile extends StatelessWidget {
  const AnalyticsMetricTile({
    super.key,
    required this.label,
    required this.value,
    this.delta,
    this.money = true,
    this.trend,
    this.trendLabel,
    this.note,
  });
  final String label;
  final String? value;
  final String? delta;
  final bool money;
  final List<AnalyticsPoint>? trend;
  final String? trendLabel;
  final String? note;
  @override
  Widget build(BuildContext context) => Card(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(label, style: Theme.of(context).textTheme.bodyMedium),
              const SizedBox(height: 8),
              Text(
                AnalyticsNumbers.compact(value, money: money),
                style: value == null
                    ? Theme.of(context).textTheme.titleMedium
                    : Theme.of(context).textTheme.headlineSmall,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
              if (delta != null)
                Text(
                  '${delta!.startsWith('-') ? '' : '+'}$delta%',
                  style: TextStyle(
                    color: delta!.startsWith('-')
                        ? EyelerColors.exit
                        : EyelerColors.defend,
                  ),
                ),
              if (value == null)
                Tooltip(
                  message: note ?? 'API did not provide a reason',
                  child: Text('Reason: ${note ?? 'Not supplied by API'}',
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: Theme.of(context).textTheme.labelSmall),
                ),
              if (trend != null &&
                  trend!.where((p) => p.value != null).length > 1) ...[
                const Spacer(),
                Semantics(
                  label: '${trendLabel ?? label} observed trend, '
                      '${trend!.where((p) => p.value != null).length} values',
                  child: SizedBox(
                    height: 28,
                    width: double.infinity,
                    child: CustomPaint(
                      painter: _SparklinePainter(trend!, EyelerColors.accent),
                    ),
                  ),
                ),
              ],
            ],
          ),
        ),
      );
}

class _SparklinePainter extends CustomPainter {
  const _SparklinePainter(this.points, this.color);
  final List<AnalyticsPoint> points;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final values =
        points.where((p) => p.value != null).map((p) => double.parse(p.value!));
    if (values.length < 2) return;
    final low = values.reduce(math.min);
    final high = values.reduce(math.max);
    final span = high == low ? 1.0 : high - low;
    final path = Path();
    for (var i = 0; i < points.length; i++) {
      final raw = points[i].value;
      if (raw == null) continue;
      final x = size.width * i / (points.length - 1);
      final y = high == low
          ? size.height / 2
          : 3 + (high - double.parse(raw)) / span * (size.height - 6);
      if (i == 0 || points[i - 1].value == null) {
        path.moveTo(x, y);
      } else {
        path.lineTo(x, y);
      }
    }
    canvas.drawPath(
        path,
        Paint()
          ..color = color
          ..strokeWidth = 2
          ..strokeCap = StrokeCap.round
          ..style = PaintingStyle.stroke);
  }

  @override
  bool shouldRepaint(covariant _SparklinePainter old) =>
      old.points != points || old.color != color;
}
