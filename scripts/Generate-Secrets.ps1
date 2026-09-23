$ErrorActionPreference = "Stop"
function New-RandomBytes([int]$Count) {
  $bytes = New-Object byte[] $Count
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  return $bytes
}
$webhookBytes = New-RandomBytes 64
$webhook = ([BitConverter]::ToString($webhookBytes)).Replace("-", "").ToLowerInvariant()
$evidenceKey = [Convert]::ToBase64String((New-RandomBytes 32))
Write-Host "GITHUB_WEBHOOK_SECRET=$webhook" -ForegroundColor Green
Write-Host "EVIDENCE_ENCRYPTION_KEY_B64=$evidenceKey" -ForegroundColor Green
Write-Host "Store these only in apps/control-plane/.dev.vars / Cloudflare Secrets." -ForegroundColor Yellow
