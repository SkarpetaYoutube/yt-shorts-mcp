# Pobiera gotowy eksport z serwera MCP do folderu wyniki\<kanal>\ i sprawdza SHA-256.
# Uzycie (PowerShell, w folderze yt-mcp):
#   .\pobierz.ps1 -Kanal ethan -Csv "<link csv>" -Json "<link json>" -ShaCsv "<sha256 csv>" -ShaJson "<sha256 json>"
param(
  [Parameter(Mandatory)][string]$Kanal,
  [Parameter(Mandatory)][string]$Csv,
  [string]$Json,
  [string]$ShaCsv,
  [string]$ShaJson
)
$ErrorActionPreference = "Stop"
$ROOT = if (Test-Path (Join-Path $PSScriptRoot "wrangler.jsonc")) { $PSScriptRoot } else { Split-Path $PSScriptRoot -Parent }
$dir = Join-Path $ROOT "wyniki\$Kanal"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$stamp = Get-Date -Format "yyyyMMdd_HHmm"
function Get-One($url, $ext, $sha) {
  $out = Join-Path $dir "$Kanal`_$stamp.$ext"
  Invoke-WebRequest -Uri $url -OutFile $out -UseBasicParsing
  $h = (Get-FileHash $out -Algorithm SHA256).Hash.ToLower()
  if ($sha -and $h -ne $sha.ToLower()) { Write-Host "UWAGA: SHA-256 sie nie zgadza: $out" -ForegroundColor Red }
  else { Write-Host "OK $out" -ForegroundColor Green }
}
Get-One $Csv "csv" $ShaCsv
if ($Json) { Get-One $Json "json" $ShaJson }
