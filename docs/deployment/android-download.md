# Android app download

Website: <https://app.eyeler.xyz>. Choose **Download Android app** on the sign-in screen, or the Android icon on the public analytics and status pages. Installation instructions appear before opening the download.

Signed mainnet APK: <https://github.com/AviraL0013/keel/releases/download/android-v1.0.0-45b214b/eyeler-android.apk>.

## Judge access instructions

1. Open the website on an Android phone and choose **Download Android app**, then **Download APK**.
2. Open the downloaded APK. If Android asks, allow installation from your browser, then tap **Install**.
3. Open Eyeler. Choose **Create new Mera wallet**, or sign in with an existing Mera passkey. Complete the Android credential prompt yourself.
4. Mainnet trading currently requires approval of the public wallet address. If the app shows **Wallet not allowed**, copy only the public address and send it to the team for approval. Never share a private key, passkey, or API credential.
5. Public analytics at <https://app.eyeler.xyz/#/analytics> and the run report at <https://app.eyeler.xyz/#/status> need no sign-in or installation. iOS users can use these web pages; this release is Android only.

## Release identity

- Package: `xyz.eyeler.app`.
- Version: `1.0.0`, build number `2`.
- Native source: `45b214b987df5660bedaaa2499254e4c7ed6d19c`, including the market-feed recovery fix and official bundled Mera SDK.
- The later download-button change is web-only. It does not change native authentication or trading.
- Existing release signer is retained. Its certificate must match the live Android Asset Links association for `app.eyeler.xyz`.
- Signing inputs stay outside Git. The APK is distributed as a GitHub release asset, not a source file.
- Downloading or installing the APK does not authorize a trade or start automation.

## Verification

Focused Flutter tests cover instructions, 360/1280 px layouts, the fixed HTTPS release URL, cancel without download, and safe launcher failures. Release verification checks APK signatures, package/version, non-debuggable manifest, official Mera asset, native relying-party domain, mainnet API and source SHA, absence of signing files or known secrets, and matching live Asset Links. Anonymous download must reproduce the locally verified APK SHA-256.

Physical installation and passkey confirmation require a connected Android device and its owner. Compilation and certificate verification alone do not prove a new physical passkey ceremony.
