param(
    [Parameter(Mandatory = $true)]
    [string]$PemPath
)

$ErrorActionPreference = "Stop"

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$converter = Join-Path $PSScriptRoot "Prepare-GitHubPrivateKey.mjs"
$devVars = Join-Path $projectRoot "apps\control-plane\.dev.vars"
$tempFile = Join-Path $env:TEMP ("incidentpilot-github-key-" + [guid]::NewGuid().ToString() + ".b64")

try {
    & node $converter $PemPath $tempFile
    if ($LASTEXITCODE -ne 0) {
        throw "Private-key conversion failed."
    }

    $privateKeyB64 = (Get-Content -LiteralPath $tempFile -Raw).Trim()
    if ([string]::IsNullOrWhiteSpace($privateKeyB64)) {
        throw "Converted private key was empty."
    }

    $existing = ""
    if (Test-Path -LiteralPath $devVars) {
        $existing = Get-Content -LiteralPath $devVars -Raw
    }

    $line = "GITHUB_APP_PRIVATE_KEY_B64=$privateKeyB64"
    if ($existing -match '(?m)^GITHUB_APP_PRIVATE_KEY_B64=.*$') {
        $updated = [regex]::Replace(
            $existing,
            '(?m)^GITHUB_APP_PRIVATE_KEY_B64=.*$',
            $line
        )
    }
    else {
        if ($existing.Length -gt 0 -and -not $existing.EndsWith("`n")) {
            $existing += "`r`n"
        }
        $updated = $existing + $line + "`r`n"
    }

    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($devVars, $updated, $utf8NoBom)

    Write-Host "Configured GITHUB_APP_PRIVATE_KEY_B64 in apps/control-plane/.dev.vars."
    Write-Host "The private key value was not printed."
}
finally {
    Remove-Item -LiteralPath $tempFile -Force -ErrorAction SilentlyContinue
}
