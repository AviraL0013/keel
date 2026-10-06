import 'package:flutter/material.dart';

import '../../../core/theme/app_theme.dart';

/// The short launch ritual keeps the product identity front and center while
/// auth and the first market snapshot restore behind it.
class EyelerLandingPage extends StatefulWidget {
  const EyelerLandingPage({required this.onFinished, super.key});

  final VoidCallback onFinished;

  @override
  State<EyelerLandingPage> createState() => _EyelerLandingPageState();
}

class _EyelerLandingPageState extends State<EyelerLandingPage>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 2400),
  )
    ..addStatusListener((status) {
      if (status == AnimationStatus.completed) widget.onFinished();
    })
    ..forward();

  late final Animation<double> _reveal = CurvedAnimation(
    parent: _controller,
    curve: const Interval(0, .62, curve: Curves.easeOutCubic),
  );
  late final Animation<double> _nameReveal = CurvedAnimation(
    parent: _controller,
    curve: const Interval(.26, .78, curve: Curves.easeOutCubic),
  );

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        backgroundColor: EyelerColors.darkBackground,
        body: Semantics(
          label: 'EYELER',
          child: AnimatedBuilder(
            animation: _controller,
            builder: (context, child) => Stack(
              fit: StackFit.expand,
              children: [
                CustomPaint(
                  painter: _LandingBackdropPainter(progress: _controller.value),
                ),
                Center(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Opacity(
                        opacity: _reveal.value,
                        child: Transform.scale(
                          scale: .72 + (_reveal.value * .28),
                          child: Transform.rotate(
                            angle: (1 - _reveal.value) * -.16,
                            child: Container(
                              width: 136,
                              height: 136,
                              padding: const EdgeInsets.all(18),
                              decoration: BoxDecoration(
                                shape: BoxShape.circle,
                                color: EyelerColors.darkSurface
                                    .withValues(alpha: .82),
                                border: Border.all(
                                  color:
                                      EyelerColors.accent.withValues(alpha: .7),
                                  width: 1.4,
                                ),
                                boxShadow: [
                                  BoxShadow(
                                    color: EyelerColors.accent
                                        .withValues(alpha: .4),
                                    blurRadius: 42,
                                    spreadRadius: 4,
                                  ),
                                ],
                              ),
                              child: Image.asset(
                                'assets/branding/eyeler-eye.png',
                                semanticLabel: 'EYELER logo',
                              ),
                            ),
                          ),
                        ),
                      ),
                      const SizedBox(height: 28),
                      Opacity(
                        opacity: _nameReveal.value,
                        child: Transform.translate(
                          offset: Offset(0, 12 * (1 - _nameReveal.value)),
                          child: Text(
                            'EYELER',
                            style: EyelerTypography.display.copyWith(
                              color: EyelerColors.darkText,
                              fontSize: 34,
                              fontWeight: FontWeight.w700,
                              letterSpacing: 7.2,
                            ),
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      );
}

class _LandingBackdropPainter extends CustomPainter {
  const _LandingBackdropPainter({required this.progress});

  final double progress;

  @override
  void paint(Canvas canvas, Size size) {
    final center = size.center(Offset.zero);
    final maxRadius = size.longestSide * .8;
    final pulse = .25 + (progress * .75);
    final rings = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1;
    for (var i = 0; i < 5; i++) {
      rings.color =
          EyelerColors.accent.withValues(alpha: (.18 - i * .025) * pulse);
      canvas.drawCircle(center, maxRadius * (.22 + i * .14) * pulse, rings);
    }
    final glow = Paint()
      ..shader = RadialGradient(
        colors: [
          EyelerColors.accent.withValues(alpha: .2 * pulse),
          EyelerColors.darkBackground.withValues(alpha: 0),
        ],
      ).createShader(Rect.fromCircle(center: center, radius: maxRadius));
    canvas.drawCircle(center, maxRadius, glow);
    final orb = Paint()..color = EyelerColors.defend.withValues(alpha: .13);
    canvas.drawCircle(
      Offset(size.width * .14, size.height * (.18 + progress * .1)),
      5 + (progress * 7),
      orb,
    );
    canvas.drawCircle(
      Offset(size.width * .86, size.height * (.78 - progress * .08)),
      3 + (progress * 10),
      orb,
    );
  }

  @override
  bool shouldRepaint(_LandingBackdropPainter oldDelegate) =>
      oldDelegate.progress != progress;
}
