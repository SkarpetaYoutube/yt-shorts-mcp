# DOKONCZENIE: 5 wpisow (Ymlts#1,#2; E2Byb#1,#3; kHy#1) - poprawione wykrywanie i regula "kadr po ostatniej wiadomosci". Bez Gemini/Supadata; 10 poprawnych wynikow nietknietych.
# 12 poprawnych wynikow zostaje nietkniete (program pomija zdjecia z kompletnym kontekstem). Log: wyniki\napraw4_log.txt
param(
  [string]$Nazwa = "test_Dozzek_5",
  [string]$Rolki = "YmltsQXdQTc,E2BybkIVj6E,kHy_yZH05ns",
  [string]$Redo = "YmltsQXdQTc#1,YmltsQXdQTc#2,E2BybkIVj6E#1,E2BybkIVj6E#3,kHy_yZH05ns#1",
  [string]$WszystkieRolki = "3vCANkZ_hAU,kHy_yZH05ns,YmltsQXdQTc,ELOpUxh52JA,E2BybkIVj6E"
)
$ErrorActionPreference = "Continue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$root = Split-Path $PSScriptRoot -Parent
$wyn = Join-Path $root "wyniki"
$log = Join-Path $wyn "napraw4_log.txt"
function Log($t) { Write-Host $t; Add-Content -Path $log -Value $t -Encoding UTF8 }
Set-Content -Path $log -Value "" -Encoding UTF8
Set-Location $PSScriptRoot
$dir = Join-Path $wyn $Nazwa; $zr = Join-Path $dir "zrzuty"; $pk = Join-Path $dir "paczka"
$json = Join-Path $dir "${Nazwa}_json.json"
if (-not (Test-Path $json)) { Log "BLAD: brak $json"; exit 1 }
$ts = Get-Date -Format "yyyyMMdd_HHmmss"
$man = Join-Path $zr "frames_manifest.json"
foreach ($f in @("frames_manifest.json", "diagnostyka.log", "przebieg.json")) { $p = Join-Path $zr $f; if (Test-Path $p) { Copy-Item $p (Join-Path $zr ($f -replace "\.([a-z]+)$", ".przed_naprawa4_$ts.`$1")) } }
$T0 = Get-Date; Log ("START " + $T0.ToString("o") + "; rolki do dokonczenia: $Rolki (bez Gemini/Supadata)")
node test_kontekst.mjs $json 2>&1 | Select-Object -Last 1 | ForEach-Object { Log $_.ToString() }
node zrzuty.mjs $json $zr --channel msedge --only $Rolki --redo $Redo --pause 3 2>&1 | ForEach-Object { Log $_.ToString() }
$c1 = $LASTEXITCODE; $tZ = [math]::Round(((Get-Date) - $T0).TotalSeconds, 1)
$s = Get-Date
node zloz_paczke.mjs $json $zr $pk $WszystkieRolki 2>&1 | ForEach-Object { Log $_.ToString() }
$c2 = $LASTEXITCODE; $tS = [math]::Round(((Get-Date) - $s).TotalSeconds, 1)
$cnt = node -e "const m=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));console.log('MANIFEST: '+m.length+' wpisow; kontekst kompletny: '+m.filter(e=>e.context_complete).length+'; '+m.map(e=>e.video_id.slice(0,5)+'#'+e.image_id+'='+(e.status||'?')).join(' '))" $man
Log $cnt
Log "ETAP naprawa4: zrzuty=$tZ s; skladanie=$tS s; kod_zrzutow=$c1 (0=komplet, 3=kontekst kompletny/wycinki czesciowo, 2=niepelne); kod_skladania=$c2"
Log "--- PODSUMOWANIE ---"
Get-Content $log | Select-String -Pattern "CZAS rolki|STATUS |odtwarzacz:|problem odtwarzacza|okno rozszerzone|PRZYPISANE|NIEJEDNOZNACZNE|NIE_ZNALEZIONO|PRZEBIEG|KOMPLET|NIEPE" | ForEach-Object { Write-Host $_.Line }
Log ("KONIEC " + (Get-Date).ToString("o") + "; calosc: " + [math]::Round(((Get-Date) - $T0).TotalSeconds, 1) + " s")
Log "Napisz 'gotowe' - sprawdze logi i screeny z dysku."
