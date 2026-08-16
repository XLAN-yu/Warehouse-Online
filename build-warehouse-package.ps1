$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$sourceFolder = Join-Path $projectRoot "warehouse-offline"
$outputFolder = Join-Path $projectRoot "dist-packages"
$packageStem = -join @([char]0x4ED3, [char]0x50A8, [char]0x53F0, '-', [char]0x79BB, [char]0x7EBF, [char]0x6D4F, [char]0x89C8, [char]0x5668, [char]0x5DE5, [char]0x7A0B, [char]0x5305)
$outputFile = Join-Path $outputFolder ($packageStem + ".zip")
$runtimeData = Join-Path $sourceFolder "data\warehouse-data.json"
$fflateTarget = Join-Path $sourceFolder "fflate.min.js"
$fflateLicenseTarget = Join-Path $sourceFolder "fflate-LICENSE.txt"

if (-not (Test-Path -LiteralPath $sourceFolder -PathType Container)) {
    throw "Offline source folder not found: $sourceFolder"
}

if (Test-Path -LiteralPath $runtimeData -PathType Leaf) {
    $savedData = Get-Content -LiteralPath $runtimeData -Raw | ConvertFrom-Json
    $hasBusinessData = @($savedData.products).Count -gt 0 -or @($savedData.documents).Count -gt 0
    if ($hasBusinessData) {
        throw "Runtime data found at data\warehouse-data.json. Packaging stopped to protect business data."
    }
}

$runtimeBackups = Get-ChildItem -LiteralPath (Join-Path $sourceFolder "data\backups") -Filter "warehouse-backup-*.json" -File -ErrorAction SilentlyContinue
if ($runtimeBackups) {
    throw "Runtime backup data found in data\backups. Packaging stopped to protect business data."
}

if (-not (Test-Path -LiteralPath $fflateTarget -PathType Leaf) -or -not (Test-Path -LiteralPath $fflateLicenseTarget -PathType Leaf)) {
    throw "The vendored offline Excel parser or its license is missing from warehouse-offline."
}

New-Item -ItemType Directory -Path $outputFolder -Force | Out-Null

# 每次仅保留本次生成的离线包，避免把旧包误发给其他电脑。
Get-ChildItem -LiteralPath $outputFolder -Filter "*.zip" -File -ErrorAction SilentlyContinue | Remove-Item -Force

Compress-Archive -Path (Join-Path $sourceFolder "*") -DestinationPath $outputFile -CompressionLevel Optimal -Force

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($outputFile)
try {
    $leakedData = @($archive.Entries | Where-Object { $_.FullName -match '(^|/)data/(warehouse-data\.json|backups/warehouse-backup-.*\.json)$' })
    if ($leakedData.Count -gt 0) {
        throw "Packaged archive contains business data: $($leakedData.FullName -join ', ')"
    }
} finally {
    $archive.Dispose()
}

Write-Host "Offline package created: $outputFile"
