$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
$health = Get-LocalApiResponse '/health'
$ready = Get-LocalApiResponse '/ready'
$age = if ($null -ne $ready.Body.lastTickAgeMs) { "$($ready.Body.lastTickAgeMs) ms" } else { 'unknown' }
$reason = if ($ready.Body.reason) { $ready.Body.reason } else { 'none' }
Write-Host "Health: HTTP $($health.Status)"
Write-Host "Readiness: HTTP $($ready.Status); reason: $reason; last tick age: $age"
Write-Host "Perpl ready: $($ready.Body.venueReady); tick lock held: $($ready.Body.lockOwned)"
