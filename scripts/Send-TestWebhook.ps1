param(
    [string]$Url = "http://localhost:8787/webhooks/github",
    [Parameter(Mandatory = $true)]
    [string]$Secret,
    [string]$DeliveryId = ([guid]::NewGuid().ToString()),
    [string]$WorkflowRunId = "99001",
    [string]$RepositoryId = "424242",
    [string]$RepositoryFullName = "incidentpilot/demo",
    [string]$InstallationId = ""
)

$payloadObject = [ordered]@{
    action = "completed"
    repository = [ordered]@{
        id = [int64]$RepositoryId
        full_name = $RepositoryFullName
    }
    workflow_run = [ordered]@{
        id = [int64]$WorkflowRunId
        conclusion = "failure"
        head_sha = "0123456789abcdef0123456789abcdef01234567"
    }
}

if (-not [string]::IsNullOrWhiteSpace($InstallationId)) {
    $payloadObject.installation = [ordered]@{ id = [int64]$InstallationId }
}

$body = $payloadObject | ConvertTo-Json -Depth 10 -Compress
$utf8 = New-Object System.Text.UTF8Encoding($false)
$keyBytes = $utf8.GetBytes($Secret)
$bodyBytes = $utf8.GetBytes($body)

$hmac = New-Object System.Security.Cryptography.HMACSHA256
$hmac.Key = $keyBytes
try {
    $digest = $hmac.ComputeHash($bodyBytes)
} finally {
    $hmac.Dispose()
}

$hexDigest = ([BitConverter]::ToString($digest)).Replace("-", "").ToLowerInvariant()
$signature = "sha256=" + $hexDigest

$headers = @{
    "X-Hub-Signature-256" = $signature
    "X-GitHub-Delivery" = $DeliveryId
    "X-GitHub-Event" = "workflow_run"
}

Write-Host "Sending signed workflow failure..."
Write-Host "Delivery ID:    $DeliveryId"
Write-Host "WorkflowRun ID: $WorkflowRunId"
Write-Host "Body bytes:     $($bodyBytes.Length)"

$result = Invoke-RestMethod `
    -Method Post `
    -Uri $Url `
    -Headers $headers `
    -ContentType "application/json; charset=utf-8" `
    -Body $bodyBytes

$result | ConvertTo-Json -Depth 10

Write-Host "`nTip: run this script again with a different -DeliveryId but the same -WorkflowRunId."
Write-Host "It should return the same incidentId with duplicate=true."
