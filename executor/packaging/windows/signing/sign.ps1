# Signs Windows release files as Nessie's Azure Artifact Signing publisher.
#
# This is the one signing command every Windows release file goes through:
# Tauri's `bundle.windows.signCommand`, the `NESSIE_WINDOWS_SIGN_COMMAND`
# contract in `executor/scripts/windows-sign.mjs` (`%1` is the file), and the
# workflow's MSI step all call it with a single path. Who signs — the endpoint,
# account, certificate profile, subject and profile EKU — is `publisher.json`
# beside this script, so a reviewer reads the identity rather than a secret.
#
#   sign.ps1 -Prepare   once per job, before anything is built: installs the
#                       pinned Artifact Signing client, signs a throwaway probe
#                       to prove authentication, role and profile EKU end to end,
#                       and exports NESSIE_WINDOWS_SIGN_COMMAND and
#                       NESSIE_WINDOWS_PUBLISHER_EKU to later GitHub steps.
#   sign.ps1 <file>     signs one file, then refuses unless its signature is
#                       valid, timestamped and carries the profile EKU.
#
# Authentication is keyless. In GitHub Actions each call mints a fresh GitHub
# OIDC token and hands it to the client's workload-identity credential, which
# exchanges it for the `nessie-github-signing` managed identity; nothing is
# stored and no token outlives one signature. Anywhere else it is the Azure CLI
# login of a person holding the Certificate Profile Signer role.
[CmdletBinding(DefaultParameterSetName = 'Sign')]
param(
  [Parameter(Mandatory = $true, Position = 0, ParameterSetName = 'Sign')]
  [string]$Path,
  [Parameter(Mandatory = $true, ParameterSetName = 'Prepare')]
  [switch]$Prepare
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$publisher = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'publisher.json') -Raw |
  ConvertFrom-Json
$clientHome = if ($env:NESSIE_ARTIFACT_SIGNING_HOME) {
  $env:NESSIE_ARTIFACT_SIGNING_HOME
} else {
  Join-Path $env:LOCALAPPDATA 'Nessie\artifact-signing'
}
$clientRoot = Join-Path $clientHome "$($publisher.client.package).$($publisher.client.version)"
$dlib = Join-Path $clientRoot 'bin\x64\Azure.CodeSigning.Dlib.dll'
$inGitHubActions = $env:GITHUB_ACTIONS -eq 'true'

# The client library loads inside SignTool, and SignTool builds older than
# 10.0.22621.755 cannot host it; the Windows SDK folders carry every installed
# version side by side.
function Resolve-SignTool {
  $kits = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
  $tools = Get-ChildItem -LiteralPath $kits -Directory -Filter '10.*' -ErrorAction SilentlyContinue |
    ForEach-Object { Join-Path $_.FullName 'x64\signtool.exe' } |
    Where-Object { Test-Path -LiteralPath $_ } |
    Sort-Object { [version](Get-Item -LiteralPath $_).VersionInfo.FileVersionRaw } -Descending
  $newest = $tools | Select-Object -First 1
  if (-not $newest -or (Get-Item -LiteralPath $newest).VersionInfo.FileVersionRaw -lt [version]'10.0.22621.755') {
    throw 'Artifact Signing needs the x64 SignTool from Windows SDK 10.0.22621.755 or newer.'
  }
  $newest
}

# The package is fetched by exact version and refused unless its digest is the
# one publisher.json pins, so a changed upload can never sign a release.
function Install-Client {
  if (Test-Path -LiteralPath $dlib) { return }
  $id = $publisher.client.package.ToLowerInvariant()
  $version = $publisher.client.version
  $download = Join-Path ([IO.Path]::GetTempPath()) "$id.$version.$PID.zip"
  try {
    Invoke-WebRequest -Uri "https://api.nuget.org/v3-flatcontainer/$id/$version/$id.$version.nupkg" `
      -OutFile $download
    $digest = (Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($digest -ne $publisher.client.sha256) {
      throw "$($publisher.client.package) $version has SHA-256 $digest, not the pinned $($publisher.client.sha256)."
    }
    $staging = "$clientRoot.partial"
    Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
    Expand-Archive -LiteralPath $download -DestinationPath $staging
    Move-Item -LiteralPath $staging -Destination $clientRoot
  } finally {
    Remove-Item -LiteralPath $download -Force -ErrorAction SilentlyContinue
  }
}

# The client is a .NET 8 library that rolls forward to any newer major.
function Assert-DotNetRuntime {
  $runtimes = & dotnet --list-runtimes 2>$null
  $supported = @($runtimes | Where-Object { $_ -match '^Microsoft\.NETCore\.App (\d+)\.' -and [int]$Matches[1] -ge 8 })
  if ($supported.Count -eq 0) {
    throw 'Artifact Signing needs the .NET 8 (or newer) runtime, which SignTool loads the client into.'
  }
}

# Every credential the client would otherwise try in turn, minus the one this
# host actually uses, so a failure names the real cause instead of the last
# thing the chain tried.
function Get-ExcludedCredentials {
  $all = @(
    'ManagedIdentityCredential', 'WorkloadIdentityCredential', 'SharedTokenCacheCredential',
    'VisualStudioCredential', 'VisualStudioCodeCredential', 'AzureCliCredential',
    'AzurePowerShellCredential', 'AzureDeveloperCliCredential', 'InteractiveBrowserCredential'
  )
  $used = if ($inGitHubActions) { 'WorkloadIdentityCredential' } else { 'AzureCliCredential' }
  @($all | Where-Object { $_ -ne $used })
}

# A GitHub OIDC token lives about five minutes, so one is minted per signature
# rather than once per job; a forty-minute build would otherwise outlive it.
function Use-GitHubFederatedToken([string]$Directory) {
  if (-not $env:ACTIONS_ID_TOKEN_REQUEST_URL -or -not $env:ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    throw 'Signing in GitHub Actions needs `permissions: id-token: write` and the windows-signing environment.'
  }
  foreach ($name in 'AZURE_CLIENT_ID', 'AZURE_TENANT_ID') {
    if (-not [Environment]::GetEnvironmentVariable($name)) {
      throw "$name must name the nessie-github-signing identity (a windows-signing environment variable)."
    }
  }
  $audience = [uri]::EscapeDataString('api://AzureADTokenExchange')
  $response = Invoke-RestMethod -Uri "$($env:ACTIONS_ID_TOKEN_REQUEST_URL)&audience=$audience" `
    -Headers @{ Authorization = "Bearer $($env:ACTIONS_ID_TOKEN_REQUEST_TOKEN)" }
  $tokenFile = Join-Path $Directory 'github-oidc.jwt'
  Set-Content -LiteralPath $tokenFile -Value $response.value -NoNewline -Encoding ascii
  $env:AZURE_FEDERATED_TOKEN_FILE = $tokenFile
}

function Assert-Signature([string]$File) {
  $signature = Get-AuthenticodeSignature -LiteralPath $File
  $name = [IO.Path]::GetFileName($File)
  if ($signature.Status -ne 'Valid') {
    throw "$name has signature status $($signature.Status): $($signature.StatusMessage)"
  }
  $certificate = $signature.SignerCertificate
  if ($certificate.Subject -ne $publisher.subject) {
    throw "$name is signed by '$($certificate.Subject)', not '$($publisher.subject)'."
  }
  $usages = @(
    $certificate.Extensions |
      Where-Object { $_ -is [System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension] } |
      ForEach-Object { $_.EnhancedKeyUsages } |
      ForEach-Object { $_.Value }
  )
  if ($usages -notcontains $publisher.profileEku) {
    throw ("$name does not carry the $($publisher.certificateProfile) profile EKU $($publisher.profileEku) " +
      "(it carries $($usages -join ', ')). A recreated certificate profile gets a new EKU; " +
      'publisher.json and every pinned build must follow it.')
  }
  # The certificate is valid for 72 hours; only the countersignature keeps the
  # signature valid after that.
  if (-not $signature.TimeStamperCertificate) {
    throw "$name carries no timestamp countersignature."
  }
  Write-Host ("signed {0}: {1}, certificate {2} valid until {3:u}" -f
    $name, $certificate.Subject, $certificate.Thumbprint, $certificate.NotAfter.ToUniversalTime())
}

function Invoke-Signing([string]$File) {
  if (-not (Test-Path -LiteralPath $File -PathType Leaf)) {
    throw "There is no file to sign at $File."
  }
  if (-not (Test-Path -LiteralPath $dlib)) {
    throw "The Artifact Signing client is not installed at $clientRoot; run sign.ps1 -Prepare first."
  }
  $signtool = Resolve-SignTool
  $work = Join-Path ([IO.Path]::GetTempPath()) "nessie-sign-$([guid]::NewGuid().ToString('n'))"
  New-Item -ItemType Directory -Path $work | Out-Null
  try {
    $correlation = if ($inGitHubActions) {
      "$($env:GITHUB_REPOSITORY)/actions/runs/$($env:GITHUB_RUN_ID)/attempts/$($env:GITHUB_RUN_ATTEMPT)"
    } else {
      "local/$($env:COMPUTERNAME)"
    }
    $metadata = Join-Path $work 'metadata.json'
    @{
      Endpoint = $publisher.endpoint
      CodeSigningAccountName = $publisher.account
      CertificateProfileName = $publisher.certificateProfile
      CorrelationId = $correlation
      ExcludeCredentials = Get-ExcludedCredentials
    } | ConvertTo-Json | Set-Content -LiteralPath $metadata -Encoding utf8

    # The signing service and the timestamp authority are both remote; a
    # throttled or dropped request is retried, a refused one is not hidden.
    for ($attempt = 1; ; $attempt++) {
      if ($inGitHubActions) { Use-GitHubFederatedToken $work }
      & $signtool sign /v /fd SHA256 /tr $publisher.timestampUrl /td SHA256 `
        /dlib $dlib /dmdf $metadata $File
      if ($LASTEXITCODE -eq 0) { break }
      if ($attempt -ge 3) {
        throw "SignTool could not sign $([IO.Path]::GetFileName($File)) (exit code $LASTEXITCODE)."
      }
      Start-Sleep -Seconds (15 * $attempt)
    }
  } finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
  }
  Assert-Signature $File
}

if ($Prepare) {
  Assert-DotNetRuntime
  Resolve-SignTool | Out-Null
  Install-Client
  # A throwaway script, signed and verified exactly like a release file, so a
  # missing role, a wrong endpoint or a recreated profile fails here rather
  # than twenty minutes into a build.
  $probe = Join-Path ([IO.Path]::GetTempPath()) "nessie-signing-probe-$PID.ps1"
  Set-Content -LiteralPath $probe -Value '# Nessie release signing probe' -Encoding utf8
  try {
    Invoke-Signing $probe
  } finally {
    Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
  }
  $command = "pwsh -NoLogo -NoProfile -NonInteractive -File `"$PSCommandPath`" %1"
  if ($env:GITHUB_ENV) {
    "NESSIE_WINDOWS_SIGN_COMMAND=$command" | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8
    "NESSIE_WINDOWS_PUBLISHER_EKU=$($publisher.profileEku)" |
      Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8
  } else {
    Write-Host 'Signing works. Set these before building:'
    Write-Host "`$env:NESSIE_WINDOWS_SIGN_COMMAND = '$command'"
    Write-Host "`$env:NESSIE_WINDOWS_PUBLISHER_EKU = '$($publisher.profileEku)'"
  }
  return
}

Invoke-Signing (Resolve-Path -LiteralPath $Path).ProviderPath
