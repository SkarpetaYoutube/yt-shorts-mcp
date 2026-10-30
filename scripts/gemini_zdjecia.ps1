# Proba Gemini API (darmowy poziom): zdjecia w rolce z publicznego linku YouTube, bez pobierania wideo.
# Uzycie:  .\gemini_zdjecia.ps1 -Url "https://www.youtube.com/shorts/VbJLBRLiu_U"
# Klucz: zmienna $env:GEMINI_API_KEY albo wpis przy uruchomieniu (ukryty). Klucz NIE jest zapisywany w wynikach ani logach.
# Dla kazdej wartosci fps zapisuje wyniki\gemini\<ID>_fps<N>.json: model, parametry, czas, status HTTP,
# surowa odpowiedz API (albo rzeczywisty blad) i zuzycie tokenow; oraz <ID>_fps<N>.txt z samym tekstem odpowiedzi.
param(
  [Parameter(Mandatory = $true)][string]$Url,
  [double[]]$Fps = @(1, 5),
  [string]$Model = "gemini-3.8-flash"
)
$ErrorActionPreference = "Stop"
$m = [regex]::Match($Url, '(?:shorts/|v=|youtu\.be/)([A-Za-z0-9_-]{11})')
if (-not $m.Success) { throw "Nie rozpoznaje ID filmu w linku." }
$id = $m.Groups[1].Value
$watch = "https://www.youtube.com/watch?v=$id"

$key = $env:GEMINI_API_KEY
if (-not $key) {
  $sec = Read-Host -AsSecureString "Wklej klucz Gemini API (nie bedzie widoczny ani zapisany)"
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
  try { $key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}
if (-not $key) { throw "Brak klucza." }

$prompt = [IO.File]::ReadAllText((Join-Path $PSScriptRoot "gemini_prompt.txt"), [Text.Encoding]::UTF8)
$outDir = Join-Path $PSScriptRoot "wyniki\gemini"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$endpoint = "https://generativelanguage.googleapis.com/v1beta/models/$($Model):generateContent"

foreach ($f in $Fps) {
  $tag = ("fps" + $f) -replace '[\.,]', '_'
  Write-Host "Wysylam $id ($tag, model $Model)..."
  $params = @{ fps = $f; responseMimeType = "application/json"; endpoint = "generateContent"; video = $watch }
  $body = @{
    contents = @(@{
      parts = @(
        @{ fileData = @{ fileUri = $watch }; videoMetadata = @{ fps = $f } },
        @{ text = $prompt }
      )
    })
    generationConfig = @{ responseMimeType = "application/json" }
  } | ConvertTo-Json -Depth 10
  $bytes = [Text.Encoding]::UTF8.GetBytes($body)
  $start = Get-Date
  $status = 0
  $raw = ""
  try {
    $resp = Invoke-WebRequest -Uri $endpoint -Method Post -Headers @{ "x-goog-api-key" = $key } `
      -ContentType "application/json; charset=utf-8" -Body $bytes -UseBasicParsing -TimeoutSec 600
    $status = [int]$resp.StatusCode
    $raw = [Text.Encoding]::UTF8.GetString($resp.RawContentStream.ToArray())
  } catch {
    if ($_.Exception.Response) {
      $status = [int]$_.Exception.Response.StatusCode
      $sr = New-Object IO.StreamReader($_.Exception.Response.GetResponseStream(), [Text.Encoding]::UTF8)
      $raw = $sr.ReadToEnd()
    } else { $raw = "BLAD POLACZENIA: " + $_.Exception.Message }
  }
  $secs = [math]::Round(((Get-Date) - $start).TotalSeconds, 1)
  $text = ""
  $usage = $null
  $modelVersion = $null
  $parsed = $null
  try { $parsed = $raw | ConvertFrom-Json } catch {}
  if ($parsed) {
    foreach ($c in $parsed.candidates) { foreach ($p in $c.content.parts) { if ($p.text) { $text += $p.text } } }
    $usage = $parsed.usageMetadata
    $modelVersion = $parsed.modelVersion
  }
  $ok = ($status -eq 200 -and $text.Length -gt 0)
  $record = [ordered]@{
    ok = $ok
    http_status = $status
    seconds = $secs
    model_requested = $Model
    model_version = $modelVersion
    params = $params
    usage = $usage
    started_at = $start.ToUniversalTime().ToString("o")
    raw_response = $(if ($parsed) { $parsed } else { $raw })
  }
  $jsonPath = Join-Path $outDir "$id`_$tag.json"
  [IO.File]::WriteAllText($jsonPath, ($record | ConvertTo-Json -Depth 50), [Text.Encoding]::UTF8)
  [IO.File]::WriteAllText((Join-Path $outDir "$id`_$tag.txt"), $text, [Text.Encoding]::UTF8)
  if ($ok) { Write-Host "OK   $tag  ($secs s)  -> $jsonPath" -ForegroundColor Green }
  else { Write-Host "BLAD $tag  HTTP $status (zapisano rzeczywista odpowiedz) -> $jsonPath" -ForegroundColor Red }
  Start-Sleep -Seconds 3
}
$key = $null
Write-Host "Gotowe. Wyniki w $outDir"
