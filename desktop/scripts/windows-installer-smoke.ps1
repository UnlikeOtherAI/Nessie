[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $InstallerPath -PathType Leaf)) {
  throw "the desktop installer was not found at $InstallerPath"
}

$installResult = Start-Process -FilePath $InstallerPath -ArgumentList '/S' -Wait -PassThru
if ($installResult.ExitCode -ne 0) {
  throw "the desktop installer failed with code $($installResult.ExitCode)"
}

# The sign-in callback returns through nessie://, so the scheme has to be
# registered for the installing user.
if (-not (Test-Path 'HKCU:\Software\Classes\nessie')) {
  throw 'the nessie:// scheme was not registered'
}

$install = Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' |
  ForEach-Object { Get-ItemProperty $_.PSPath } |
  Where-Object { $_.DisplayName -eq 'Nessie' } |
  Select-Object -First 1
if (-not $install) {
  throw 'the Nessie uninstall registration was not found'
}

$installRoot = $install.InstallLocation.Trim('"')
$appPath = Join-Path $installRoot 'nessie-desktop.exe'
if (-not (Test-Path -LiteralPath $appPath)) {
  throw "the installed nessie-desktop.exe was not found at $appPath"
}

$app = Get-Item -LiteralPath $appPath
# No console: the PE subsystem must be GUI (2). A console subsystem binary
# flashes a terminal at every launch, which is the defect this asserts against.
$bytes = [System.IO.File]::ReadAllBytes($app.FullName)
$peOffset = [BitConverter]::ToInt32($bytes, 0x3C)
$subsystem = [BitConverter]::ToUInt16($bytes, $peOffset + 0x5C)
if ($subsystem -ne 2) {
  throw "nessie-desktop.exe is not a GUI subsystem binary (got $subsystem)"
}

$process = Start-Process -FilePath $app.FullName -PassThru
try {
  Start-Sleep -Seconds 10
  $running = Get-Process -Id $process.Id -ErrorAction SilentlyContinue
  if (-not $running) {
    throw 'Nessie exited within ten seconds'
  }
  $running.Refresh()
  if ($running.MainWindowTitle -ne 'Nessie') {
    throw "expected a window titled Nessie, found '$($running.MainWindowTitle)'"
  }
} finally {
  $running = Get-Process -Id $process.Id -ErrorAction SilentlyContinue
  if ($running) {
    Stop-Process -Id $process.Id -Force
  }
}

$uninstallResult = Start-Process -FilePath $install.UninstallString.Trim('"') -ArgumentList '/S' -Wait -PassThru
if ($uninstallResult.ExitCode -ne 0) {
  throw "the desktop uninstaller failed with code $($uninstallResult.ExitCode)"
}

Start-Sleep -Seconds 5
if (Test-Path -LiteralPath $app.FullName) {
  throw 'the desktop app was not uninstalled'
}
