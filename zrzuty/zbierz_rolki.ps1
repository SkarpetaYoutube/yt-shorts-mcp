# WSZYSTKO NA RAZ (część lokalna): z eksportu kanału (link manifest z export_collection) robi
#   1) pobranie plików eksportu (CSV/JSON/Markdown/status, sprawdza SHA-256),
#   2) prawdziwe zrzuty zdjęć z rolek (Edge, ten sam potok co dotąd, z drugą rundą dla tego, co zawiodło),
#   3) osobny folder dla każdej rolki:  wyniki\<Kanał>\<Kanał> - <Tytuł rolki> [<ID>]\
#        dane.json / dane.csv / dane.md   (statystyki, transkrypt z czasami, komentarze, wizja Gemini)
#        zdjecia\ (same zdjęcia)   klatki\ (rozmowa z kontekstem)   zdjecia.md / zdjecia.json (status każdego zdjęcia)
#      oraz wyniki\<Kanał>\_zbiorczo\ (eksport całego kanału) i wyniki\<Kanał>\_zrzuty_robocze\ (surowe zrzuty i logi; ponowne uruchomienie wznawia).
# Część serwerowa (collect_shorts -> wizja -> export_collection) wykonuje Claude w rozmowie; ten skrypt dostaje z niej link manifest.
# Użycie:  .\zbierz_rolki.ps1 -Manifest "<manifest_link>"
# Program nie czyta tekstu na klatkach: status zdjęcia „pełny” bez przeglądu wzrokowego znaczy „wg programu” (patrz zdjecia.md).
param(
  [Parameter(Mandatory = $true)][string]$Manifest,
  [string]$Nazwa = "eksport",
  [string]$Wynik = "",
  [int]$MaxCalosc = 1500,
  [int]$MaxRolka = 300,
  [string]$Tylko = "",
  [switch]$BezDrugiejRundy,
  [switch]$BezZrzutow
)
$ErrorActionPreference = "Continue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$root = Split-Path $PSScriptRoot -Parent
$dlScript = if (Test-Path (Join-Path $root "pobierz_zestaw.ps1")) { Join-Path $root "pobierz_zestaw.ps1" } else { Join-Path $root "scripts\pobierz_zestaw.ps1" }
$wyn = if ($Wynik) { $Wynik } else { Join-Path $root "wyniki" }
New-Item -ItemType Directory -Force -Path $wyn | Out-Null
Set-Location $PSScriptRoot
$T0 = Get-Date
# 1) pobranie eksportu do folderu tymczasowego (limit 120 s); po rozłożeniu na rolki folder jest usuwany
$safe = "_pobrane_" + ($Nazwa -replace '[^\w\-]', '_')
$tmp = Join-Path $root (Join-Path "wyniki" $safe)
$job = Start-Job -ScriptBlock { param($p, $m, $n) & $p -Manifest $m -Nazwa $n 2>&1 | Out-String } -ArgumentList $dlScript, $Manifest, $safe
if (Wait-Job $job -Timeout 120) { Receive-Job $job | ForEach-Object { Write-Host $_ } } else { Stop-Job $job; Write-Host "BLAD: pobranie przekroczylo 120 s" -ForegroundColor Red; exit 1 }
if (-not (Get-ChildItem $tmp -Filter "*_json.json" -ErrorAction SilentlyContinue)) { Write-Host "BLAD: nie pobrano pliku JSON eksportu ($tmp)" -ForegroundColor Red; exit 1 }
$kanal = (node rozloz_na_rolki.mjs --kanal $tmp).Trim()
$ids = (node rozloz_na_rolki.mjs --ids $tmp).Trim()
if ($Tylko) { $ids = $Tylko }
$kanalDir = Join-Path $wyn $kanal
$robocze = Join-Path $kanalDir "_zrzuty_robocze"
New-Item -ItemType Directory -Force -Path $robocze | Out-Null
$log = Join-Path $robocze "log.txt"
function Log($t) { Write-Host $t; Add-Content -Path $log -Value $t -Encoding UTF8 }
Log ("START " + $T0.ToString("o") + " | kanal: $kanal | rolek ze zdjeciami wg wizji: " + $(if ($ids) { ($ids -split ',').Count } else { 0 }))
$json = (Get-ChildItem $tmp -Filter "*_json.json")[0].FullName
# 2) zrzuty (jak w test_5_nowych.ps1: twarde limity czasu, druga runda tylko dla brakujacych)
$c1 = 0
if ($BezZrzutow) { Log "Zrzuty pominiete (-BezZrzutow)." }
elseif (-not $ids) { Log "Zadna rolka nie ma zdjec wg wizji (albo wizji nie wykonano): zrzutow nie robie." }
else {
  $s = Get-Date
  node zrzuty.mjs $json $robocze --channel msedge --only $ids --pause 3 --max-total $MaxCalosc --reel-max $MaxRolka 2>&1 | ForEach-Object { Log $_.ToString() }
  $c1 = $LASTEXITCODE
  if (($c1 -eq 1 -or $c1 -eq 2) -and -not $BezDrugiejRundy) {
    $zostalo = $MaxCalosc - [int]((Get-Date) - $s).TotalSeconds
    if ($zostalo -gt 120) {
      Log "DRUGA RUNDA dla rolek z brakami (z limitu calosci zostalo $zostalo s)"; Start-Sleep -Seconds 20
      node zrzuty.mjs $json $robocze --channel msedge --only $ids --pause 3 --max-total ([math]::Max(60, $zostalo - 20)) --reel-max $MaxRolka --reloads 4 --retry-budget 180 --buffer-wait 30 2>&1 | ForEach-Object { Log $_.ToString() }
      $c1 = $LASTEXITCODE
    } else { Log "Druga runda pominieta: za malo czasu z limitu calosci ($zostalo s)" }
  }
}
# 3) foldery per rolka
$zr = if (Test-Path (Join-Path $robocze "frames_manifest.json")) { $robocze } else { "-" }
$only = if ($Tylko) { @("--only", $Tylko) } else { @() }
node rozloz_na_rolki.mjs $tmp $zr $wyn @only 2>&1 | ForEach-Object { Log $_.ToString() }
$c2 = $LASTEXITCODE
if ($c2 -ne 1 -and (Test-Path $kanalDir)) { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue } # pliki eksportu sa juz w _zbiorczo
Log ("KONIEC " + (Get-Date).ToString("o") + "; calosc: " + [math]::Round(((Get-Date) - $T0).TotalSeconds, 1) + " s | folder kanalu: $kanalDir")
# kod wyjscia: 0 komplet, 2 czesc zdjec bez zrzutu, 4 limit czasu zrzutow, 1 blad
exit ([math]::Max([int]$(if ($c1 -eq 3) { 0 } else { $c1 }), [int]$c2))
