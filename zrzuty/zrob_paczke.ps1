# JEDNA KOMENDA: zrzuty zdjęć (YouTube albo lokalne MP4) + składanie paczki. Używa już pobranego JSON (nic nie pobiera, nie woła Gemini/Supadata).
# Użycie: .\zrzuty\zrob_paczke.ps1 -Nazwa paczka_3vCANkZ_hAU -Tylko 3vCANkZ_hAU [-Manifest "<link>" (tylko gdy JSON nie jest pobrany)] [-Lokalne "C:\mp4"]
param(
  [Parameter(Mandatory = $true)][string]$Nazwa,
  [string]$Manifest = "",
  [string]$Lokalne = "",
  [string[]]$Tylko = @()
)
$ErrorActionPreference = "Continue"
$TylkoStr = ($Tylko -join ",").Trim(",")
$root = Split-Path $PSScriptRoot -Parent
$safe = ($Nazwa -replace '[^\w\-]', '_')
$dir = Join-Path $root (Join-Path "wyniki" $safe)
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$log = Join-Path $dir "paczka_log.txt"
function Log($t) { Write-Host $t; Add-Content -Path $log -Value $t -Encoding UTF8 }
Set-Content -Path $log -Value "" -Encoding UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$t0 = Get-Date
Log ("START " + $t0.ToString("o"))
$json = Join-Path $dir ($safe + "_json.json")
if (-not (Test-Path $json)) {
  if ($Manifest -eq "") { Log "BLAD: brak $json i nie podano -Manifest"; exit 1 }
  & (Join-Path $root "pobierz_zestaw.ps1") -Manifest $Manifest -Nazwa $safe 2>&1 | ForEach-Object { Log $_.ToString() }
} else { Log "Uzywam juz pobranego JSON: $json (bez pobierania)" }
Set-Location $PSScriptRoot
if (-not (Test-Path (Join-Path $PSScriptRoot "node_modules\playwright"))) { Log "npm install (jednorazowo)"; npm install 2>&1 | ForEach-Object { Log $_.ToString() } }
$zr = Join-Path $dir "zrzuty"
$a = @("zrzuty.mjs", $json, $zr, "--channel", "msedge")
if ($Lokalne -ne "") { $a += @("--local", $Lokalne) }
if ($TylkoStr -ne "") { $a += @("--only", $TylkoStr) }
node @a 2>&1 | ForEach-Object { Log $_.ToString() }
$c1 = $LASTEXITCODE
$pk = Join-Path $dir "paczka"
$b = @("zloz_paczke.mjs", $json, $zr, $pk)
if ($TylkoStr -ne "") { $b += $TylkoStr }
node @b 2>&1 | ForEach-Object { Log $_.ToString() }
$c2 = $LASTEXITCODE
Log ("KONIEC " + (Get-Date).ToString("o") + "  czas: " + [int]((Get-Date) - $t0).TotalSeconds + " s; kod zrzutow: $c1, kod skladania: $c2")
if ($c1 -ne 0 -or $c2 -ne 0) { $w = if ($c1 -eq 1 -or $c2 -eq 1) { "NIEPOWODZENIE (0 poprawnych obrazow)" } else { "NIEPELNA (nie wszystkie zdjecia maja screen i wycinek)" }; Log "WYNIK: $w - szczegoly: $zr\diagnostyka.log i $pk\paczka.md"; exit 1 }
Log ("WYNIK: KOMPLET (wszystkie screeny i wycinki sprawdzone)  PACZKA: " + $pk)
Start-Process explorer.exe $pk
