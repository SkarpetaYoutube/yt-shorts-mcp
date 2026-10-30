# TEST 5 NOWYCH ROLEK na obecnej wersji programu (bez zmian kodu): pobranie eksportu -> zrzuty (kontekst + wycinki) -> paczka. Jedno uruchomienie, zero klikania.
# Log: wyniki\test_nowe_5_log.txt
param(
  [Parameter(Mandatory = $true)][string]$Manifest,
  [string]$Nazwa = "test_Dozzek_5",
  [string]$Rolki = "3vCANkZ_hAU,kHy_yZH05ns,YmltsQXdQTc,ELOpUxh52JA,E2BybkIVj6E"
)
$ErrorActionPreference = "Continue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$root = Split-Path $PSScriptRoot -Parent
$wyn = Join-Path $root "wyniki"; New-Item -ItemType Directory -Force -Path $wyn | Out-Null
$log = Join-Path $wyn "test_nowe_5_log.txt"
function Log($t) { Write-Host $t; Add-Content -Path $log -Value $t -Encoding UTF8 }
Set-Content -Path $log -Value "" -Encoding UTF8
Set-Location $PSScriptRoot
if (-not (Test-Path (Join-Path $PSScriptRoot "node_modules\playwright"))) { Log "npm install (jednorazowo)"; npm install 2>&1 | ForEach-Object { Log $_.ToString() } }
$T0 = Get-Date; Log ("START " + $T0.ToString("o"))
$s = Get-Date
& (Join-Path $root "pobierz_zestaw.ps1") -Manifest $Manifest -Nazwa $Nazwa 2>&1 | ForEach-Object { Log $_.ToString() }
$tD = [math]::Round(((Get-Date) - $s).TotalSeconds, 1); Log "CZAS pobranie_eksportu_s: $tD"
$dir = Join-Path $wyn $Nazwa; $json = Join-Path $dir "${Nazwa}_json.json"
if (-not (Test-Path $json)) { Log "BLAD: brak $json"; exit 1 }
$zr = Join-Path $dir "zrzuty"; $pk = Join-Path $dir "paczka"; New-Item -ItemType Directory -Force -Path $zr | Out-Null
$s = Get-Date
node zrzuty.mjs $json $zr --channel msedge --only $Rolki 2>&1 | ForEach-Object { Log $_.ToString() }
$c1 = $LASTEXITCODE; $tZ = [math]::Round(((Get-Date) - $s).TotalSeconds, 1)
$s = Get-Date
node zloz_paczke.mjs $json $zr $pk $Rolki 2>&1 | ForEach-Object { Log $_.ToString() }
$c2 = $LASTEXITCODE; $tS = [math]::Round(((Get-Date) - $s).TotalSeconds, 1)
$man = Join-Path $zr "frames_manifest.json"
if (Test-Path $man) { $cnt = node -e "const m=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));console.log('MANIFEST: '+m.length+' wpisow; kontekst kompletny: '+m.filter(e=>e.context_complete).length+'; '+m.map(e=>e.video_id.slice(0,5)+'#'+e.image_id+'='+(e.status||'?')).join(' '))" $man; Log $cnt }
Log "ETAP: pobranie=$tD s; zrzuty=$tZ s; skladanie=$tS s; kod_zrzutow=$c1 (0=komplet, 3=kontekst kompletny/wycinki czesciowo); kod_skladania=$c2"
Log "--- PODSUMOWANIE ---"
Get-Content $log | Select-String -Pattern "CZAS rolki|STATUS |PRZEBIEG|KOMPLET|NIEPE|odrzucony|brak vision|nie znaleziono|NIE znaleziono" | ForEach-Object { Write-Host $_.Line }
Log ("KONIEC " + (Get-Date).ToString("o") + "; calosc: " + [math]::Round(((Get-Date) - $T0).TotalSeconds, 1) + " s")
Log "Napisz 'gotowe' - sprawdze screeny z dysku."
