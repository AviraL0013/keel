import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;

import '../../core/networking/api_client.dart';
import '../../core/wallet/mera_transaction.dart';
import '../auth/data/auth_repository.dart';
import '../capital/presentation/receive_screen.dart';
import '../positions/presentation/perpl_connection_panel.dart';
import 'activate_perpl_screen.dart';
import 'activation_coordinator.dart';
import 'perpl_activation.dart';

class ActivatePerplRoute extends ConsumerStatefulWidget {
  const ActivatePerplRoute({super.key});

  @override
  ConsumerState<ActivatePerplRoute> createState() => _ActivatePerplRouteState();
}

class _ActivatePerplRouteState extends ConsumerState<ActivatePerplRoute> {
  late final http.Client client = http.Client();
  PerplActivationCoordinator? coordinator;

  @override
  void initState() {
    super.initState();
    final address = ref.read(authProvider).address;
    final wallet = ref.read(walletConnectorProvider);
    if (address == null ||
        wallet is! MeraTransactionActions ||
        const String.fromEnvironment('EYELER_DEPLOYMENT') != 'mainnet') {
      return;
    }
    final actions = wallet as MeraTransactionActions;
    final gateway = PerplActivationGateway(client);
    final rpc = MonadMainnetRpc(client);
    final api = ref.read(apiClientProvider);
    coordinator = PerplActivationCoordinator(
      walletAddress: address,
      journal: const SecureActivationJournal(),
      load: () async {
        final remote = await api.get('/connections/perpl/account-state',
            (body) => Map<String, dynamic>.from(body as Map));
        final forwarding = remote['status'] == 'AVAILABLE'
            ? remote['forwardingEnabled'] as bool?
            : null;
        final loaded =
            await gateway.load(address, forwardingEnabled: forwarding);
        verifyPerplAccountState(remote, loaded.state);
        return loaded;
      },
      receipt: gateway.receipt,
      prepare: (call) async {
        final connected = await wallet.connect();
        if (connected.chainId != 143 ||
            connected.address.toLowerCase() != address.toLowerCase()) {
          throw StateError('Passkey wallet differs from signed-in wallet.');
        }
        return actions.prepareTransaction(
            rpc: rpc,
            contract: call.contract,
            function: call.function,
            exactAmount: call.exactAmount,
            data: call.data);
      },
      send: (quote) => actions.confirmAndSendTransaction(
          quote: quote, rpc: rpc, confirm: (_) async => true),
    );
  }

  @override
  void dispose() {
    client.close();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final active = coordinator;
    final address = ref.watch(authProvider).address;
    if (active == null || address == null) {
      return Scaffold(
          appBar: AppBar(title: const Text('Activate Perpl')),
          body: const Center(
              child: Text('Sign in with a Mera wallet on Monad mainnet.')));
    }
    return ActivatePerplScreen(
        coordinator: active,
        connectPanel: const PerplConnectionPanel(),
        onReceive: () => Navigator.of(context).push(MaterialPageRoute(
            builder: (_) => ReceiveScreen(address: address))));
  }
}
