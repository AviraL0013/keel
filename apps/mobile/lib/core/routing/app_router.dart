import 'package:flutter/material.dart';
import '../../features/auth/presentation/auth_screen.dart';
import '../../features/books/presentation/screens/app_shell.dart';
class KeelRouter extends StatelessWidget { const KeelRouter({super.key, required this.authenticated}); final bool authenticated; @override Widget build(BuildContext context) => authenticated ? const AppShell() : const AuthScreen(); }
