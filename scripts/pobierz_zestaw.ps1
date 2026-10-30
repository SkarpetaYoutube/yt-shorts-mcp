# Pobiera wszystkie pliki zestawu (CSV, JSON, czesci Markdown, status) z linku manifest i sprawdza SHA-256.
# Uzycie:  .\pobierz_zestaw.ps1 -Manifest "<manifest_link>" -Nazwa ethan_kiro
# Pliki trafiaja do wyniki\<Nazwa>\. Linki wygasaja po godzinie od wygenerowania eksportu.
param(
  [Parameter(Mandatory = $true)][string]$Manifest,
  [Parameter(Mandatory = $true)][string]$Nazwa
)
$ErrorActionPreference = "Stop"
$safe = ($Nazwa -replace '[^\w\-]', '_')
$dir = Join-Path $PSScriptRoot (Join-Path "wyniki" $safe)
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$m = Invoke-RestMethod -Uri $Manifest -UseBasicParsing
$ok = 0; $bad = 0
foreach ($f in $m.files) {
  $ext = if ($f.format -eq "csv") { "csv" } elseif ($f.format -eq "json" -or $f.format -eq "status") { "json" } else { "md" }
  $name = "$safe" + "_" + $f.format + "." + $ext
  $out = Join-Path $dir $name
  try {
    Invoke-WebRequest -Uri $f.url -OutFile $out -UseBasicParsing
    if ($f.sha256) {
      $h = (Get-FileHash -Algorithm SHA256 -Path $out).Hash.ToLower()
      if ($h -eq $f.sha256) { Write-Host "OK       $name"; $ok++ }
      else { Write-Host "ZLY SHA  $name" -ForegroundColor Red; $bad++ }
    } else { Write-Host "OK       $name (raport, bez sumy)"; $ok++ }
  } catch {
    Write-Host "BLAD     $name : $($_.Exception.Message)" -ForegroundColor Red; $bad++
  }
  Start-Sleep -Milliseconds 300
}
Write-Host ""
if ($m.partial_export) { Write-Host "Uwaga: eksport czesciowy (niezakonczone zadanie)." -ForegroundColor Yellow }
Write-Host "Gotowe: $ok OK, $bad problemow. Folder: $dir" -ForegroundColor Green
