param([switch]$SkipWebBuild)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
$root = Get-LocalRoot
Set-Location -LiteralPath $root
$settings = Get-LocalEnv
foreach ($name in @('DATABASE_URL', 'SESSION_SECRET', 'EYELER_ALLOWED_WALLETS', 'PERPL_API_KEY', 'PERPL_API_KEY_SECRET', 'PERPL_ACCOUNT_ID')) {
    if (-not $settings[$name]) { throw "MISSING_$name" }
}
if ($settings['EYELER_ENV'] -ne 'testnet') { throw 'EYELER_ENV_MUST_BE_TESTNET' }
New-Item -ItemType Directory -Path (Join-Path $root 'logs') -Force | Out-Null

$container = docker ps -a --filter 'name=^/eyeler-postgres$' --format '{{.Names}}'
if ($LASTEXITCODE -ne 0) { throw 'DOCKER_UNAVAILABLE' }
if (-not $container) {
    $uri = [Uri]$settings['DATABASE_URL']
    if ($uri.Host -ne '127.0.0.1' -or $uri.Port -ne 5432 -or $uri.AbsolutePath -ne '/eyeler') {
        throw 'LOCAL_DATABASE_URL_EXPECTED'
    }
    $credentials = $uri.UserInfo.Split(':', 2)
    if ($credentials.Count -ne 2 -or $credentials[0] -ne 'eyeler') { throw 'LOCAL_DATABASE_URL_EXPECTED' }
    $password = [Uri]::UnescapeDataString($credentials[1])
    if (-not $password) { throw 'LOCAL_DATABASE_PASSWORD_MISSING' }
    docker run -d --name eyeler-postgres --restart unless-stopped -e POSTGRES_USER=eyeler -e POSTGRES_DB=eyeler -e "POSTGRES_PASSWORD=$password" -v eyeler-postgres-data:/var/lib/postgresql/data -p 127.0.0.1:5432:5432 postgres:16 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'POSTGRES_START_FAILED' }
} else {
    $running = docker ps --filter 'name=^/eyeler-postgres$' --format '{{.Names}}'
    if ($LASTEXITCODE -ne 0) { throw 'DOCKER_UNAVAILABLE' }
    if (-not $running) {
        docker start eyeler-postgres | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'POSTGRES_START_FAILED' }
    }
}

$databaseReady = $false
for ($i = 0; $i -lt 30; $i++) {
    docker exec eyeler-postgres pg_isready -U eyeler -d eyeler 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { $databaseReady = $true; break }
    Start-Sleep -Seconds 1
}
if (-not $databaseReady) { throw 'POSTGRES_NOT_READY' }

if (-not (Test-Path -LiteralPath 'node_modules')) {
    npm ci
    if ($LASTEXITCODE -ne 0) { throw 'NPM_CI_FAILED' }
}
npm run build
if ($LASTEXITCODE -ne 0) { throw 'BACKEND_BUILD_FAILED' }
node --env-file=.env dist/scripts/migrate.js
if ($LASTEXITCODE -ne 0) { throw 'MIGRATION_FAILED' }

$flutter = 'C:\Users\lenovo\flutter-sdk\flutter\bin\flutter.bat'
if (-not (Test-Path -LiteralPath $flutter)) { $flutter = (Get-Command flutter -ErrorAction Stop).Source }
$web = Join-Path $root 'apps\mobile\build\web'
if (-not $SkipWebBuild -or -not (Test-Path -LiteralPath (Join-Path $web 'index.html'))) {
    Push-Location (Join-Path $root 'apps\mobile')
    try {
        & $flutter build web --release '--dart-define=EYELER_API_URL=http://localhost:8787' '--dart-define=EYELER_CHAIN_ID=10143' '--dart-define=EYELER_CHAIN_NAME=Monad Testnet' '--dart-define=EYELER_MONAD_RPC_URL=https://testnet-rpc.monad.xyz' '--dart-define=EYELER_MONAD_EXPLORER_URL=https://testnet.monadexplorer.com' '--dart-define=EYELER_NATIVE_CURRENCY_NAME=Monad' '--dart-define=EYELER_NATIVE_CURRENCY_SYMBOL=MON'
        if ($LASTEXITCODE -ne 0) { throw 'WEB_BUILD_FAILED' }
    } finally { Pop-Location }
}

$health = Get-LocalApiResponse '/health'
if ($health.Status -ne 200) {
    $backendPidPath = Join-Path $root 'logs\backend-window.pid'
    $existingNode = $null
    if (Test-Path -LiteralPath $backendPidPath) {
        $windowPid = [int][System.IO.File]::ReadAllText($backendPidPath)
        $window = Get-Process -Id $windowPid -ErrorAction SilentlyContinue
        if ($window) {
            $existingNode = Get-CimInstance Win32_Process | Where-Object {
                $_.ParentProcessId -eq $windowPid -and $_.Name -eq 'node.exe'
            }
        }
    }
    if (-not $existingNode) {
        $backendScript = Join-Path $PSScriptRoot 'backend.ps1'
        $backendWindow = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-NoExit', '-File', ('"' + $backendScript + '"')) -WorkingDirectory $root -WindowStyle Normal -PassThru
        [System.IO.File]::WriteAllText($backendPidPath, [string]$backendWindow.Id)
    }
}

$webPidPath = Join-Path $root 'logs\web.pid'
$webProcess = $null
if (Test-Path -LiteralPath $webPidPath) {
    $webPid = [int][System.IO.File]::ReadAllText($webPidPath)
    $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $webPid" -ErrorAction SilentlyContinue
    if ($candidate -and $candidate.Name -eq 'python.exe' -and $candidate.CommandLine -match 'http\.server\s+8082') {
        $webProcess = $candidate
    }
}
if (-not $webProcess) {
    if (Get-NetTCPConnection -LocalPort 8082 -State Listen -ErrorAction SilentlyContinue) { throw 'WEB_PORT_IN_USE' }
    $webProcess = Start-Process -FilePath 'python.exe' -ArgumentList @('-m', 'http.server', '8082', '--bind', '127.0.0.1', ('--directory "' + $web + '"')) -WorkingDirectory $root -RedirectStandardOutput (Join-Path $root 'logs\web.out.log') -RedirectStandardError (Join-Path $root 'logs\web.err.log') -WindowStyle Hidden -PassThru
    [System.IO.File]::WriteAllText($webPidPath, [string]$webProcess.Id)
}

for ($i = 0; $i -lt 30; $i++) {
    $health = Get-LocalApiResponse '/health'
    if ($health.Status -eq 200) { break }
    Start-Sleep -Seconds 1
}
if ($health.Status -ne 200) { throw 'API_HEALTH_UNAVAILABLE; check logs/api.log and the backend window' }

$ready = @{ Status = 0; Body = $null }
for ($i = 0; $i -lt 45; $i++) {
    $ready = Get-LocalApiResponse '/ready'
    if ($ready.Status -eq 200 -and $ready.Body.ready -eq $true) { break }
    Start-Sleep -Seconds 1
}
if ($ready.Status -ne 200 -or $ready.Body.ready -ne $true) {
    $reason = if ($ready.Body.reason) { $ready.Body.reason } else { 'NO_RESPONSE' }
    throw "API_NOT_READY: $reason"
}

$page = Invoke-WebRequest -Uri 'http://localhost:8082/' -UseBasicParsing -TimeoutSec 5
if ($page.StatusCode -ne 200 -or $page.Content -notmatch 'flutter_bootstrap\.js') { throw 'WEB_UNAVAILABLE' }
Write-Host 'EYELER live testnet is ready.'
Write-Host 'Web: http://localhost:8082/'
Write-Host 'API health: http://localhost:8787/health'
Write-Host 'API readiness: http://localhost:8787/ready'
Write-Host 'Backend: separate PowerShell window; press Ctrl+C there to stop it.'
