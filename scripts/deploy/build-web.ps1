param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('testnet', 'sandbox')]
    [string]$Target
)

$apiUrl = if ($Target -eq 'testnet') { 'https://api.eyeler.xyz' } else { 'https://sandbox-api.eyeler.xyz' }
$flutter = Get-Command flutter -ErrorAction Stop
Push-Location (Join-Path $PSScriptRoot '..\..\apps\mobile')
try {
    & $flutter.Source build web --release `
        "--dart-define=EYELER_API_URL=$apiUrl" `
        '--dart-define=EYELER_CHAIN_ID=10143' `
        '--dart-define=EYELER_CHAIN_NAME=Monad Testnet' `
        '--dart-define=EYELER_MONAD_RPC_URL=https://testnet-rpc.monad.xyz' `
        '--dart-define=EYELER_MONAD_EXPLORER_URL=https://testnet.monadexplorer.com' `
        '--dart-define=EYELER_NATIVE_CURRENCY_NAME=Monad' `
        '--dart-define=EYELER_NATIVE_CURRENCY_SYMBOL=MON'
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally { Pop-Location }
