$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$sourceFolder = Join-Path $projectRoot "warehouse-offline"
$outputFolder = Join-Path $projectRoot "dist-packages"
$packageStem = -join @([char]0x4ED3, [char]0x50A8, [char]0x53F0, '-', [char]0x79BB, [char]0x7EBF, [char]0x6D4F, [char]0x89C8, [char]0x5668, [char]0x5DE5, [char]0x7A0B, [char]0x5305)
$outputFile = Join-Path $outputFolder ($packageStem + ".zip")
$runtimeData = Join-Path $sourceFolder "data\warehouse-data.json"

if (-not (Test-Path -LiteralPath $sourceFolder -PathType Container)) {
    throw "Offline source folder not found: $sourceFolder"
}

if (Test-Path -LiteralPath $runtimeData -PathType Leaf) {
    throw "Runtime data found at data\warehouse-data.json. Packaging stopped to protect business data."
}

New-Item -ItemType Directory -Path $outputFolder -Force | Out-Null

Get-ChildItem -LiteralPath $outputFolder -Filter ($packageStem + "*.zip") -File |
    Remove-Item -Force

Compress-Archive -Path (Join-Path $sourceFolder "*") -DestinationPath $outputFile -CompressionLevel Optimal

Write-Host "Offline package created: $outputFile"
