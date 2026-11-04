# TikTok: pobiera eksport z linku manifest (export_tiktok) i układa go w czytelne foldery:
#   wyniki\TikTok - <konto>\<konto> - <opis> [<ID>]\  (dane.md, dane.json, dane.csv, transkrypt.txt, transkrypt_czasy.txt)
#   wyniki\TikTok - <konto>\_zbiorczo\ (indeks_filmow.csv/md, do_analizy.md, eksport_serwera\)  i  _baza\ (baza_filmow.json/csv, historia statystyk)
# Użycie:  .\zbierz_tiktok.ps1 -Manifest "<manifest_link>"      (link jest ważny 1 godzinę od eksportu)
param([Parameter(Mandatory = $true)][string]$Manifest)
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$root = Split-Path $PSScriptRoot -Parent
$dl = if (Test-Path (Join-Path $root "pobierz_zestaw.ps1")) { Join-Path $root "pobierz_zestaw.ps1" } else { Join-Path $root "scripts\pobierz_zestaw.ps1" }
$tmpNazwa = "_pobrane_tiktok"
$tmp = Join-Path $root (Join-Path "wyniki" $tmpNazwa)
if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
& $dl -Manifest $Manifest -Nazwa $tmpNazwa
$json = Get-ChildItem $tmp -Filter "*_json.json" | Select-Object -First 1
if (-not $json) { Write-Host "BLAD: nie pobrano pliku JSON eksportu" -ForegroundColor Red; exit 1 }
Set-Location $PSScriptRoot
node tiktok_rozloz.mjs $json.FullName (Join-Path $root "wyniki") --zrodlo $tmp
if ($LASTEXITCODE -ne 0) { Write-Host "BLAD: nie udalo sie ulozyc wynikow (pliki eksportu zostaly w $tmp)" -ForegroundColor Red; exit 1 }
Remove-Item -Recurse -Force $tmp # kopia plikow eksportu jest w _zbiorczo\eksport_serwera
Write-Host "GOTOWE. Wyniki: $(Join-Path $root 'wyniki')\TikTok - <konto>"
