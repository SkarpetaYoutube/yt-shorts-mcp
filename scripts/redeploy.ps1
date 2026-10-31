# Wdraza Workera i zapisuje caly wynik do deploy_log.txt (Claude odczytuje ten plik).
$ROOT = if (Test-Path (Join-Path $PSScriptRoot "wrangler.jsonc")) { $PSScriptRoot } else { Split-Path $PSScriptRoot -Parent }
Set-Location $ROOT
$log = Join-Path $ROOT "deploy_log.txt"
function Log($t) { Write-Host $t; Add-Content -Path $log -Value $t -Encoding UTF8 }
Set-Content -Path $log -Value "" -Encoding UTF8
Log ("START: " + (Get-Date -Format o))
Log ("FOLDER: " + $ROOT)
foreach ($f in "src\store.ts","src\mcp.ts","src\vision.ts","wrangler.jsonc") { $i = Get-Item $f; Log ("PLIK: $f " + $i.Length + " B, zapis " + $i.LastWriteTime.ToString("o")) }
$out = npx wrangler deploy 2>&1 | ForEach-Object { $_.ToString() }
$code = $LASTEXITCODE
foreach ($l in $out) { Log $l }
Log ("KOD ZAKONCZENIA wrangler deploy: " + $code)
Start-Sleep -Seconds 5
try { $h = Invoke-RestMethod "https://yt-mcp.comando-yt-2026.workers.dev/health" -TimeoutSec 30; Log ("HEALTH: " + ($h | ConvertTo-Json -Compress)) } catch { Log ("HEALTH BLAD: " + $_) }
Log ("KONIEC: " + (Get-Date -Format o))
