param(
    [ValidateRange(1, 10080)][int]$Minutes = 15,
    [string]$LogPath = (Join-Path $PSScriptRoot '..\..\logs\api.log')
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $LogPath)) { throw 'API_LOG_MISSING' }

$now = [DateTimeOffset]::UtcNow
$start = $now.AddMinutes(-$Minutes)
$events = @(
    foreach ($line in Get-Content -LiteralPath $LogPath) {
        if ($line -notmatch 'PERPL_WS_CLOSE at=(?<at>\S+) .*?code=(?<code>\d+) reason="(?<reason>[^"]*)"') { continue }
        $stamp = [DateTimeOffset]::MinValue
        if (-not [DateTimeOffset]::TryParse($Matches.at, [ref]$stamp)) { continue }
        if ($stamp -lt $start -or $stamp -gt $now) { continue }
        $reason = switch ($Matches.reason) {
            '' { '(none)' }
            'ping timeout' { 'ping timeout' }
            'idle timeout' { 'idle timeout' }
            'too many requests' { 'too many requests' }
            default { '(other)' }
        }
        [pscustomobject]@{ At = $stamp; Code = $Matches.code; Reason = $reason }
    }
) | Sort-Object At

Write-Output "Window: last $Minutes minutes (UTC)"
Write-Output "Closes: $($events.Count)"
foreach ($group in $events | Group-Object Code, Reason | Sort-Object Name) {
    Write-Output "Count: $($group.Count) code/reason: $($group.Name)"
}
$previous = $null
foreach ($event in $events) {
    $gap = if ($null -eq $previous) { '-' } else { '{0:N1}s' -f ($event.At - $previous).TotalSeconds }
    Write-Output "Time: $($event.At.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')) code=$($event.Code) reason=$($event.Reason) gap=$gap"
    $previous = $event.At
}
