param([switch]$NoBrowser, [int]$Port = 0)

$ErrorActionPreference = "Stop"

$packageRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
$dataDirectory = Join-Path $packageRoot "data"
$backupDirectory = Join-Path $dataDirectory "backups"
$stateFile = Join-Path $dataDirectory "warehouse-data.json"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

New-Item -ItemType Directory -Path $dataDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null

function Write-Utf8File {
  param([string]$Path, [string]$Content)
  [System.IO.File]::WriteAllText($Path, $Content, $utf8NoBom)
}

function Get-EmptyStateJson {
  return '{"version":1,"products":[],"documents":[],"settings":{"fontScale":1},"undoHistory":[]}'
}

function Test-StateJson {
  param([string]$Content)
  if ([string]::IsNullOrWhiteSpace($Content)) {
    throw "Data cannot be empty."
  }
  $parsed = $Content | ConvertFrom-Json
  if ($null -eq $parsed.products -or $null -eq $parsed.documents) {
    throw "Invalid warehouse data format."
  }
  return $parsed
}

function Save-State {
  param([string]$Content)
  $null = Test-StateJson -Content $Content
  $temporaryFile = "$stateFile.tmp"
  Write-Utf8File -Path $temporaryFile -Content $Content
  Move-Item -LiteralPath $temporaryFile -Destination $stateFile -Force
}

function Remove-ExpiredBackups {
  $expiry = (Get-Date).AddDays(-30)
  Get-ChildItem -LiteralPath $backupDirectory -Filter "warehouse-backup-*.json" -File -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -lt $expiry } |
    Remove-Item -Force
}

function New-DataBackup {
  param([string]$Kind)
  if (-not (Test-Path -LiteralPath $stateFile)) {
    Write-Utf8File -Path $stateFile -Content (Get-EmptyStateJson)
  }
  $data = Get-Content -LiteralPath $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json
  $wrapper = [ordered]@{
    format = "warehouse-offline-backup"
    version = 1
    createdAt = (Get-Date).ToUniversalTime().ToString("o")
    data = $data
  }
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss-fff"
  $fileName = "warehouse-backup-$Kind-$stamp.json"
  $target = Join-Path $backupDirectory $fileName
  Write-Utf8File -Path $target -Content ($wrapper | ConvertTo-Json -Depth 100)
  Remove-ExpiredBackups
  return $fileName
}

function Invoke-WeeklyBackup {
  $latest = Get-ChildItem -LiteralPath $backupDirectory -Filter "warehouse-backup-*.json" -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if ($null -eq $latest -or $latest.LastWriteTime -lt (Get-Date).AddDays(-7)) {
    $null = New-DataBackup -Kind "auto"
  } else {
    Remove-ExpiredBackups
  }
}

function Read-RequestBody {
  param($Request)
  if ($Request.ContentLength64 -gt 52428800) {
    throw "Data file is too large."
  }
  $reader = New-Object System.IO.StreamReader($Request.InputStream, [System.Text.Encoding]::UTF8)
  try {
    return $reader.ReadToEnd()
  } finally {
    $reader.Dispose()
  }
}

function Send-Response {
  param($Context, [int]$Status, [string]$ContentType, [string]$Content)
  $bytes = $utf8NoBom.GetBytes($Content)
  $Context.Response.StatusCode = $Status
  $Context.Response.ContentType = "$ContentType; charset=utf-8"
  $Context.Response.ContentLength64 = $bytes.Length
  $Context.Response.Headers["Cache-Control"] = "no-store"
  $Context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
  $Context.Response.OutputStream.Close()
}

if (-not (Test-Path -LiteralPath $stateFile)) {
  Write-Utf8File -Path $stateFile -Content (Get-EmptyStateJson)
}

$listener = $null
$selectedPort = $null
$candidatePorts = if ($Port -gt 0) { @($Port) } else { @(8765..8775) }
foreach ($candidatePort in $candidatePorts) {
  $candidate = New-Object System.Net.HttpListener
  $candidate.Prefixes.Add("http://127.0.0.1:$candidatePort/")
  try {
    $candidate.Start()
    $listener = $candidate
    $selectedPort = $candidatePort
    break
  } catch {
    $candidate.Close()
  }
}

if ($null -eq $listener) {
  throw "Cannot start the local warehouse service. The requested local port is unavailable."
}

$address = "http://127.0.0.1:$selectedPort/"
Write-Host "Warehouse Offline is running: $address"
Write-Host "Data file: $stateFile"
Write-Host "Close this window or press Ctrl+C to stop."
if (-not $NoBrowser) {
  Start-Process $address
}

try {
  while ($listener.IsListening) {
    $context = $listener.GetContext()
    try {
      $method = $context.Request.HttpMethod
      $path = $context.Request.Url.AbsolutePath

      if ($method -eq "GET" -and $path -eq "/api/data") {
        $content = Get-Content -LiteralPath $stateFile -Raw -Encoding UTF8
        Send-Response -Context $context -Status 200 -ContentType "application/json" -Content $content
        continue
      }

      if ($method -eq "POST" -and $path -eq "/api/data") {
        $body = Read-RequestBody -Request $context.Request
        Save-State -Content $body
        try { Invoke-WeeklyBackup } catch { Write-Warning $_.Exception.Message }
        Send-Response -Context $context -Status 200 -ContentType "application/json" -Content '{"ok":true}'
        continue
      }

      if ($method -eq "POST" -and $path -eq "/api/backup") {
        $body = Read-RequestBody -Request $context.Request
        Save-State -Content $body
        $backupName = New-DataBackup -Kind "manual"
        $result = @{ ok = $true; file = $backupName } | ConvertTo-Json -Compress
        Send-Response -Context $context -Status 200 -ContentType "application/json" -Content $result
        continue
      }

      $staticFiles = @{
        "/" = @{ Name = "index.html"; Type = "text/html" }
        "/index.html" = @{ Name = "index.html"; Type = "text/html" }
        "/app.css" = @{ Name = "app.css"; Type = "text/css" }
        "/app.js" = @{ Name = "app.js"; Type = "application/javascript" }
        "/fflate.min.js" = @{ Name = "fflate.min.js"; Type = "application/javascript" }
      }

      if ($method -eq "GET" -and $staticFiles.ContainsKey($path)) {
        $entry = $staticFiles[$path]
        $filePath = Join-Path $packageRoot $entry.Name
        $content = Get-Content -LiteralPath $filePath -Raw -Encoding UTF8
        Send-Response -Context $context -Status 200 -ContentType $entry.Type -Content $content
        continue
      }

      Send-Response -Context $context -Status 404 -ContentType "text/plain" -Content "Not found"
    } catch {
      try {
        $message = @{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
        Send-Response -Context $context -Status 500 -ContentType "application/json" -Content $message
      } catch {}
    }
  }
} finally {
  $listener.Stop()
  $listener.Close()
}
