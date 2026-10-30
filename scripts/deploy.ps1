# Etap 1: instalacja, logowanie, KV, wdrozenie. Nic platnego: plan Free, tylko Worker + Durable Object (SQLite) + KV.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
function Need($c) { if (-not (Get-Command $c -ErrorAction SilentlyContinue)) { throw "Brak '$c'. Zainstaluj Node.js LTS ze strony nodejs.org i uruchom skrypt ponownie." } }
Need node; Need npm
Write-Host "== 1/5 npm install"; npm install --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw "npm install nie powiodl sie" }
Write-Host "== 2/5 Logowanie do Cloudflare (otworzy sie przegladarka - zatwierdz dostep)"
npx wrangler login
Write-Host "== 3/5 Konto:"; npx wrangler whoami
$cfg = Get-Content wrangler.jsonc -Raw
if ($cfg -match "REPLACE_WITH_KV_NAMESPACE_ID") {
  Write-Host "== 4/5 Tworze przestrzen KV (plan Free)"
  $out = (npx wrangler kv namespace create OAUTH_KV 2>&1 | Out-String)
  if ($out -notmatch '"id":\s*"([0-9a-f]{32})"' -and $out -notmatch 'id\s*=\s*"([0-9a-f]{32})"') { Write-Host $out; throw "Nie znaleziono id przestrzeni KV w wyniku" }
  $id = $Matches[1]
  $cfg = $cfg.Replace("REPLACE_WITH_KV_NAMESPACE_ID", $id)
  [System.IO.File]::WriteAllText((Join-Path $PSScriptRoot "wrangler.jsonc"), $cfg, (New-Object System.Text.UTF8Encoding $false))
  Write-Host "KV id zapisane w wrangler.jsonc"
} else { Write-Host "== 4/5 KV juz skonfigurowane" }
Write-Host "== 5/5 Wdrazam Workera (jesli zapyta o subdomene workers.dev, wybierz nazwe - to darmowe)"
npx wrangler deploy
Write-Host ""
Write-Host "GOTOWE. Skopiuj adres https://...workers.dev z wyniku powyzej i napisz go do Claude (to adres publiczny, nie sekret)."
