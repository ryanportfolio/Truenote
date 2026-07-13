[CmdletBinding(PositionalBinding = $false)]
param(
  [switch]$PrintPath,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Arguments
)

$ErrorActionPreference = "Stop"

function Test-PythonInterpreter {
  param([Parameter(Mandatory = $true)][string]$Path)

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return $false
  }

  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $Path
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.ArgumentList.Add("--version")

  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $startInfo

  try {
    if (-not $process.Start()) {
      return $false
    }
    if (-not $process.WaitForExit(3000)) {
      $process.Kill($true)
      return $false
    }
    return $process.ExitCode -eq 0
  } catch {
    return $false
  } finally {
    $process.Dispose()
  }
}

$candidates = [System.Collections.Generic.List[string]]::new()

if ($env:CODEX_PYTHON) {
  $candidates.Add($env:CODEX_PYTHON)
}

$uvPythonRoot = Join-Path $env:APPDATA "uv\python"
if (Test-Path -LiteralPath $uvPythonRoot) {
  Get-ChildItem -Path (Join-Path $uvPythonRoot "cpython-*\python.exe") -File -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending |
    ForEach-Object { $candidates.Add($_.FullName) }
}

Get-Command python.exe -All -ErrorAction SilentlyContinue |
  Where-Object { $_.Source -notlike "*\WindowsApps\python.exe" } |
  ForEach-Object { $candidates.Add($_.Source) }

$localPythonRoot = Join-Path $env:LOCALAPPDATA "Programs\Python"
if (Test-Path -LiteralPath $localPythonRoot) {
  Get-ChildItem -Path (Join-Path $localPythonRoot "Python*\python.exe") -File -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending |
    ForEach-Object { $candidates.Add($_.FullName) }
}

$python = $candidates |
  Select-Object -Unique |
  Where-Object { Test-PythonInterpreter $_ } |
  Select-Object -First 1

if (-not $python) {
  throw "No working Python interpreter found. Set CODEX_PYTHON to a valid python.exe path."
}

if ($PrintPath) {
  Write-Output $python
  return
}

if (-not $Arguments -or $Arguments.Count -eq 0) {
  throw "Usage: .claude\scripts\run-python.ps1 <script-or-python-arguments>"
}

& $python @Arguments
exit $LASTEXITCODE
