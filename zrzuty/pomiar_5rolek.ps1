# POMIAR (bez zmian w kodzie procesu): pobranie eksportu -> zrzuty -> skladanie paczki, osobne czasy, jeden log.
param(
  [Parameter(Mandatory = $true)][string]$Manifest,
  [string]$Nazwa = "test_KiroText_5",
  [string]$Tylko = "cN_DmOQ6PT4,IQJ3ePQ7lkE,ZL2y7X_k2zY,rJwcXAKCklE,kIjN-ZODqRM"
)
$ErrorActionPreference = "Continue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$root = Split-Path $PSScriptRoot -Parent
$dir = Join-Path $root (Join-Path "wyniki" $Nazwa)
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$log = Join-Path $dir "pomiar_log.txt"
function Log($t) { Write-Host $t; Add-Content -Path $log -Value $t -Encoding UTF8 }
Set-Content -Path $log -Value "" -Encoding UTF8
$T0 = Get-Date
Log ("START " + $T0.ToString("o"))
# 1) pobranie
$s = Get-Date
& (Join-Path $root "pobierz_zestaw.ps1") -Manifest $Manifest -Nazwa $Nazwa 2>&1 | ForEach-Object { Log $_.ToString() }
$tPobr = [math]::Round(((Get-Date) - $s).TotalSeconds, 1)
Log "CZAS pobranie_eksportu_s: $tPobr"
$json = Join-Path $dir ($Nazwa + "_json.json")
if (-not (Test-Path $json)) { Log "BLAD: brak $json"; exit 1 }
Set-Location $PSScriptRoot
if (-not (Test-Path (Join-Path $PSScriptRoot "node_modules\playwright"))) { Log "npm install"; npm install 2>&1 | ForEach-Object { Log $_.ToString() } }
# 2) zrzuty
$zr = Join-Path $dir "zrzuty"
$s = Get-Date
node zrzuty.mjs $json $zr --channel msedge --only $Tylko 2>&1 | ForEach-Object { Log $_.ToString() }
$c1 = $LASTEXITCODE
$tZrz = [math]::Round(((Get-Date) - $s).TotalSeconds, 1)
Log "CZAS zrzuty_s: $tZrz (kod $c1)"
# 3) skladanie
$pk = Join-Path $dir "paczka"
$s = Get-Date
node zloz_paczke.mjs $json $zr $pk $Tylko 2>&1 | ForEach-Object { Log $_.ToString() }
$c2 = $LASTEXITCODE
$tSkl = [math]::Round(((Get-Date) - $s).TotalSeconds, 1)
Log "CZAS skladanie_s: $tSkl (kod $c2)"
$tAll = [math]::Round(((Get-Date) - $T0).TotalSeconds, 1)
$dl = Join-Path $zr "diagnostyka.log"
$ret = 0; if (Test-Path $dl) { $ret = (Select-String -Path $dl -Pattern "prze.adowuj" -AllMatches | Measure-Object).Count }
Log "PODSUMOWANIE: pobranie=$tPobr s; zrzuty=$tZrz s; skladanie=$tSkl s; razem=$tAll s; linie_ponowien_w_diagnostyce=$ret"
Log ("KONIEC " + (Get-Date).ToString("o"))
if ($c1 -ne 0 -or $c2 -ne 0) { Log "WYNIK: NIEPELNA/NIEPOWODZENIE - szczegoly: $pk\paczka.md i $dl"; exit 1 }
Log ("WYNIK: KOMPLET  PACZKA: " + $pk)
