# Windows desktop parity

**Status:** active — design refined 2026-09-01. This revision replaces the
first draft of the same date; "Review of the first draft" at the end records
what changed and why.
**Owner:** Desktop
**Target:** signed Windows x86_64 Tauri release (NSIS per-user installer
supported; MSI as the managed-deployment artifact).
**Related:** [2026-09-01-linux-desktop-delivery.md](2026-09-01-linux-desktop-delivery.md)
§"Shared shell contract" (adopted here in full — window chrome, single
instance + deep link, notifications, the Executors panel's `availability`
card, and the no-updater decision), [docs/running-the-apps.md](../running-the-apps.md),
[docs/executor-protocol.md](../executor-protocol.md) §"Desktop-packaged companion".

## Outcome

The Windows desktop application has parity with the supported macOS Tauri
desktop product **as a shell**: a signed, installable release opens the hosted
Nessie workspace from Start without a console window, completes desktop SSO
through `nessie://`, shows native notifications, and honours single-instance
and deep-link behaviour.

Local executor execution on Windows is **not** part of this release. It is a
separate, gated design with five prerequisites (below), and until they land
together the **Agents → Executors** page explains that on Windows instead of
hiding the companion. The first draft folded executor pairing into parity; the
code does not support that reading.

## Product boundary

Windows is not behind the historical `macos/Nessie` SwiftUI application in the
supported product boundary: that app is a separate legacy local-orchestrator
and voice client. Its microphone, voice WebSocket, and `127.0.0.1:4317`
orchestration design are not implemented by the current cross-platform desktop
shell, including on macOS. If those experiences become a product requirement,
they need a separately approved cross-platform service protocol and UI scope.

The supported product is the Tauri shell plus, on a signed macOS release, the
executor companion. Windows today has the same shell code, no signed release
pipeline, no CI job, and a companion that refuses every platform but macOS.

## How the Windows app looks and works

Everything in the Linux plan's shared shell contract applies. Windows-specific
facts:

- **Window.** Native Windows title bar with minimize/maximize/close
  (`decorations: true`; `titleBarStyle`/`hiddenTitle` are macOS-only and
  ignored). The admin top bar sits below it with no traffic-light spacer and
  no drag regions, selected by `desktopPlatform === 'windows'`. The title bar
  follows the Windows light/dark setting; the content follows the person's
  Nessie theme. Default 1280 × 800, minimum 1024 × 700, `#2e1132` while the
  hosted admin loads.
- **No console.** `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]`
  in `main.rs` already keeps release launches console-free; `tauri dev` showing
  a terminal is normal and not a defect.
- **Install.** NSIS with `installMode: "currentUser"` (already configured):
  no administrator prompt, Start menu entry "Nessie", per-user uninstall entry.
  The MSI (WiX) is produced for managed deployment and is not the path the
  release notes describe to a person. WebView2 stays on the bundler default
  `downloadBootstrapper`: Windows 10 1803+ and Windows 11 ship the Evergreen
  runtime, and the installer fetches it only when absent.
- **Deep link.** The installer registers `nessie` under
  `HKCU\Software\Classes` (the deep-link plugin documents that Windows
  schemes are registry-registered by the NSIS/MSI installer and that a
  portable executable cannot register system-wide). A second launch — which
  is how the browser callback reaches an already-running app on Windows —
  is forwarded by `tauri-plugin-single-instance` with `features = ["deep-link"]`
  per the shared contract; today the callback is dropped.
- **Notifications.** Windows toast via `notify-rust` with `app_id` set to the
  bundle identifier. The plugin documents that toasts "only work for installed
  apps" and show the PowerShell name and icon in development, so notification
  acceptance is always on the installed build. Click-to-route follows the
  shared contract: baseline is the toast appearing; the route claim needs a
  smoke-test result.
- **Badge.** Verified in the release smoke; documented as working or absent.
- **Executors.** The companion card reads: *"Local executors need Nessie
  Desktop for macOS 15 or later on Apple Silicon. This app can review,
  approve, and promote executor work, but it cannot pair or run a local daemon
  on Windows."* The CLI pairing block states the same platform requirement
  and stops presenting a `$HOME`-based shell command as if it applied.

## Signed release pipeline

- **What gets signed.** Tauri signs the executable and both installers during
  `tauri build`. Signature verification is a release gate: the workflow runs
  `Get-AuthenticodeSignature` on the `.exe`, the NSIS setup, and the MSI and
  requires `Status = Valid` with the expected signer subject before any
  artifact is retained.
- **How.** Two supported configurations, one chosen and recorded in
  `docs/running-the-apps.md`:
  1. **Azure Artifact Signing** (formerly Azure Trusted Signing) through
     `bundle.windows.signCommand` — recommended, because no private key is
     ever present on a runner and SmartScreen reputation attaches to the
     managed identity.
  2. An OV/EV certificate through `bundle.windows.certificateThumbprint`,
     `digestAlgorithm: "sha256"`, and `timestampUrl`, with the `.pfx`
     imported from a GitHub secret on the runner. EV gives immediate
     SmartScreen reputation; OV builds it over time.
  Either way the signer identity is a deployment fact, not repository
  content, and a build without it is a development build.
- **Where.** A new `desktop-windows` GitHub Actions workflow on a Windows
  runner: Node 22 (the packaged runtime is the host's Node — same rule as
  Linux), Rust `stable-msvc`, MSVC build tools, the VBSCRIPT optional feature
  for the MSI, `cargo test` in `desktop/src-tauri`, `tauri build`, signing,
  SHA-256 checksums, artifact retention.
- **Smoke on the runner.** Silent install with `Nessie_<version>_x64-setup.exe /S`;
  verify the registry key `HKCU\Software\Classes\nessie` exists; launch;
  assert after ten seconds that the process is alive with a main window
  titled "Nessie" and no console window; uninstall silently. Appearance is
  still checked by a person on a real Windows desktop before release.
- **Runtime packaging on Windows.** `prepare-executor-runtime.mjs` and
  `runtime.rs` assume the Unix layout: the copied binary is named `node`
  (Windows must execute `node.exe`), the licence is read from
  `dirname(process.execPath)/../LICENSE` (Windows installs `LICENSE` beside
  `node.exe`), and `chmod` is a no-op. The manifest gains the executable file
  name, the script resolves the licence per platform, and the integrity
  checks apply on Windows exactly as on macOS — the runtime is packaged and
  verified even while the companion is unavailable, so a later enablement
  does not discover a broken package.

## Executor on Windows — deferred, with the exact prerequisites

The first draft's phase 2 ("signed companion support") assumed Authenticode
verification would unlock pairing. It would not: pairing runs the packaged CLI,
whose descriptor builder refuses any platform but macOS 15+ on Apple Silicon
(`executor/src/descriptor.ts`), the server schema pins the same literals
(`packages/schemas/src/executor.ts`), and the sandbox is a
`Virtualization.framework` micro-VM (`executor/vm`, `executor/guest`). Windows
executor support is one change containing all of the following, or none of it:

1. **Release-provenance verification in the companion.** `WinVerifyTrust`
   with `WINTRUST_ACTION_GENERIC_VERIFY_V2` on `std::env::current_exe()`
   (Authenticode validity and chain), then the signer certificate read from
   the verification state (WinVerifyTrust alone answers "trusted", not "by
   whom") pinned to a publisher identity compiled into the release via
   `option_env!("NESSIE_DESKTOP_WINDOWS_SIGNER_THUMBPRINT")` — the exact
   analogue of `NESSIE_DESKTOP_SIGNING_TEAM_ID` on macOS. A hash-only check
   is insufficient because it does not establish who released the file.
   `require_release_signature` gains a Windows arm; the non-macOS refusal
   remains for every other platform.
2. **A Windows platform descriptor** (`os: 'windows'`, `architecture:
   'x64'`, a minimum OS build) accepted by schema, CLI, and API in one
   contract change, so the server can refuse a descriptor it does not
   understand rather than guess.
3. **Owner-only private state on Windows.** `state-store.ts` and
   `daemon-lease.ts` prove privacy with POSIX mode bits (`mode & 0o077`) and
   `process.getuid()`; on Windows Node reports `0o666`-style modes and no uid,
   so the checks would fail closed at first load. Windows needs a DACL design:
   the state directory created with an ACL granting only the current user
   SID, verified before every read, and the lease's process liveness checked
   through a process handle rather than `kill(pid, 0)`.
   `unowned_daemon_is_stopping` currently returns `true` on non-Unix whenever
   a lease file exists, which would leave a stale lease blocking every start
   forever; the same change fixes it.
4. **Graceful stop without signals.** `signal_stop` errors on non-Unix. The
   daemon already stops when its parent-liveness stdin closes
   (`waitForExecutorDaemonShutdown`), and desktop exit already relies on that.
   Windows stop = close the liveness pipe, wait the same ten seconds, and
   refuse with the same "will not force-kill" message; `TerminateProcess` is
   never the normal path.
5. **A Windows sandbox backend.** Nothing in the repository runs a session
   micro-VM on Windows. This is a product decision with its own
   protocol-document changes (Hyper-V/WSL2-hosted micro-VM or another approved
   backend), not a porting task, and it is the item that decides whether the
   other four are worth building.

Coverage when that change lands: unsupported, unsigned, tampered, pairing,
running, stopping, and shutdown conditions in the Rust companion tests; the
panel continues to show a clear error and retains no local path, secret, or
child-process output.

## Delivery phases

### 1. Shell parity on Windows

- Adopt the shared shell contract: `desktopPlatform` exposure and top-bar
  treatment; single instance with the `deep-link` feature; structured
  companion `availability` and the explanatory card; platform-aware runtime
  packaging.
- Build and run the development shell on a Windows machine against `pnpm dev`;
  visually check login, the workspace, the top bar under the native title bar,
  and the Executors page card. Headless Playwright on `http://localhost:5455`
  proves the web top bar is unchanged.

### 2. Signed release and CI

- The `desktop-windows` workflow, signing configuration, verification gate,
  checksums, and silent-install smoke described above.
- `docs/running-the-apps.md` replaces its two-line Windows section with
  install, replacement, launch, log collection (`%LOCALAPPDATA%` path and
  how to run the executable from a terminal once), and signature
  verification steps, maintained beside the Mac instructions.

### 3. Release acceptance on a real Windows desktop

1. Install from Start-menu-less state with the NSIS installer; Start shows
   Nessie; launching opens one window, no console, native title bar, admin
   top bar without a gap, login screen.
2. Sign in through the browser; the window returns authenticated. Start a
   second sign-in with the app open; it completes in the existing window.
3. Launch Nessie again from Start; the existing window is focused.
4. Enable **Push enabled**; a message from another account produces a toast
   with the composed title and body. Record whether activation opens the
   route and whether the taskbar badge appears.
5. **Agents → Executors** shows the Windows companion card; reviewing,
   approving, and promoting executor work from a macOS-paired executor works.
6. Deploy a new admin bundle; the window reloads without a reinstall.
7. Right-click the installed executable → Properties → Digital Signatures
   shows the expected publisher; `Get-AuthenticodeSignature` reports `Valid`.

## Acceptance checklist

- A signed Windows x86_64 NSIS installer (and MSI) opens Nessie from Start
  without a console window and points production traffic at
  `https://app.nessie.works`.
- Authentication returns through `nessie://` to the existing app instance,
  including when the app was already running.
- A running app shows native toasts; the click-to-route and badge results are
  recorded in `docs/running-the-apps.md`.
- **Agents → Executors** shows the explanatory companion card on Windows;
  every non-daemon executor action on the page works.
- CI validates the signatures of all three artifacts, runs the shell's Rust
  tests, and performs the silent install/launch/uninstall smoke, with release
  instructions maintained beside the Mac instructions.

## Explicit non-goals

- Porting or presenting the legacy SwiftUI voice UI as implicit Windows
  parity.
- Executor pairing, daemon lifecycle, or local policy on Windows before the
  five prerequisites land together; silent local pairing; background daemon
  force-killing; storing workspace paths or pairing material in the hosted
  service.
- Calling a manually built unsigned NSIS/MSI file a production release.
- An in-app updater in this release (shared decision with Linux).

## Review of the first draft (2026-09-01)

- **Executor parity was treated as a signing task.** The CLI, schema, and
  sandbox backend all refuse or lack Windows; Authenticode verification is one
  of five prerequisites, not the gate. Rescoped: shell parity now, executor as
  a gated design with the list above.
- **The panel vanished on Windows.** Adopted the shared `availability` card
  so the Executors page explains instead of hiding.
- **Window chrome was not designed.** macOS-only title-bar fields; adopted the
  shared platform-exposure contract.
- **Single instance dropped the sign-in callback.** Windows delivers the
  callback as a second process's argv; the plugin's `deep-link` feature is
  required. Added.
- **Click-to-route and the badge were assumed.** Plugin desktop backend
  reports no clicks; toasts need an installed app. Reframed as verified.
- **Runtime packaging is Unix-shaped.** `node` vs `node.exe`, licence path,
  no-op `chmod`. Added to the release pipeline.
- **Graceful stop and state security were listed without a design.** Named
  the liveness-pipe stop, the DACL requirement, the POSIX mode-bit failure,
  and the stale-lease deadlock on non-Unix.
- **Signing method was unspecified.** Named the two Tauri-supported
  configurations, recommended Azure Artifact Signing, and made signature
  verification a CI gate.
- **Phase 1's "start the local API/admin and Tauri shell without a visible
  terminal window" was a development-mode non-issue.** Removed; the release
  setting already exists.
- **"CI validates" had no CI.** Named the workflow, host requirements, and
  the silent-install smoke.
