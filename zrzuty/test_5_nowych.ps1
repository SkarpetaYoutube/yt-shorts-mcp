# TEST 5 NOWYCH ROLEK - jedna komenda, bez zmian kodu w trakcie, z twardym limitem czasu calej proby.
# Uzycie: .\test_5_nowych.ps1 -Manifest "<link eksportu>" -Nazwa "test_<kanal>_5"
# Najdluzej: pobranie <= 120 s + zrzuty <= MaxCalosc s (+20 s na wymuszone zakonczenie) + skladanie paczki (sekundy).
# Program NIE sprawdza tresci kadrow: wynik "pelny" jest NIEZWERYFIKOWANY do czasu kontroli wzrokowej (audyt.mjs).
param(
  [Parameter(Mandatory = $true)][string]$Manifest,
  [Parameter(Mandatory = $true)][string]$Nazwa,
  [int]$MaxCalosc = 1500,
  [int]$MaxRolka = 300,
  [switch]$BezDrugiejRundy
)
$ErrorActionPreference = "Continue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$root = Split-Path $PSScriptRoot -Parent
$dlScript = if (Test-Path (Join-Path $root "pobierz_zestaw.ps1")) { Join-Path $root "pobierz_zestaw.ps1" } else { Join-Path $root "scripts\pobierz_zestaw.ps1" }
$wyn = Join-Path $root "wyniki"; New-Item -ItemType Directory -Force -Path $wyn | Out-Null
$log = Join-Path $wyn ($Nazwa + "_log.txt")
function Log($t) { Write-Host $t; Add-Content -Path $log -Value $t -Encoding UTF8 }
Set-Content -Path $log -Value "" -Encoding UTF8
Set-Location $PSScriptRoot
$T0 = Get-Date; Log ("START " + $T0.ToString("o") + "; limit zrzutow: $MaxCalosc s, limit rolki: $MaxRolka s")
# 1) pobranie eksportu (limit 120 s)
$s = Get-Date
$job = Start-Job -ScriptBlock { param($p, $m, $n) & $p -Manifest $m -Nazwa $n 2>&1 | Out-String } -ArgumentList $dlScript, $Manifest, $Nazwa
if (Wait-Job $job -Timeout 120) { Receive-Job $job | ForEach-Object { Log $_ } } else { Stop-Job $job; Log "BLAD: pobranie przekroczylo 120 s"; exit 1 }
$tD = [math]::Round(((Get-Date) - $s).TotalSeconds, 1); Log "CZAS pobranie_s: $tD"
$dir = Join-Path $wyn $Nazwa; $json = Join-Path $dir "${Nazwa}_json.json"
if (-not (Test-Path $json)) { Log "BLAD: brak $json"; exit 1 }
# 2) czy rolki sa nowe i maja wynik wizji (bez tego test nie ma sensu - przerwij przed przegladarka)
node sprawdz_nowe.mjs $json $wyn $dir 2>&1 | ForEach-Object { Log $_.ToString() }
$cN = $LASTEXITCODE
if ($cN -ne 0) { Log "PRZERWANO PRZED TESTEM: kod $cN (5 = rolka juz przetwarzana, 6 = brak wyniku wizji, 7 = liczba rolek inna niz 5)"; exit $cN }
$ids = node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).map(r=>r.video_id).join(','))" $json
$zr = Join-Path $dir "zrzuty"; $pk = Join-Path $dir "paczka"; New-Item -ItemType Directory -Force -Path $zr | Out-Null
# 3) zrzuty z twardym limitem
$s = Get-Date
node zrzuty.mjs $json $zr --channel msedge --only $ids --pause 3 --max-total $MaxCalosc --reel-max $MaxRolka 2>&1 | ForEach-Object { Log $_.ToString() }
$c1 = $LASTEXITCODE
# druga runda: rolki z brakami (np. chwilowe bledy odtwarzacza YouTube) dostaja jedna ponowna probe ze swiezym budzetem; wyniki juz dobre zostaja (mergeBest), a stare logi sa archiwizowane
if ($c1 -eq 2 -and -not $BezDrugiejRundy) {
  $zostalo = $MaxCalosc - [int]((Get-Date) - $s).TotalSeconds
  if ($zostalo -gt 120) {
    Log "DRUGA RUNDA dla rolek z brakami (z limitu calosci zostalo $zostalo s)"; Start-Sleep -Seconds 20
    node zrzuty.mjs $json $zr --channel msedge --only $ids --pause 3 --max-total ([math]::Max(60, $zostalo - 20)) --reel-max $MaxRolka --reloads 4 --retry-budget 180 --buffer-wait 30 2>&1 | ForEach-Object { Log $_.ToString() }
    $c1 = $LASTEXITCODE
  } else { Log "Druga runda pominieta: za malo czasu z limitu calosci ($zostalo s)" }
}
$tZ = [math]::Round(((Get-Date) - $s).TotalSeconds, 1)
# 4) paczka
$s = Get-Date
node zloz_paczke.mjs $json $zr $pk $ids 2>&1 | ForEach-Object { Log $_.ToString() }
$c2 = $LASTEXITCODE; $tS = [math]::Round(((Get-Date) - $s).TotalSeconds, 1)
Log "ETAP: pobranie=$tD s; zrzuty=$tZ s (limit $MaxCalosc s); skladanie=$tS s; kod_zrzutow=$c1 (4 = przerwano limitem calosci); kod_paczki=$c2"
Log "--- PODSUMOWANIE ---"
Get-Content $log | Select-String -Pattern "WYNIK:|STAN:|CZAS rolki|odtwarzacz:|LIMIT|PRZERWANO" | ForEach-Object { Write-Host $_.Line }
Log ("KONIEC " + (Get-Date).ToString("o") + "; calosc: " + [math]::Round(((Get-Date) - $T0).TotalSeconds, 1) + " s")
Log "Wynik 'pelny' jest NIEZWERYFIKOWANY. Napisz 'gotowe' - sprawdze kadry wzrokowo i zapisze ocene (audyt.mjs)."
# kod wyjscia = najgorszy kod etapu (0 komplet, 2 niepelna, 4 limit czasu), zeby wywolujacy widzial wynik (wczesniej skrypt zawsze konczyl sie kodem 0)
exit ([math]::Max([int]$c1, [int]$c2))
