function Get-LocalRoot {
    return (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
}

function Get-LocalEnv {
    $path = Join-Path (Get-LocalRoot) '.env'
    if (-not (Test-Path -LiteralPath $path)) { throw 'ENV_FILE_MISSING' }
    $settings = @{}
    foreach ($line in [System.IO.File]::ReadAllLines($path)) {
        if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
            $settings[$Matches[1]] = $Matches[2].Trim()
        }
    }
    return $settings
}

function Get-LocalApiResponse([string]$path) {
    try {
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:8787$path" -UseBasicParsing -TimeoutSec 3
        return @{ Status = [int]$response.StatusCode; Body = ($response.Content | ConvertFrom-Json) }
    } catch {
        if (-not $_.Exception.Response) { return @{ Status = 0; Body = $null } }
        $response = $_.Exception.Response
        $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
        try { $body = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
        return @{ Status = [int]$response.StatusCode; Body = $body }
    }
}
