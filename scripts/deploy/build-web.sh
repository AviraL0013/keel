#!/usr/bin/env sh
set -eu
case "${1:-}" in
  testnet) api_url=https://api.eyeler.xyz ;;
  sandbox) api_url=https://sandbox-api.eyeler.xyz ;;
  *) echo 'Usage: build-web.sh <testnet|sandbox>' >&2; exit 2 ;;
esac
cd "$(dirname "$0")/../../apps/mobile"
build_sha=${EYELER_BUILD_SHA:-development}
flutter build web --release \
  "--dart-define=EYELER_API_URL=$api_url" \
  '--dart-define=EYELER_CHAIN_ID=10143' \
  '--dart-define=EYELER_CHAIN_NAME=Monad Testnet' \
  '--dart-define=EYELER_MONAD_RPC_URL=https://testnet-rpc.monad.xyz' \
  '--dart-define=EYELER_MONAD_EXPLORER_URL=https://testnet.monadexplorer.com' \
  '--dart-define=EYELER_NATIVE_CURRENCY_NAME=Monad' \
  '--dart-define=EYELER_NATIVE_CURRENCY_SYMBOL=MON' \
  "--dart-define=EYELER_BUILD_SHA=$build_sha"
