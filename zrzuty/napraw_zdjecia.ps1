# NAPRAWA wybranych zdjec na zapisanych danych: bez Gemini, bez Supadata, bez ponownego przetwarzania poprawnych zdjec.
# Uzywa osobnego, trwalego profilu programu (zgoda cookies zapamietana) - zero klikania. Log: wyniki\napraw_log.txt
param(
  [string]$Nazwa = "test_KiroText_5_powtorka",
  [string]$Redo = "cN_DmOQ6PT4#1,IQJ3ePQ7lkE#1,IQJ3ePQ7lkE#2,rJwcXAKCklE#1,kIjN-ZODqRM#1,ZL2y7X_k2zY#1",
  [string]$Rolki = "cN_DmOQ6PT4,IQJ3ePQ7lkE,ZL2y7X_k2zY,rJwcXAKCklE,kIjN-ZODqRM",
  [string]$Shift = "0.5",
  [string]$Probe = ""
)
$ErrorActionPreference = "Continue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$root = Split-Path $PSScriptRoot -Parent
$wyn = Join-Path $root "wyniki"
$log = Join-Path $wyn ("napraw_log_" + (Get-Date -Format "HHmmss") + ".txt")
function Log($t) { Write-Host $t; Add-Content -Path $log -Value $t -Encoding UTF8 }
Set-Content -Path $log -Value "" -Encoding UTF8
Set-Location $PSScriptRoot
$dir = Join-Path $wyn $Nazwa; $zr = Join-Path $dir "zrzuty"; $pk = Join-Path $dir "paczka"
$json = Join-Path $dir "${Nazwa}_json.json"
if (-not (Test-Path $json)) { Log "BLAD: brak $json"; exit 1 }
$man = Join-Path $zr "frames_manifest.json"
if (Test-Path $man) { Copy-Item $man (Join-Path $zr ("frames_manifest.przed_naprawa_" + (Get-Date -Format "yyyyMMdd_HHmmss") + ".json")) }
$probeArgs = @(); if ($Probe -ne "") { $probeArgs = @("--probe", $Probe) }
$T0 = Get-Date; Log ("START " + $T0.ToString("o") + "; do naprawy: $Redo")
node zrzuty.mjs $json $zr --channel msedge --only $Rolki --redo $Redo --pause 3 --shift $Shift $probeArgs 2>&1 | ForEach-Object { Log $_.ToString() }
$c1 = $LASTEXITCODE; $tZ = [math]::Round(((Get-Date) - $T0).TotalSeconds, 1)
$s = Get-Date
node zloz_paczke.mjs $json $zr $pk $Rolki 2>&1 | ForEach-Object { Log $_.ToString() }
$c2 = $LASTEXITCODE; $tS = [math]::Round(((Get-Date) - $s).TotalSeconds, 1)
Log "ETAP naprawa: zrzuty=$tZ s; skladanie=$tS s; kod_zrzutow=$c1 (0=komplet, 3=kontekst kompletny/wycinki czesciowo); kod_skladania=$c2"
$cnt = node -e "const m=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));const ok=m.filter(e=>e.context_complete).length;console.log('MANIFEST: '+m.length+' wpisow (kontekst kompletny: '+ok+'); '+m.map(e=>e.video_id.slice(0,4)+'#'+e.image_id+'='+(e.status||'?')+'/'+(e.selection||'automatyczny')).join(' '))" $man
Log $cnt
Log "--- STATUSY I CZASY ---"
Get-Content $log | Select-String -Pattern "STATUS |CZAS rolki|DIAGNOSTYKA|KOMPLET|PRZEBIEG" | ForEach-Object { Write-Host $_.Line }
Log ("KONIEC " + (Get-Date).ToString("o") + "; calosc: " + [math]::Round(((Get-Date) - $T0).TotalSeconds, 1) + " s")
Log "Napisz 'gotowe' - sprawdze screeny z dysku."
