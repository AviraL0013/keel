$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location -LiteralPath $root
New-Item -ItemType Directory -Path (Join-Path $root 'logs') -Force | Out-Null

Write-Host 'EYELER backend running. Press Ctrl+C here for graceful shutdown.'
# Windows PowerShell treats native stderr as an error record. API error logs
# must not terminate the long-running server pipeline.
$ErrorActionPreference = 'Continue'
node --env-file=.env dist/server/src/index.js 2>&1 |
    Tee-Object -FilePath (Join-Path $root 'logs\api.log') -Append
$exitCode = $LASTEXITCODE
"EYELER backend exited with code $exitCode" |
    Tee-Object -FilePath (Join-Path $root 'logs\api.log') -Append
