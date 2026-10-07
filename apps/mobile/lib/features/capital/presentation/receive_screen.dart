import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:qr_flutter/qr_flutter.dart';

import '../../../core/theme/app_theme.dart';

class ReceiveScreen extends StatelessWidget {
  const ReceiveScreen({super.key, required this.address});
  final String address;

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Receive')),
        body: SafeArea(
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 440),
              child: ListView(
                padding: const EdgeInsets.all(EyelerSpacing.md),
                children: [
                  const Text('Monad mainnet', style: EyelerTypography.title),
                  const SizedBox(height: EyelerSpacing.sm),
                  const Text(
                      'Send MON or AUSD on Monad mainnet to this Mera wallet. Check the network before sending.'),
                  const SizedBox(height: EyelerSpacing.lg),
                  Center(
                    child: Container(
                      color: Colors.white,
                      padding: const EdgeInsets.all(12),
                      child: QrImageView(
                        key: const Key('receive_qr'),
                        data: address,
                        size: 220,
                        backgroundColor: Colors.white,
                        errorCorrectionLevel: QrErrorCorrectLevel.M,
                      ),
                    ),
                  ),
                  const SizedBox(height: EyelerSpacing.lg),
                  SelectableText(address, textAlign: TextAlign.center),
                  const SizedBox(height: EyelerSpacing.md),
                  FilledButton.icon(
                    onPressed: () async {
                      await Clipboard.setData(ClipboardData(text: address));
                      if (context.mounted) {
                        ScaffoldMessenger.of(context).showSnackBar(
                            const SnackBar(content: Text('Address copied')));
                      }
                    },
                    icon: const Icon(Icons.copy),
                    label: const Text('COPY ADDRESS'),
                  ),
                ],
              ),
            ),
          ),
        ),
      );
}
