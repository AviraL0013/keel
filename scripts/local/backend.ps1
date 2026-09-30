$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location -LiteralPath $root
New-Item -ItemType Directory -Path (Join-Path $root 'logs') -Force | Out-Null

$logPath = Join-Path $root 'logs\api.log'
# A native pipeline stops on Ctrl+C before Tee-Object can drain Node's
# graceful-shutdown output. A transcript records direct console output instead.
Start-Transcript -Path $logPath -Append | Out-Null
try {
    Write-Host 'EYELER backend running. Press Ctrl+C here for graceful shutdown.'
    node --env-file=.env dist/server/src/index.js
} finally {
    Stop-Transcript | Out-Null
}
