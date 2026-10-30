# JEDNO URUCHOMIENIE, BEZ KLIKANIA: (A) 2 przyklady kontekstu z rolki 3vCANkZ_hAU, (B) 5 rolek @KiroText, (C) powtorka B na tym samym profilu (potwierdzenie, ze zgoda/cookies sa zapamietane).
# Uzywa osobnego, trwalego profilu programu (..\profil_przegladarki_programu), NIE Twojego profilu Edge. Wynik: wyniki\test_calosc_log.txt
param(
  [Parameter(Mandatory = $true)][string]$Manifest,
  [string]$Nazwa = "test_KiroText_5",
  [string]$Tylko = "cN_DmOQ6PT4,IQJ3ePQ7lkE,ZL2y7X_k2zY,rJwcXAKCklE,kIjN-ZODqRM",
  [switch]$NowyProfil   # przenosi dotychczasowy profil programu na bok (nie kasuje) i zaczyna od czystego, zeby wybor "Odrzuc wszystko" zapisal program
)
$ErrorActionPreference = "Continue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$root = Split-Path $PSScriptRoot -Parent
$wyn = Join-Path $root "wyniki"
New-Item -ItemType Directory -Force -Path $wyn | Out-Null
$log = Join-Path $wyn "test_calosc_log.txt"
function Log($t) { Write-Host $t; Add-Content -Path $log -Value $t -Encoding UTF8 }
Set-Content -Path $log -Value "" -Encoding UTF8
Set-Location $PSScriptRoot
if (-not (Test-Path (Join-Path $PSScriptRoot "node_modules\playwright"))) { Log "npm install (jednorazowo)"; npm install 2>&1 | ForEach-Object { Log $_.ToString() } }
$prof = Join-Path $root "profil_przegladarki_programu"
if ($NowyProfil -and (Test-Path $prof)) { $stary = $prof + "_stary_" + (Get-Date -Format "yyyyMMdd_HHmmss"); Rename-Item -Path $prof -NewName (Split-Path $stary -Leaf); Log "Profil programu przeniesiony na bok (nie skasowany): $stary" }
$T0 = Get-Date
Log ("START " + $T0.ToString("o"))

function Etap($nazwa, $json, $only, $images) {
  $dir = Join-Path $wyn $nazwa
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $zr = Join-Path $dir "zrzuty"; $pk = Join-Path $dir "paczka"
  $s = Get-Date
  $a = @("zrzuty.mjs", $json, $zr, "--channel", "msedge", "--only", $only)
  if ($images -ne "") { $a += @("--images", $images) }
  node @a 2>&1 | ForEach-Object { Log $_.ToString() }
  $c1 = $LASTEXITCODE
  $tZ = [math]::Round(((Get-Date) - $s).TotalSeconds, 1)
  $s = Get-Date
  node zloz_paczke.mjs $json $zr $pk $only 2>&1 | ForEach-Object { Log $_.ToString() }
  $c2 = $LASTEXITCODE
  $tS = [math]::Round(((Get-Date) - $s).TotalSeconds, 1)
  $pr = Join-Path $zr "przebieg.json"
  if (Test-Path $pr) { $p = Get-Content $pr -Raw | ConvertFrom-Json; Log ("ETAP ${nazwa}: zrzuty=$tZ s; skladanie=$tS s; kod_zrzutow=$c1; kod_skladania=$c2; zdjec_ok=" + $p.zdjec_ok + "/" + $p.zdjec + "; INTERWENCJE_UZYTKOWNIKA=" + $p.interwencje_uzytkownika + "; ekrany_zgody=" + $p.ekrany_zgody_napotkane + "; zgoda_odrzucona_auto=" + $p.zgoda_odrzucona_automatycznie + "; ponowienia=" + $p.ponowienia + "; uruchomienia_przegladarki=" + $p.uruchomienia_przegladarki + "; odtworzenia_sesji=" + $p.odtworzenia_sesji) }
  else { Log "ETAP ${nazwa}: zrzuty=$tZ s; skladanie=$tS s; kod_zrzutow=$c1; kod_skladania=$c2 (brak przebieg.json)" }
  Log ("   paczka: $pk")
}

# A) dwa przyklady: zdjecie 1 (plakat) i 4 (osoba na kanapie) z 3vCANkZ_hAU, z juz zapisanych danych (bez Gemini/Supadata)
$src = Join-Path $wyn "paczka_3vCANkZ_hAU\paczka_3vCANkZ_hAU_json.json"
$dA = Join-Path $wyn "kontekst_przyklady"; New-Item -ItemType Directory -Force -Path $dA | Out-Null
$jA = Join-Path $dA "kontekst_przyklady_json.json"
if (Test-Path $src) { Copy-Item $src $jA -Force; Etap "kontekst_przyklady" $jA "3vCANkZ_hAU" "1,4" } else { Log "A) pominiete: brak $src" }

# B) 5 rolek: pobranie eksportu (z Gemini) i zrzuty
$sB = Get-Date
& (Join-Path $root "pobierz_zestaw.ps1") -Manifest $Manifest -Nazwa $Nazwa 2>&1 | ForEach-Object { Log $_.ToString() }
Log ("CZAS pobranie_eksportu_s: " + [math]::Round(((Get-Date) - $sB).TotalSeconds, 1))
$jB = Join-Path $wyn "$Nazwa\${Nazwa}_json.json"
if (-not (Test-Path $jB)) { Log "BLAD: brak $jB - przerywam"; exit 1 }
Etap $Nazwa $jB $Tylko ""

# C) powtorka na tym samym profilu (osobny folder wynikow, wiec nic nie jest pomijane): zgoda/cookies maja byc zapamietane
$nC = $Nazwa + "_powtorka"; $dC = Join-Path $wyn $nC; New-Item -ItemType Directory -Force -Path $dC | Out-Null
$jC = Join-Path $dC "${nC}_json.json"; Copy-Item $jB $jC -Force
Etap $nC $jC $Tylko ""

Log ("KONIEC " + (Get-Date).ToString("o") + "; czas calosci: " + [math]::Round(((Get-Date) - $T0).TotalSeconds, 1) + " s")
Log "Odeslij mi koniec tego logu (linie ETAP / CZAS / KONIEC) albo napisz 'gotowe' - sprawdze obrazy z dysku."
