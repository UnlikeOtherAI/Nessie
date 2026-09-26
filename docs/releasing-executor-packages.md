# Executor package distribution

The public installation home is [Install an executor](https://nessie.works/docs/executor-setup),
linked from the website's documentation navigation and executor guide.
The [README](../README.md) links there and to the
[repository installation guide](running-the-apps/executor-cli.md).
Those pages use the final package names and commands.

## Package contract

| Package | Delivery | Runtime |
| --- | --- | --- |
| `nessie-executor` CLI | `UnlikeOtherAI/homebrew-tap`, formula `nessie-executor` | macOS 15+, Apple Silicon |
| Nessie desktop app | Same tap, cask `nessie` | macOS 15+, Apple Silicon |
| Nessie executor app | Same tap, cask `nessie-executor-app` | macOS 15+, Apple Silicon |
| `nessie-executor` CLI | Signed APT and RPM repositories at `packages.nessie.works` | Linux x86_64 with systemd |
| Nessie Windows executor | WinGet `UnlikeOtherAI.NessieExecutor` | Signed x64 WiX MSI |

Linux targets Debian 12+, Ubuntu 22.04+, Fedora, Rocky Linux 9+ and AlmaLinux
9+. The official Node 22 runtime has a glibc 2.28 baseline; the release
workflow builds the Rust helper with musl and Go guest tools with CGO disabled.
The package declares glibc 2.31 or later. No Linux Homebrew formula is offered:
the executor's Linux trust boundary requires administrator-owned files under
`/usr/lib`. Both native packages install the identical payload there.

Package-manager manifests reference immutable release assets and their exact
SHA-256 digests. Never point a Homebrew formula, cask or WinGet manifest at
`latest`, `desktop-edge` or `executor-edge`: those URLs move.

## Build candidates without publishing

**Build Executor CLI** (`.github/workflows/executor-cli.yml`) is manually
dispatched with a stable three-part version. Its default builds Linux with a
temporary verification key. `macos=true` includes the signed Mac CLI;
`release_signing=true` selects the production Linux repository key.
The workflow has read-only repository permission and uploads artifacts only.

```sh
gh workflow run executor-cli.yml --ref main -f version=1.0.0
```

It produces DEB, RPM, a repository archive and candidate provenance. The Mac
job additionally produces a signed/notarized runtime tarball and generated
Homebrew formula. Each candidate records its exact source commit and hashes
every publishable file. Verification-key candidates cannot pass the publisher.
Changing any file after the candidate was recorded fails verification.

For a native Linux build, use Node 22, pnpm, Go 1.24+, Rust with the
`x86_64-unknown-linux-musl` target, musl-tools, GnuPG, apt-utils, rpm and
createrepo-c. Install the checksum-pinned nFPM using
`sh executor/packaging/linux/install-nfpm.sh /path/to/tools`.
After dependency installation and Prisma generation, lint/typecheck/build
`@nessie/executor...` through Turbo, then build the Rust helper with
`cargo build --release --target x86_64-unknown-linux-musl --manifest-path executor/native/Cargo.toml`.
Set `NESSIE_EXECUTOR_NATIVE_HELPER_PATH` to that binary and
`NESSIE_EXECUTOR_VERSION` to the release version, then run
`node executor/packaging/linux/build-packages.mjs`.
The legacy `build-deb.mjs` entry point still produces the existing desktop
workflow's DEB path.

The repository builder requires `NESSIE_REPOSITORY_SIGNING_FINGERPRINT` and
a GnuPG keyring holding that signing key. nFPM takes the private key through
`NESSIE_RPM_SIGNING_KEY_FILE`, outside the checkout. It signs the RPM itself;
`build-repository.mjs` verifies that signature against the imported public
key, signs APT and RPM metadata, exports only the public key, then signs
`SHA256SUMS`. Each build replaces its staging snapshot; do not append stale
packages or metadata from another version.

## One-time release configuration

Create the public `UnlikeOtherAI/homebrew-tap` repository and its `Formula/`
and `Casks/` directories. Homebrew resolves the public tap directly.
Protect its default branch and review generated manifest updates through PRs.

Host the contents of `nessie-executor_<version>_repository.tar.gz` as static
files at `https://packages.nessie.works`, preserving the `apt/` and `rpm/`
paths. The archive includes a CNAME for that hostname, a landing page and the
public key. For GitHub Pages, use a dedicated public package repository, enable
Actions-based Pages, configure its custom domain, and deploy this archive with
`actions/upload-pages-artifact` and `actions/deploy-pages`. Set DNS to that
repository's Pages site and enforce HTTPS. Repository metadata must be deployed
together as one snapshot; retain the previous signed archive for rollback.

In the `executor-cli-release` GitHub environment, configure:

| Name | Type | Purpose |
| --- | --- | --- |
| `EXECUTOR_REPOSITORY_SIGNING_KEY` | secret | ASCII-armored, passphrase-free release signing private key, protected by the environment |
| `EXECUTOR_REPOSITORY_SIGNING_FINGERPRINT` | variable | Full 40-character uppercase fingerprint |

Keep a recoverable offline backup of the signing key. Never commit it or copy
it into a package artifact. Only production candidates may use it; verification
runs generate and delete their own one-day key.

The Apple jobs share `.github/actions/setup-apple-signing` and the existing
`direct-download-release` configuration:

- Variables: `MACOS_DEVELOPER_ID_SIGNING_IDENTITY`,
  `MACOS_DEVELOPER_ID_TEAM_ID`, `APP_STORE_CONNECT_API_KEY_ID`,
  `APP_STORE_CONNECT_API_ISSUER_ID`.
- Secrets: `MACOS_DEVELOPER_ID_CERTIFICATE_P12_BASE64`,
  `MACOS_DEVELOPER_ID_CERTIFICATE_PASSWORD`,
  `APP_STORE_CONNECT_API_KEY_P8_BASE64`.
- Direct Desktop also uses the existing Tauri updater signing key and password.

The certificate must be **Developer ID Application**. Developer and Mac App
Store identities cannot substitute. The shared signer seals the packaged Node
with its own JIT entitlements, refreshes its manifest, then seals the app.
Notarization submits a ZIP of the app, staples the app, then notarizes and
staples its DMG. Both app and DMG must pass Gatekeeper. The CLI's tarball cannot
be stapled; Apple records notarization tickets for its signed executables.

Allow the protected Apple environment to build the selected trusted main
revision for manually dispatched CLI candidates as well as the existing
release tags. Do not broaden it to arbitrary branches.

Windows reuses PR #737's Azure Artifact Signing OIDC path and publisher pin.
No additional signing account, private key or browser login is needed.
`desktop-windows.yml` signs the executor, verifies every executable and the
MSI, reads the MSI's real ProductVersion/ProductCode, generates the WinGet
manifests and runs `winget validate` for stable release tags. Edge publication
keeps its existing behavior and never submits a stable WinGet package.

## Publish an approved production candidate

Package publication is an explicit operator action, separate from merging
source and deploying website documentation. The current task prepares this
pipeline and deliberately stops before creating a tap, configuring public
hosting, publishing CLI packages or submitting WinGet manifests.

1. Build production-signed Linux and Mac CLI candidates from the same green
   `main` commit. Download both workflow artifacts into one directory,
   preserving `Formula/`.
2. Verify the public signing key fingerprint against the release configuration,
   import it into a verification keyring and run
   `gpg --verify SHA256SUMS.asc SHA256SUMS` and `sha256sum -c SHA256SUMS`.
   Test installation using APT/DNF and Homebrew, pairing, per-team startup and
   an upgrade that preserves local state.
3. Create the immutable `executor-v<version>` tag at that exact source commit.
   Push the tag, then run:
   `NESSIE_EXECUTOR_VERSION=<version> node executor/packaging/cli/publish.mjs /path/to/candidates`.
   The publisher checks both production candidate manifests, unchanged hashes,
   the matching tag, and successful main CI plus Desktop CI before uploading.
   It sets `--latest=false` so it cannot replace the desktop updater's latest release.
4. Deploy the signed repository snapshot. Commit the generated formula to the
   tap through a PR; run `brew audit --strict`, install it and run `brew test`.
   Merge after verification.

For apps, the existing `v*` release workflow builds signed/notarized Mac
installers and signed Windows installers. It attaches
`package-manager-manifests.tar.gz` with `Casks/` and `winget/`.
The generators run on the native OS and reject incorrect publishers,
missing notarization, unsigned installers and moving release tags.
They also work locally:

```sh
node executor/packaging/cli/generate-app-manifests.mjs desktop v1.0.0 /path/to/Nessie-macOS-Apple-Silicon.dmg
node executor/packaging/cli/generate-app-manifests.mjs executor v1.0.0 /path/to/Nessie-Executor-macOS-Apple-Silicon.dmg
node executor/packaging/cli/generate-app-manifests.mjs winget v1.0.0 /path/to/Nessie-Executor-Windows.msi
```

For the local Windows command, set `WINDOWS_SIGNER_EKU` and
`WINDOWS_SIGNER_SUBJECT` to the same public pin used by the signing workflow.
Casks use the actual app version; WinGet uses the actual MSI version, which
can differ from the umbrella release tag.

Copy casks into the tap through a PR and verify installation on a clean Mac.
Submit the generated `manifests/u/UnlikeOtherAI/NessieExecutor/<version>/`
directory through a PR to `microsoft/winget-pkgs`; Microsoft validates and
reviews that submission. Run `winget validate --manifest <directory>` and test
installation/upgrade/uninstall before submitting. No manifest is submitted
automatically, and all pairing state survives ordinary uninstall.
