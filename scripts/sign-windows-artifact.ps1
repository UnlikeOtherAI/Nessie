param(
  [Parameter(Mandatory = $true)]
  [string]$FilePath
)

$ErrorActionPreference = 'Stop'

foreach ($name in @(
  'NESSIE_ARTIFACT_SIGNING_ENDPOINT',
  'NESSIE_ARTIFACT_SIGNING_ACCOUNT',
  'NESSIE_ARTIFACT_SIGNING_PROFILE'
)) {
  if (-not (Get-Item -Path "Env:$name" -ErrorAction SilentlyContinue).Value) {
    throw "$name is required for Windows Artifact Signing."
  }
}

$resolvedFile = (Resolve-Path -LiteralPath $FilePath).Path
$clientToolsRoot = Join-Path ${env:ProgramFiles(x86)} 'Microsoft\ArtifactSigningClientTools'
$dlib = Get-ChildItem -LiteralPath $clientToolsRoot -Filter 'Azure.CodeSigning.Dlib.dll' `
  -File -Recurse |
  Sort-Object @{ Expression = { $_.FullName -match '[\\/]x64[\\/]' }; Descending = $true }, `
    FullName -Descending |
  Select-Object -First 1
if (-not $dlib) {
  throw "Azure.CodeSigning.Dlib.dll was not found below $clientToolsRoot."
}

$signToolRoots = @(
  $clientToolsRoot,
  (Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin')
)
$signTool = @(
  foreach ($root in $signToolRoots) {
    if (Test-Path -LiteralPath $root) {
      Get-ChildItem -LiteralPath $root -Filter 'signtool.exe' -File -Recurse |
        Where-Object { $_.FullName -match '[\\/]x64[\\/]' }
    }
  }
) | Sort-Object FullName -Descending | Select-Object -First 1
if (-not $signTool) {
  throw 'A compatible x64 signtool.exe was not found.'
}

$metadataPath = Join-Path $env:RUNNER_TEMP "nessie-artifact-signing-$PID.json"
$metadata = @{
  Endpoint = $env:NESSIE_ARTIFACT_SIGNING_ENDPOINT
  CodeSigningAccountName = $env:NESSIE_ARTIFACT_SIGNING_ACCOUNT
  CertificateProfileName = $env:NESSIE_ARTIFACT_SIGNING_PROFILE
  CorrelationId = $env:GITHUB_RUN_ID
} | ConvertTo-Json

try {
  Set-Content -LiteralPath $metadataPath -Value $metadata -Encoding utf8NoBOM
  & $signTool.FullName sign /v /debug /fd SHA256 `
    /tr 'http://timestamp.acs.microsoft.com' /td SHA256 `
    /dlib $dlib.FullName /dmdf $metadataPath $resolvedFile
  if ($LASTEXITCODE -ne 0) {
    throw "Artifact Signing failed for $resolvedFile with exit code $LASTEXITCODE."
  }
} finally {
  Remove-Item -LiteralPath $metadataPath -Force -ErrorAction SilentlyContinue
}
