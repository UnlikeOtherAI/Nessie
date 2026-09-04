# Publishing direct downloads

Pushing a protected `vMAJOR.MINOR.PATCH` tag at the current `main` commit runs
the **Publish Direct Downloads** workflow. It verifies the source, builds all
downloadable clients from that exact tag, then creates the GitHub Release only
after every platform has passed its release gate.

## Published assets

- `Nessie-macOS-Apple-Silicon.dmg` and `Nessie-macOS-Intel.dmg` — notarized
  direct-download macOS installers.
- `Nessie-Windows-Setup.exe` and `Nessie-Windows.msi` — signed Windows desktop
  installers.
- `Nessie-Linux.AppImage` and `Nessie-Linux.deb` — Linux desktop packages.
- `Nessie-Android.apk` — signed Android internal-distribution build.
- `SHA256SUMS` — SHA-256 digests for every downloadable asset.
- `latest.json` — signed release metadata for desktop update checks and the
  direct Android APK handoff.

The stable asset names deliberately power the homepage URLs under
`/releases/latest/download/`; a new published release automatically becomes
the download without a website change. Mac is two assets because its packaged
Node executor runtime must match the processor architecture.

The landing page opens a Mac download menu at a reliably detected Apple Silicon
or Intel choice, while still exposing both installers. It deliberately shows
both Mac downloads when browser signals are inconclusive.

## Automatic updates

Only direct downloads participate in this mechanism. The direct macOS DMGs,
Windows **NSIS** installer, and Linux **AppImage** compile Tauri's updater with
an immutable GitHub Release endpoint and a compiled public signing key. At
startup, Nessie offers **Update now**, **Skip this version**, or **Remind me
tomorrow**. A skipped or deferred version never suppresses a newer version.
Those choices are stored in the native app-data directory, not the hosted
admin's browser storage, so clearing website data does not reset them.
The updater verifies Tauri's detached signature before it installs anything;
the hosted admin cannot select an update URL.

The Windows MSI and Debian package deliberately remain installer/package-manager
managed, rather than attempting to update an installation they do not own.

The direct Android APK follows the equivalent safe native flow: on startup it
checks `latest.json` by Android `versionCode`, then offers the same three
choices. **Update** opens the official signed APK in Android's package installer,
where Android asks the person to confirm the replacement. It never silently
installs a package. The `device` and `preview` EAS profiles set
`EXPO_PUBLIC_RELEASE_CHANNEL=direct`; the `production` store profile explicitly
sets it to `store`, so Google Play and the App Store alone handle their updates.
The Mac App Store build also omits the `direct-updater` Cargo feature and its
native commands, not merely the popup.

## Required GitHub configuration

The macOS and Android jobs run in the `direct-download-release` environment.
It must require a release-owner approval and allow deployment from the `v*`
tag pattern only. Scope its secrets to maintainers who can cut a release. It
needs:

| Name | Type | Purpose |
| --- | --- | --- |
| `MACOS_DEVELOPER_ID_CERTIFICATE_P12_BASE64` | secret | Developer ID Application certificate and private key, base64 encoded |
| `MACOS_DEVELOPER_ID_CERTIFICATE_PASSWORD` | secret | Password for that `.p12` |
| `MACOS_NOTARY_API_KEY_P8_BASE64` | secret | App Store Connect API key for notarization, base64 encoded |
| `MACOS_DEVELOPER_ID_APPLICATION_SIGNING_IDENTITY` | variable | Exact `Developer ID Application: …` identity |
| `MACOS_NOTARY_API_KEY_ID` | variable | App Store Connect API key ID |
| `MACOS_NOTARY_API_ISSUER_ID` | variable | App Store Connect API issuer ID |
| `EXPO_TOKEN` | secret | Expo token for the linked `unlikeotherai/nessie` EAS project |
| `TAURI_SIGNING_PRIVATE_KEY` | repository secret | Persistent key for signing direct desktop update artifacts |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | repository secret | Password protecting the Tauri updater private key |

The Windows reusable workflow reads its signing configuration from repository
secrets: `WINDOWS_SIGN_COMMAND`, `WINDOWS_SIGNER_THUMBPRINT`,
`WINDOWS_SIGNER_SUBJECT`, plus `WINDOWS_SIGN_TOOL_INSTALL` and the Azure
credentials when the configured signing command uses Azure Artifact Signing.
Those three mandatory values must remain repository secrets: reusable workflows
do not inherit the caller environment's secrets. `WINDOWS_SIGN_COMMAND` must
use the `%1` placeholder for the artifact path and the thumbprint must identify
the intended 40-character SHA-1 certificate thumbprint.
The release caller marks signing mandatory, so missing Windows configuration
fails the build instead of publishing the workflow's normal unsigned
development artifact.

The Tauri updater key is independent of both Developer ID and Authenticode
credentials. Its public key is checked into
`desktop/src-tauri/tauri.direct-updater.conf.json`; the private key and password
are repository secrets because the reusable Windows workflow needs them. Keep a
recoverable owner-controlled backup of that key: losing it prevents every
already-installed direct desktop client from accepting future releases.

The existing Mac App Store certificate is intentionally not accepted here. A
GitHub download requires a **Developer ID Application** signature, hardened
runtime, notarization, stapling, and Gatekeeper verification. The workflow
rejects an unsigned, ad-hoc-signed, App Store-signed, or non-notarized Mac
package.

EAS retains the Android signing keystore for the `device` profile. Keep that
keystore under the owning Expo account; replacing it would prevent updates from
installing over prior Android builds.

## Versioning

`v0.0.1` is the first public GitHub direct-download release identifier. The
desktop and Android applications already have independent internal version
tracks; the workflow records those exact values in its release notes rather
than mislabelling either binary. Future app-version changes must stay explicit:
the direct desktop version must be valid SemVer and strictly greater than the
version in the latest published `latest.json`, while Android `versionCode` must
increase for every installable update. The release metadata check rejects a
desktop downgrade or repeat before a platform build begins.

## Before tagging

1. Merge the release commit into `main` and ensure its normal CI is green.
2. Confirm the `direct-download-release` secrets above and the Windows signing
   secrets are configured. The protected **Direct-distribution credential gate**
   and repository-scoped **Windows-signing credential gate** list every missing
   name before any platform build begins.
3. Create and push the annotated tag, for example `git tag -a v0.0.1 -m
   "Nessie v0.0.1"` followed by `git push origin v0.0.1`.
4. Approve the protected environment if configured. The release becomes public
   only after the Mac, Windows, Linux, and Android gates all pass.

iOS is intentionally not part of this workflow: its button stays marked
**Coming soon** until an App Store release is available.
