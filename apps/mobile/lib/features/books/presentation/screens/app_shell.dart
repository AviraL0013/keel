import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'books_screen.dart';
import '../../../positions/presentation/positions_screen.dart';
import '../../../capital/presentation/capital_screen.dart';
import '../../../autopsy/presentation/autopsy_screen.dart';
import '../../../notifications/presentation/notifications_screen.dart';
import '../../../settings/presentation/settings_screen.dart';
import '../../data/books_repository.dart';

class AppShell extends ConsumerStatefulWidget {
  const AppShell({super.key});
  @override
  ConsumerState<AppShell> createState() => _AppShellState();
}

class _AppShellState extends ConsumerState<AppShell> {
  int index = 0;
  @override
  Widget build(BuildContext context) {
    final books = ref.watch(booksProvider);
    final pages = <Widget>[
      const BooksScreen(),
      const PositionsScreen(),
      const CapitalScreen(),
      books.maybeWhen(
          data: (items) => items.isEmpty
              ? const Center(child: Text('Create a Book to inspect Autopsy.'))
              : AutopsyScreen(bookId: items.first.id),
          orElse: () => const Center(child: CircularProgressIndicator())),
      const NotificationsScreen(),
      const SettingsScreen(),
    ];
    return SizedBox(
      width: double.infinity,
      height: MediaQuery.sizeOf(context).height,
      child: Scaffold(
        body: pages[index],
        bottomNavigationBar: ColoredBox(
          color: Theme.of(context).colorScheme.surface,
          child: Center(
            // Keep the bottom bar at its natural height so the body retains space.
            heightFactor: 1,
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 720),
              child: NavigationBar(
                selectedIndex: index,
                onDestinationSelected: (value) => setState(() => index = value),
                destinations: const [
                  NavigationDestination(
                      icon: Icon(Icons.book_outlined), label: 'Books'),
                  NavigationDestination(
                      icon: Icon(Icons.account_balance_wallet_outlined),
                      label: 'Positions'),
                  NavigationDestination(
                      icon: Icon(Icons.account_balance_outlined),
                      label: 'Capital'),
                  NavigationDestination(
                      icon: Icon(Icons.history), label: 'Autopsy'),
                  NavigationDestination(
                      icon: Icon(Icons.notifications_none),
                      label: 'Notifications'),
                  NavigationDestination(
                      icon: Icon(Icons.settings_outlined), label: 'Settings'),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
