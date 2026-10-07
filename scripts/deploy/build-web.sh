#!/usr/bin/env sh
set -eu
case "${1:-}" in
  mainnet)
    api_url=https://api.eyeler.xyz
    chain_id=143
    chain_name=Monad
    rpc_url=https://rpc.monad.xyz
    explorer_url=https://monadscan.com
    ;;
  testnet|sandbox)
    if [ "$1" = testnet ]; then api_url=https://api.eyeler.xyz; else api_url=https://sandbox-api.eyeler.xyz; fi
    chain_id=10143
    chain_name='Monad Testnet'
    rpc_url=https://testnet-rpc.monad.xyz
    explorer_url=https://testnet.monadexplorer.com
    ;;
  *) echo 'Usage: build-web.sh <mainnet|testnet|sandbox>' >&2; exit 2 ;;
esac
cd "$(dirname "$0")/../../apps/mobile"
build_sha=${EYELER_BUILD_SHA:-development}
flutter build web --release \
  "--dart-define=EYELER_API_URL=$api_url" \
  "--dart-define=EYELER_DEPLOYMENT=$1" \
  "--dart-define=EYELER_CHAIN_ID=$chain_id" \
  "--dart-define=EYELER_CHAIN_NAME=$chain_name" \
  "--dart-define=EYELER_MONAD_RPC_URL=$rpc_url" \
  "--dart-define=EYELER_MONAD_EXPLORER_URL=$explorer_url" \
  '--dart-define=EYELER_MERA_RP_ID=app.eyeler.xyz' \
  '--dart-define=EYELER_NATIVE_CURRENCY_NAME=Monad' \
  '--dart-define=EYELER_NATIVE_CURRENCY_SYMBOL=MON' \
  "--dart-define=EYELER_BUILD_SHA=$build_sha"
