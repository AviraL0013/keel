param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('mainnet', 'testnet', 'sandbox')]
    [string]$Target
)

$apiUrl = switch ($Target) {
    'mainnet' { 'https://api-mainnet-production-b042.up.railway.app' }
    'testnet' { 'https://api-production-9fcf.up.railway.app' }
    'sandbox' { 'https://sandbox-api.eyeler.xyz' }
}
$chainId = if ($Target -eq 'mainnet') { '143' } else { '10143' }
$chainName = if ($Target -eq 'mainnet') { 'Monad' } else { 'Monad Testnet' }
$rpcUrl = if ($Target -eq 'mainnet') { 'https://rpc.monad.xyz' } else { 'https://testnet-rpc.monad.xyz' }
$explorerUrl = if ($Target -eq 'mainnet') { 'https://monadscan.com' } else { 'https://testnet.monadexplorer.com' }
$flutter = Get-Command flutter -ErrorAction Stop
Push-Location (Join-Path $PSScriptRoot '..\..\apps\mobile')
try {
    & $flutter.Source build web --release `
        "--dart-define=EYELER_API_URL=$apiUrl" `
        "--dart-define=EYELER_DEPLOYMENT=$Target" `
        "--dart-define=EYELER_CHAIN_ID=$chainId" `
        "--dart-define=EYELER_CHAIN_NAME=$chainName" `
        "--dart-define=EYELER_MONAD_RPC_URL=$rpcUrl" `
        "--dart-define=EYELER_MONAD_EXPLORER_URL=$explorerUrl" `
        '--dart-define=EYELER_MERA_RP_ID=app.eyeler.xyz' `
        '--dart-define=EYELER_NATIVE_CURRENCY_NAME=Monad' `
        '--dart-define=EYELER_NATIVE_CURRENCY_SYMBOL=MON'
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally { Pop-Location }
