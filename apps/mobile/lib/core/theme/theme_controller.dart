import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

// The market-terminal experience opens in dark mode. Users can still switch
// to the light editorial wallet surface from Settings.
final themeModeProvider = StateProvider<ThemeMode>((ref) => ThemeMode.dark);
