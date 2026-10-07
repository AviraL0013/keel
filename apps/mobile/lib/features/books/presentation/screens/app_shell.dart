import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'book_detail_screen.dart';
import '../../../positions/presentation/positions_screen.dart';
import '../../../capital/presentation/capital_screen.dart';
import '../../../autopsy/presentation/autopsy_screen.dart';
import '../../../notifications/presentation/notifications_screen.dart';
import '../../../settings/presentation/settings_screen.dart';
import '../../../analytics/analytics_screen.dart';
import '../../data/books_repository.dart';
import '../../../onboarding/presentation/onboarding_screen.dart';

class AppShell extends ConsumerStatefulWidget {
  const AppShell({super.key});
  @override
  ConsumerState<AppShell> createState() => _AppShellState();
}

class _AppShellState extends ConsumerState<AppShell> {
  int index = 0;
  bool _openedLinkedBook = false;
  @override
  Widget build(BuildContext context) {
    final books = ref.watch(booksProvider);
    final linkedBookId = Uri.base.queryParameters['book'];
    if (!_openedLinkedBook && linkedBookId != null) {
      books.whenData((items) {
        for (final book in items) {
          if (book.id != linkedBookId) continue;
          _openedLinkedBook = true;
          WidgetsBinding.instance.addPostFrameCallback((_) {
            if (mounted) {
              Navigator.of(context).push(MaterialPageRoute<void>(
                  builder: (_) => BookDetailScreen(book: book)));
            }
          });
          break;
        }
      });
    }
    final pages = <Widget>[
      const OnboardingHome(),
      const PositionsScreen(),
      const CapitalScreen(),
      const AnalyticsScreen(),
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
              child: Stack(
                  clipBehavior: Clip.none,
                  alignment: Alignment.topCenter,
                  children: [
                    SingleChildScrollView(
                      scrollDirection: Axis.horizontal,
                      child: SizedBox(
                        width: MediaQuery.sizeOf(context).width < 392
                            ? 392
                            : MediaQuery.sizeOf(context).width > 720
                                ? 720
                                : MediaQuery.sizeOf(context).width,
                        child: NavigationBar(
                      selectedIndex: index,
                      onDestinationSelected: (value) =>
                          setState(() => index = value),
                      destinations: const [
                        NavigationDestination(
                            icon: Icon(Icons.home_outlined), label: 'Home'),
                        NavigationDestination(
                            icon: Icon(Icons.account_balance_wallet_outlined),
                            label: 'Positions'),
                        NavigationDestination(
                            icon: Icon(Icons.account_balance_outlined),
                            label: 'Capital'),
                        NavigationDestination(
                            icon: Icon(Icons.analytics_outlined),
                            label: 'Analytics'),
                        NavigationDestination(
                            icon: Icon(Icons.history), label: 'Autopsy'),
                        NavigationDestination(
                            icon: Icon(Icons.notifications_none),
                            label: 'Notifications'),
                        NavigationDestination(
                            icon: Icon(Icons.settings_outlined),
                            label: 'Settings'),
                      ],
                        ),
                      ),
                    ),
                    Positioned(
                        top: -20,
                        child: DecoratedBox(
                            decoration: BoxDecoration(
                                shape: BoxShape.circle,
                                color: Theme.of(context).colorScheme.primary,
                                boxShadow: const [
                                  BoxShadow(
                                      color: Color(0x22000000),
                                      blurRadius: 14,
                                      offset: Offset(0, 7))
                                ]),
                            child: IconButton(
                                tooltip: 'Create a Book',
                                onPressed: () => setState(() => index = 1),
                                icon: Icon(Icons.add,
                                    color: Theme.of(context)
                                        .colorScheme
                                        .onPrimary),
                                iconSize: 28,
                                padding: const EdgeInsets.all(11))))
                  ]),
            ),
          ),
        ),
      ),
    );
  }
}
