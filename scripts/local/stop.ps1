$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
$root = Get-LocalRoot
$webPidPath = Join-Path $root 'logs\web.pid'
if (Test-Path -LiteralPath $webPidPath) {
    $webPid = [int][System.IO.File]::ReadAllText($webPidPath)
    $webProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $webPid" -ErrorAction SilentlyContinue
    if ($webProcess -and $webProcess.Name -eq 'python.exe' -and $webProcess.CommandLine -match 'http\.server\s+8082') {
        Stop-Process -Id $webPid
    }
    Remove-Item -LiteralPath $webPidPath
}
$container = docker ps --filter 'name=^/eyeler-postgres$' --format '{{.Names}}'
if ($LASTEXITCODE -ne 0) { throw 'DOCKER_UNAVAILABLE' }
if ($container) { docker stop eyeler-postgres | Out-Null }
Write-Host 'Web server and Postgres stopped. Named volume kept.'
Write-Host 'Press Ctrl+C in the backend PowerShell window for graceful shutdown.'
