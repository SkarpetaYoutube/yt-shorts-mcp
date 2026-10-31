# Podlacza klucz Gemini do serwera i wdraza nowa wersje (v2.2 + rozpoznawanie zdjec).
# Klucz wpisujesz tylko tutaj (wpis ukryty przez wrangler); trafia jako sekret do Cloudflare, nie do plikow ani logow.
$ErrorActionPreference = "Stop"
$ROOT = if (Test-Path (Join-Path $PSScriptRoot "wrangler.jsonc")) { $PSScriptRoot } else { Split-Path $PSScriptRoot -Parent }
Set-Location $ROOT
Write-Host "1/2  Wklej klucz Gemini API i nacisnij Enter (wpis jest ukryty)." -ForegroundColor Cyan
npx wrangler secret put GEMINI_API_KEY
if ($LASTEXITCODE -ne 0) { throw "Nie udalo sie zapisac sekretu GEMINI_API_KEY." }
Write-Host "2/2  Wdrazam nowa wersje serwera..." -ForegroundColor Cyan
npx wrangler deploy
if ($LASTEXITCODE -ne 0) { throw "Wdrozenie nie powiodlo sie." }
Write-Host "Gotowe. Napisz w rozmowie: gotowe" -ForegroundColor Green
