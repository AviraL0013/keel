$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location -LiteralPath $root
New-Item -ItemType Directory -Path (Join-Path $root 'logs') -Force | Out-Null

$logPath = Join-Path $root 'logs\api.log'
# Keep Node attached to this console so Ctrl+C reaches its shutdown handler.
# The preload copies Node output to the log without a PowerShell pipeline.
$env:EYELER_LOCAL_LOG_FILE = $logPath
try {
    Write-Host 'EYELER backend running. Press Ctrl+C here for graceful shutdown.'
    node --require (Join-Path $PSScriptRoot 'tee-output.cjs') --env-file=.env dist/server/src/index.js
} finally {
    Remove-Item Env:EYELER_LOCAL_LOG_FILE -ErrorAction SilentlyContinue
}
