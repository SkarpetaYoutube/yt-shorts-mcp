# Etap 2: sekrety trafiaja WYLACZNIE do Cloudflare Secrets. Wpisujesz je tutaj, w terminalu (ukryte), nie w rozmowie.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
function PutSecret($name, $value) {
  $value | npx wrangler secret put $name | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Nie udalo sie ustawic $name" }
  Write-Host "ustawiono $name"
}
function Ask($prompt) {
  $s = Read-Host -AsSecureString $prompt
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { $v = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
  $v = $v.Trim()
  if ($v.Length -lt 16 -or $v -match '[\x00-\x1f]') { throw "Wartosc odrzucona (dlugosc $($v.Length), znaki sterujace?). Ctrl+V tu nie dziala: wklej PRAWYM PRZYCISKIEM MYSZY albo Shift+Insert." }
  Write-Host "  przyjeto wartosc o dlugosci $($v.Length) znakow"
  return $v
}
$login = Read-Host "Twoj login GitHub (jedyne konto z dostepem)"
PutSecret "ALLOWED_GITHUB_USERS" $login
$bytes = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
PutSecret "SIGNING_KEY" ([Convert]::ToBase64String($bytes))
PutSecret "GITHUB_CLIENT_ID" (Ask "GitHub OAuth Client ID")
PutSecret "GITHUB_CLIENT_SECRET" (Ask "GitHub OAuth Client Secret")
PutSecret "YOUTUBE_API_KEY" (Ask "Klucz YouTube Data API v3")
PutSecret "SUPADATA_API_KEY" (Ask "Klucz Supadata")
Write-Host "GOTOWE - sekrety ustawione. Napisz do Claude: sekrety gotowe."
