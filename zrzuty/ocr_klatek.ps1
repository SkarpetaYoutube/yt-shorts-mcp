# Rozpoznawanie tekstu (OCR) na zapisanych klatkach rozmowy: wbudowany OCR Windows (bez instalowania czegokolwiek, offline).
# Użycie (Windows PowerShell 5.1):  powershell -NoProfile -ExecutionPolicy Bypass -File .\ocr_klatek.ps1 -Lista <pliki.json> -Wyjscie <wynik.json> [-Jezyk en-US]
#   pliki.json: tablica ścieżek do PNG; wynik.json: [{ file, text, lines: [...] }] albo { error } gdy OCR niedostępny.
param([Parameter(Mandatory = $true)][string]$Lista, [Parameter(Mandatory = $true)][string]$Wyjscie, [string]$Jezyk = "en-US")
$ErrorActionPreference = "Stop"
function Zapisz($o) { [System.IO.File]::WriteAllText($Wyjscie, ($o | ConvertTo-Json -Depth 6 -Compress), (New-Object System.Text.UTF8Encoding $false)) }
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  [void][Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
  [void][Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  [void][Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq "IAsyncOperation``1" })[0]
  function Await($op, $type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); [void]$t.Wait(-1); $t.Result }
  $engine = $null
  try { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language($Jezyk))) } catch { }
  if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
  if (-not $engine) { Zapisz @{ error = "OCR Windows niedostepny (brak pakietu jezykowego OCR)" }; exit 3 }
  $out = @()
  foreach ($p in (Get-Content $Lista -Raw -Encoding UTF8 | ConvertFrom-Json)) {
    try {
      $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync((Resolve-Path $p).Path)) ([Windows.Storage.StorageFile])
      $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
      $dec = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
      $bmp = Await ($dec.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
      $res = Await ($engine.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])
      $out += [pscustomobject]@{ file = $p; language = $engine.RecognizerLanguage.LanguageTag; text = $res.Text; lines = @($res.Lines | ForEach-Object { $_.Text }) }
    } catch { $ex = $_.Exception; while ($ex.InnerException) { $ex = $ex.InnerException }; $out += [pscustomobject]@{ file = $p; error = $ex.Message } }
  }
  Zapisz @($out)
} catch { Zapisz @{ error = $_.Exception.Message }; exit 3 }
