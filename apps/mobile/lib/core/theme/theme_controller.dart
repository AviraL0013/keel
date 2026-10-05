import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

// Eyeler's primary experience is the light, editorial wallet surface. Dark
// mode remains available from Settings for users who prefer it.
final themeModeProvider = StateProvider<ThemeMode>((ref) => ThemeMode.light);
