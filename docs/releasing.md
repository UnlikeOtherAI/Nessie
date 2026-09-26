# Publishing direct downloads

Pushing a protected `vMAJOR.MINOR.PATCH` tag at the current `main` commit runs
the **Publish Direct Downloads** workflow. It verifies the source, builds all
downloadable clients from that exact tag, then creates the GitHub Release only
after every platform has passed its release gate.

## Edge builds from main

Between releases, the **Windows Edge** workflow (`.github/workflows/windows-edge.yml`)
keeps the newest signed Windows build of each component on GitHub. A merge to
`main` that changes what a component is built from rebuilds it, signs it and
replaces that component's rolling pre-release; a component whose inputs did not
change keeps its current build and gains no new version.

| Component | Rolling pre-release | Assets |
| --- | --- | --- |
| Nessie Desktop | [`desktop-edge`](https://github.com/UnlikeOtherAI/Nessie/releases/tag/desktop-edge) | `Nessie-Windows-Setup.exe`, `Nessie-Windows.msi` |
| Nessie Executor | [`executor-edge`](https://github.com/UnlikeOtherAI/Nessie/releases/tag/executor-edge) | `Nessie-Executor-Windows.msi` |

Asset names are stable, so
`https://github.com/UnlikeOtherAI/Nessie/releases/download/desktop-edge/Nessie-Windows-Setup.exe`
is always the newest edge desktop installer; each asset has a `.sha256` beside
it, and the release notes name the version, commit and workflow run.

- **What counts as a change** is `scripts/release-components.mjs`: the desktop
  is rebuilt for `desktop/`, `assets/` and everything the executor is built
  from, because it carries the executor runtime; the executor for `executor/`,
  the workspace packages its runtime bundles, the lockfile and the Windows
  build workflow. Each component is compared with the commit its edge tag
  points at — the build currently published — so a failed run is retried by
  the next one, and a re-run of an older run never replaces a newer build.
- **Versions** are `MAJOR.MINOR` from the component's manifest
  (`desktop/src-tauri/tauri.conf.json`, `executor/package.json`) with `main`'s
  first-parent commit count as the build number, so every build installs over
  the previous one. Change `MAJOR.MINOR` in the manifest; never the build.
- **Signing** happens in the `windows-signing` environment, which deploys only
  from `main` and needs no approval, so no merge waits on a person.
- **Edge builds do not self-update** (they carry no direct updater): install the
  next one over the last. Runs never overlap and are never cancelled; a newer
  push waits for the running build, and only the newest waiting run is kept.

How edge and stable releases fit together per component — and why this is the
monorepo convention rather than one release of everything — is
[the component release model](plans/2026-09-26-component-releases.md).

## Published assets

- `Nessie-macOS-Apple-Silicon.dmg` and `Nessie-macOS-Intel.dmg` — ad-hoc,
  non-notarized macOS installers.
- `Nessie-Windows-Setup.exe` and `Nessie-Windows.msi` — Windows desktop
  installers, Authenticode-signed by UnlikeOtherAI s.r.o.
- `Nessie-Executor-Windows.msi` — the standalone Windows executor (service and
  tray), signed by the same publisher.
- `Nessie-Linux.AppImage` and `Nessie-Linux.deb` — Linux desktop packages.
- `Nessie-Android.apk` — signed Android internal-distribution build.
- `SHA256SUMS` — SHA-256 digests for every downloadable asset.
- `latest.json` — signed release metadata for desktop update checks and the
  direct Android APK handoff.

The stable desktop asset names power downloads under
`/releases/latest/download/`. Mac is two assets because its packaged Node
executor runtime must match the processor architecture. The Android link on
the public homepage and admin sign-in currently points at the Android-only
[`android-v0.1.2-4` release](https://github.com/UnlikeOtherAI/Nessie/releases/tag/android-v0.1.2-4)
instead. Its signed `Nessie-Android.apk` was built locally from source commit
`38937d7b78021de385c350720777becd9816d53a` and published as a prerelease,
so it does not become the desktop `/releases/latest` target or invoke the `v*`
all-platform workflow. The release page records its SHA-256 checksum and signing
certificate. Future Android releases must update the shared download URL and
increase `versionCode`.

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
installs a package. The direct Android build sets
`EXPO_PUBLIC_RELEASE_CHANNEL=direct`; a future Play build must set it to
`store`, so Google Play handles its updates. The Android-only prerelease has no
`latest.json`, so this first public APK is installed or updated from its GitHub
download link until an all-platform stable release publishes update metadata.
The Mac App Store build also omits the `direct-updater` Cargo feature and its
native commands, not merely the popup.

## Required GitHub configuration

The macOS and Android jobs run in the `direct-download-release` environment.
It must require a release-owner approval and allow deployment from the `v*`
tag pattern only. Scope its secrets to maintainers who can cut a release. It
needs:

| Name | Type | Purpose |
| --- | --- | --- |
| `NESSIE_ANDROID_KEYSTORE_BASE64` | environment secret | Base64 of the dedicated Android app signing keystore |
| `NESSIE_ANDROID_KEYSTORE_PASSWORD` | environment secret | Keystore password |
| `NESSIE_ANDROID_KEY_ALIAS` | environment secret | App signing key alias |
| `NESSIE_ANDROID_KEY_PASSWORD` | environment secret | App signing key password |
| `TAURI_SIGNING_PRIVATE_KEY` | repository secret | Persistent key for signing direct desktop update artifacts |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | repository secret | Password protecting the Tauri updater private key |

Windows releases fail closed unless Azure Artifact Signing succeeds. The
`nessie-github-signing` managed identity has only the Artifact Signing signer
role, uses no client secret, and trusts exactly two immutable OIDC subjects of
this repository: the `direct-download-release` environment, where a release tag
signs behind a release owner's approval, and the `windows-signing` environment,
which deploys only from `main` and signs the edge builds below without one. The
repository variables named in [Windows Desktop](running-the-apps/windows-desktop.md)
select the Azure account/profile and pin its durable profile EKU and subject;
the release workflow requires signed output.

The Tauri updater key is independent of both Developer ID and Authenticode
credentials. Its public key is checked into
`desktop/src-tauri/tauri.direct-updater.conf.json`; the private key and password
are repository secrets because the reusable Windows workflow needs them. Keep a
recoverable owner-controlled backup of that key: losing it prevents every
already-installed direct desktop client from accepting future releases.

The current GitHub macOS download is deliberately ad-hoc signed because no
Developer ID identity is available. It is not notarized and cannot pass
Gatekeeper assessment. A person must open it via Finder's **Open** action (or
remove the quarantine attribute after inspecting the download). Its Tauri
updater artifacts remain separately signed. The release workflow applies
`desktop/src-tauri/tauri.adhoc-macos.conf.json` after the direct-updater
configuration so that Tauri explicitly uses `codesign -s -`. Replace this
temporary path with Developer ID signing, hardened runtime, notarization,
stapling, and Gatekeeper verification as soon as a suitable identity is
available.

The Android build runs Expo prebuild and Gradle on the GitHub runner. It does
not use Expo Cloud or an Expo account. The signing key is backed up outside Git
and supplied to the runner by the protected environment. The workflow checks
the certificate fingerprint recorded in [the signing standard](standards/build-and-release.md#android-signing).
The new Android package is `com.unlikeotherai.nessie`; old `com.km.nessie`
installs are a separate app and cannot be updated in place. Play distribution
is pending; its app signing key must be set to this same key before the first
Play release so GitHub APK and Play installs can update each other.

## Versioning

`v0.0.1` already exists as an immutable tag for source that is no longer the
current `main` commit, so the release preflight deliberately rejects it. Use
`v0.0.2` for the first published GitHub direct-download release instead of
rewriting that tag. The desktop and Android applications already have
independent internal version tracks; the workflow records those exact values in
its release notes rather than mislabelling either binary. Future app-version
changes must stay explicit: the direct desktop version must be valid SemVer and
strictly greater than the version in the latest published `latest.json`, while
Android `versionCode` must increase for every installable update. The release
metadata check rejects a desktop downgrade or repeat before a platform build
begins.

## Before tagging

1. Merge the release commit into `main` and ensure its normal CI is green.
2. Confirm the `direct-download-release` secrets above are configured. The
   protected **Direct-distribution credential gate** lists every missing name
   before any platform build begins.
3. Create and push the annotated tag, for example `git tag -a v0.0.2 -m
   "Nessie v0.0.2"` followed by `git push origin v0.0.2`.
4. Approve the protected environment if configured. The release becomes public
   only after the Mac, Windows, Linux, and Android gates all pass.

iOS is intentionally not part of this workflow: its button stays marked
**Coming soon** until an App Store release is available.
