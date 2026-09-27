import 'package:flutter/material.dart';

abstract final class KeelColors {
  static const darkBackground = Color(0xFF061012);
  static const darkCanvas = Color(0xFF081417);
  static const darkSurface = Color(0xFF102326);
  static const darkElevated = Color(0xFF173137);
  static const darkText = Color(0xFFF2F7F7);
  static const darkMuted = Color(0xFF9FB5B8);
  static const darkBorder = Color(0xFF245159);
  static const lightBackground = Color(0xFFEAF7FB);
  static const lightCanvas = Color(0xFFC8E6F1);
  static const lightSurface = Color(0xFFFFFFFF);
  static const lightElevated = Color(0xFF87DCFB);
  static const lightText = Color(0xFF171717);
  static const lightMuted = Color(0xFF607078);
  static const lightBorder = Color(0xFFD6E7EC);
  static const accent = Color(0xFF69E8FF);
  static const hold = Color(0xFF9AAEB0);
  static const defend = Color(0xFF35E6B0);
  static const reduce = Color(0xFFF2B84B);
  static const exit = Color(0xFFFF6B6B);
  static const safeMode = reduce;
  static const info = accent;
}

abstract final class KeelSpacing {
  static const xs = 6.0;
  static const sm = 10.0;
  static const md = 16.0;
  static const lg = 24.0;
  static const xl = 32.0;
  static const xxl = 44.0;
}

abstract final class KeelRadii {
  static const small = 12.0;
  static const card = 22.0;
  static const button = 16.0;
  static const pill = 100.0;
}

abstract final class KeelTypography {
  static const display = TextStyle(
      fontSize: 38,
      height: 1.0,
      fontWeight: FontWeight.w800,
      letterSpacing: -1.4);
  static const title = TextStyle(
      fontSize: 24,
      height: 1.1,
      fontWeight: FontWeight.w800,
      letterSpacing: -.4);
  static const section =
      TextStyle(fontSize: 16, height: 1.2, fontWeight: FontWeight.w800);
  static const body =
      TextStyle(fontSize: 14, height: 1.4, fontWeight: FontWeight.w500);
  static const label = TextStyle(
      fontSize: 11,
      height: 1.1,
      fontWeight: FontWeight.w800,
      letterSpacing: 1.1);
  static const metric = TextStyle(
      fontSize: 20,
      height: 1.1,
      fontWeight: FontWeight.w800,
      letterSpacing: -.3);
}

class KeelRiskVisual {
  const KeelRiskVisual(
      {required this.label,
      required this.description,
      required this.color,
      required this.foreground,
      required this.icon});
  final String label;
  final String description;
  final Color color;
  final Color foreground;
  final IconData icon;
  static KeelRiskVisual forState(String? state) => switch (state) {
        'HOLD' => const KeelRiskVisual(
            label: 'HOLD',
            description: 'No action requested by the current backend decision.',
            color: KeelColors.hold,
            foreground: Colors.black,
            icon: Icons.check_circle_outline),
        'DEFEND' => const KeelRiskVisual(
            label: 'DEFEND',
            description:
                'Margin protection selected. Check execution for the outcome.',
            color: KeelColors.defend,
            foreground: Colors.black,
            icon: Icons.shield_outlined),
        'REDUCE' => const KeelRiskVisual(
            label: 'REDUCE',
            description: 'The policy calls for less exposure.',
            color: KeelColors.reduce,
            foreground: Colors.black,
            icon: Icons.trending_down),
        'EXIT' => const KeelRiskVisual(
            label: 'EXIT',
            description:
                'The policy calls for closing exposure. Execution is tracked separately.',
            color: KeelColors.exit,
            foreground: Colors.black,
            icon: Icons.logout),
        'SAFE_MODE' => const KeelRiskVisual(
            label: 'SAFE_MODE',
            description:
                'Paused for safety. Review the reason before recovering automation.',
            color: KeelColors.safeMode,
            foreground: Colors.black,
            icon: Icons.pause_circle_outline),
        _ => const KeelRiskVisual(
            label: 'UNKNOWN',
            description: 'Waiting for an authoritative risk decision.',
            color: KeelColors.darkMuted,
            foreground: Colors.black,
            icon: Icons.help_outline),
      };
}

class KeelTheme {
  static ThemeData get data => dark;
  static ThemeData get dark => _build(Brightness.dark);
  static ThemeData get light => _build(Brightness.light);
  static ThemeData _build(Brightness brightness) {
    final isDark = brightness == Brightness.dark;
    final background =
        isDark ? KeelColors.darkBackground : KeelColors.lightBackground;
    final surface = isDark ? KeelColors.darkSurface : KeelColors.lightSurface;
    final text = isDark ? KeelColors.darkText : KeelColors.lightText;
    final muted = isDark ? KeelColors.darkMuted : KeelColors.lightMuted;
    final border = isDark ? KeelColors.darkBorder : KeelColors.lightBorder;
    final scheme = ColorScheme.fromSeed(
            seedColor: KeelColors.accent, brightness: brightness)
        .copyWith(
            primary: KeelColors.accent,
            secondary: KeelColors.defend,
            surface: surface,
            error: KeelColors.exit,
            onSurface: text,
            onPrimary: Colors.black,
            onSecondary: Colors.black);
    final inputBorder = OutlineInputBorder(
        borderRadius: BorderRadius.circular(KeelRadii.button),
        borderSide: BorderSide(color: border));
    return ThemeData(
      brightness: brightness,
      colorScheme: scheme,
      scaffoldBackgroundColor: background,
      cardTheme: CardThemeData(
          color: surface,
          margin: EdgeInsets.zero,
          elevation: isDark ? 0 : 1,
          shadowColor: Colors.black26,
          shape: RoundedRectangleBorder(
              side:
                  BorderSide(color: border.withValues(alpha: isDark ? .7 : 1)),
              borderRadius:
                  const BorderRadius.all(Radius.circular(KeelRadii.card)))),
      appBarTheme: AppBarTheme(
          backgroundColor: Colors.transparent,
          foregroundColor: text,
          elevation: 0,
          centerTitle: false,
          titleTextStyle: KeelTypography.title.copyWith(color: text)),
      inputDecorationTheme: InputDecorationTheme(
          filled: true,
          fillColor: surface,
          border: inputBorder,
          enabledBorder: inputBorder,
          focusedBorder: inputBorder.copyWith(
              borderSide: const BorderSide(color: KeelColors.accent, width: 2)),
          labelStyle: KeelTypography.body.copyWith(color: muted)),
      filledButtonTheme: FilledButtonThemeData(
          style: FilledButton.styleFrom(
              backgroundColor: KeelColors.accent,
              foregroundColor: Colors.black,
              shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(KeelRadii.button)),
              padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 16),
              textStyle: KeelTypography.label.copyWith(letterSpacing: .4))),
      outlinedButtonTheme: OutlinedButtonThemeData(
          style: OutlinedButton.styleFrom(
              foregroundColor: text,
              side: BorderSide(color: border),
              shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(KeelRadii.button)),
              padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 14),
              textStyle: KeelTypography.label.copyWith(color: text))),
      navigationBarTheme: NavigationBarThemeData(
          backgroundColor: background,
          indicatorColor: KeelColors.accent.withValues(alpha: .16),
          elevation: 8,
          labelTextStyle: WidgetStatePropertyAll(KeelTypography.label
              .copyWith(fontSize: 10, letterSpacing: .2, color: text))),
      dividerTheme: DividerThemeData(color: border, space: 1),
      chipTheme: ChipThemeData(
          backgroundColor: surface,
          selectedColor: KeelColors.accent.withValues(alpha: .19),
          side: BorderSide(color: border),
          shape:
              RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
          labelStyle: KeelTypography.body.copyWith(color: text)),
      textTheme: TextTheme(
          displayLarge: KeelTypography.display.copyWith(color: text),
          displayMedium: KeelTypography.display.copyWith(color: text),
          headlineSmall: KeelTypography.title.copyWith(color: text),
          titleLarge: KeelTypography.section.copyWith(color: text),
          titleMedium: KeelTypography.section.copyWith(color: text),
          bodyLarge: KeelTypography.body.copyWith(color: text),
          bodyMedium: KeelTypography.body.copyWith(color: muted),
          labelLarge: KeelTypography.label.copyWith(color: text),
          labelSmall: KeelTypography.label.copyWith(color: muted)),
    );
  }
}
