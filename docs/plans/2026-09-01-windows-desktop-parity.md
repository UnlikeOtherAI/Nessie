# Windows desktop parity

**Status:** active — design refined 2026-09-01, then re-scoped the same day
on Ondrej's direction: the executor ships on Windows as a service with a tray
icon beside the clock, the desktop app can enable itself as an executor, and
the window is fully custom chrome. "Review and direction changes" at the end
records every revision.
**Owner:** Desktop
**Target:** signed Windows 11 x86_64 release — the Nessie desktop app (NSIS
per-user installer supported; MSI for managed deployment) and the standalone
**Nessie Executor** MSI.
**Related:** [2026-09-01-linux-desktop-delivery.md](2026-09-01-linux-desktop-delivery.md)
— its "Shared shell contract" (custom window chrome, single instance + deep
link, notifications, the Executors page's `availability` cards, no updater)
and "Shared executor contract" (two supervisors, platform contract, sandbox
backends, trust roots) are adopted here in full — [docs/running-the-apps.md](../running-the-apps.md),
[docs/executor-protocol.md](../executor-protocol.md).

## Outcome

The Windows desktop application has parity with the macOS Tauri desktop
product: a signed release opens the hosted Nessie workspace from Start in a
frameless, rounded window that is entirely Nessie's design, with no console,
completes desktop SSO through `nessie://`, shows native toasts, honours single
instance and deep link, and can be **enabled as an executor on request** from
**Agents → Executors** with the same native confirmations as macOS.

A Windows computer without the desktop app can be an executor through the
standalone **Nessie Executor** package: a Windows service (the daemon) that
starts at boot and survives logout, plus a **tray icon beside the clock** as
its control surface, so nobody has to open a terminal to pair, start, stop, or
read the state of their executor.

## Product boundary

Windows is not behind the historical `macos/Nessie` SwiftUI application in the
supported product boundary: that app is a separate legacy local-orchestrator
and voice client. Its microphone, voice WebSocket, and `127.0.0.1:4317`
orchestration design are not implemented by the current cross-platform desktop
shell, including on macOS. If those experiences become a product requirement,
they need a separately approved cross-platform service protocol and UI scope.

Windows today has the same shell code as macOS, no signed release pipeline,
no CI job, and a companion that refuses every platform but macOS.

## How the Windows app looks and works

The shared shell contract applies. Windows-specific facts:

- **Window.** `decorations: false` and `shadow: true`. Tauri's config
  documents that an undecorated window then has "a 1px white border, and on
  Windows 11, it will have a rounded corners" with the OS shadow — which is why
  Windows 11 is the target and the window is not transparent (a transparent
  window loses the DWM shadow). `DesktopWindowFrame` renders the drag strip,
  Nessie's own minimize / maximize / close at the top right, and the resize
  handles; maximized and fullscreen windows are square-cornered by the OS.
  Snap Layouts' hover flyout does not appear over a custom maximize button;
  Win+Arrow snapping still works. Default 1280 × 800, minimum 1024 × 700,
  `#2e1132` while the hosted admin loads.
- **No console.** `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]`
  in `main.rs` already keeps release launches console-free; `tauri dev`
  showing a terminal is normal.
- **Install.** NSIS with `installMode: "currentUser"` (already configured):
  no administrator prompt, Start menu entry "Nessie", per-user uninstall. The
  MSI (WiX) is produced for managed deployment. WebView2 stays on the bundler
  default `downloadBootstrapper`: Windows 11 ships the Evergreen runtime and
  the installer fetches it only when absent.
- **Deep link.** The installer registers `nessie` under
  `HKCU\Software\Classes` (the deep-link plugin documents that Windows schemes
  are registry-registered by the NSIS/MSI installer and that a portable
  executable cannot register). A second launch — how the browser callback
  reaches a running app on Windows — is forwarded by
  `tauri-plugin-single-instance` with `features = ["deep-link"]`; today the
  callback is dropped.
- **Notifications.** Windows toast via `notify-rust` with `app_id` set to the
  bundle identifier. The plugin documents that toasts "only work for installed
  apps", so notification acceptance is always on the installed build.
  Click-to-route follows the shared contract.
- **Badge.** Verified in the release smoke; documented as working or absent.
- **Executors.** The companion panel offers pairing on a signed release;
  `workspace_only` on Windows 11 Home or a machine without Hyper-V reads:
  *"This computer can pair as an executor for file review and drafts.
  Sandboxed commands, browsers and coding sessions need Hyper-V, which is
  available on Windows 11 Pro, Enterprise and Education."*

## The executor on Windows

### The desktop app, enabled on request

From the person's side it is the macOS flow: **Agents → Executors → Pair
executor → Choose workspace and pair this computer**, native folder picker,
native confirmation, fingerprint confirmation in Nessie, **Start daemon**. The
daemon runs in the person's session as a child of the app with the liveness
pipe, and lives while the app runs. Behind it:

- **Release-provenance verification.** `require_release_signature` gains a
  Windows arm: `WinVerifyTrust` with `WINTRUST_ACTION_GENERIC_VERIFY_V2` on
  `std::env::current_exe()` (Authenticode validity and chain), then the
  signer certificate read from the verification state — WinVerifyTrust alone
  answers "trusted", not "by whom" — pinned to the publisher compiled into the
  release via `option_env!("NESSIE_DESKTOP_WINDOWS_SIGNER_THUMBPRINT")`, the
  analogue of `NESSIE_DESKTOP_SIGNING_TEAM_ID`. The packaged-runtime hash
  manifest stays as the second check.
- **Owner-only state is a DACL.** `state-store.ts` and `daemon-lease.ts`
  prove privacy with POSIX mode bits (`mode & 0o077`) and `process.getuid()`;
  Node reports `0o666`-style modes and no uid on Windows, so they would fail
  closed at first load. On Windows the state directory under
  `%LOCALAPPDATA%\Nessie\executors\<id>` is created with a DACL granting only
  the current user SID (inheritance disabled), and every read verifies that
  DACL through the executor's native helper (`executor/native`), which gains
  a Windows build. Lease liveness uses a process handle
  (`OpenProcess` + `GetExitCodeProcess`), not `kill(pid, 0)`;
  `unowned_daemon_is_stopping` stops returning `true` for any lease file on
  non-Unix, which would otherwise block every start forever.
- **Graceful stop without signals.** `signal_stop` errors on non-Unix. The
  daemon already stops when its parent-liveness stdin closes
  (`waitForExecutorDaemonShutdown`), so the Windows stop closes the pipe,
  waits the same ten seconds, and refuses with the same "will not force-kill"
  message; `TerminateProcess` is never the normal path.
- **Runtime packaging.** `prepare-executor-runtime.mjs` and `runtime.rs`
  assume the Unix layout: the copied binary is named `node` (Windows must run
  `node.exe`), the licence is read from `dirname(process.execPath)/../LICENSE`
  (Windows installs `LICENSE` beside `node.exe`), and `chmod` is a no-op. The
  manifest gains the executable file name and the script resolves the licence
  per platform. The Hyper-V guest artifacts (VHDX, runtime bundle) ship in
  the same resource directory.

### The standalone package — service plus tray

`NessieExecutor_<v>_x64.msi`, signed, installs to
`C:\Program Files\Nessie Executor\` the runtime layout above, the guest
artifacts, and two Nessie binaries:

- **`nessie-executor-service.exe` — the daemon's host.** A Rust Windows
  service ("Nessie Executor", `NessieExecutor`) that runs as the virtual
  service account `NT SERVICE\NessieExecutor` (no password, no interactive
  logon, its own SID), starts automatically at boot, and supervises the Node
  daemon exactly as the desktop does: child process, liveness pipe, ten-second
  graceful stop. `SERVICE_CONTROL_STOP` and `SHUTDOWN` close the pipe and
  report `STOP_PENDING` with a live checkpoint until the daemon exits; the
  service never terminates a daemon with guests still tearing down. The
  installer adds the account to **Hyper-V Administrators**, registers the
  Hyper-V socket service GUID under
  `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Virtualization\GuestCommunicationServices`,
  and creates `%ProgramData%\Nessie Executor\executors\` with a DACL of that
  account plus Administrators. Pairing material and machine keys live there,
  owned by the service, never in a person's profile. Control comes over a
  named pipe `\\.\pipe\NessieExecutor` whose DACL admits Administrators and
  the SID recorded at pairing; its protocol is the companion's five commands
  (status, pair, start, stop, configure) with the same "no path, no secret,
  no output" response rule.
- **`nessie-executor-tray.exe` — the control surface beside the clock.** A
  Tauri `tray-icon` application (Tauri documents full tray support on Windows),
  started at login for the installing user, with no main window. The icon
  states: grey (nothing paired), green (running), amber (awaiting fingerprint
  confirmation or stopping), red (service not running, unsigned or tampered
  runtime, Hyper-V unavailable). Right-click menu: a disabled header line
  *"Nessie Executor — running"*, one line per paired executor with **Start**
  / **Stop**, **Pair a new executor…**, **Open Nessie** (opens
  `https://app.nessie.works/agents/executors` in the default browser),
  **Open logs folder**, **Quit** (quits the tray only; the service keeps
  running, and the menu says so). Left-click opens a small frameless,
  rounded status window in the same custom chrome with the same information
  and buttons. Every mutation repeats in a native confirmation dialog, as the
  desktop companion does; **Pair** prompts for elevation because it grants the
  service account Modify on the chosen workspace root through its ACL, and it
  hands the challenge to the service over the pipe, never through a command
  line. The tray shows executor ids and states only.

How a person uses it: install the MSI (one UAC prompt), the tray icon
appears; in Nessie, **Pair executor** produces an invitation; in the tray,
**Pair a new executor…** → paste the invitation link → choose the workspace →
confirm → confirm the fingerprint in Nessie → the icon turns green. Reboot:
the executor is online before anyone logs in.

### Sandbox backend on Windows

Hyper-V Generation 2 VM per session with Hyper-V sockets, as in the shared
executor contract: host `AF_HYPERV` with the VSOCK template GUID, guest
`AF_VSOCK`, no network adapter, egress only through the daemon's gateway. The
service account creates and destroys the VMs through the Hyper-V WMI
provider. Hyper-V requires Windows 11 Pro, Enterprise, or Education with SLAT
and firmware virtualization; Home edition pairs as `workspace_only`.

## Signed release pipeline

- **What gets signed.** Tauri signs the desktop executable and both
  installers during `tauri build`; the executor MSI, service, and tray
  executables are signed by the same step. Verification is a release gate:
  the workflow runs `Get-AuthenticodeSignature` on every artifact and requires
  `Status = Valid` with the expected signer subject before any is retained.
- **How.** Two supported configurations, one chosen and recorded in
  `docs/running-the-apps.md`:
  1. **Azure Artifact Signing** (formerly Azure Trusted Signing) through
     `bundle.windows.signCommand` — recommended, because no private key is
     ever present on a runner and SmartScreen reputation attaches to the
     managed identity.
  2. An OV/EV certificate through `bundle.windows.certificateThumbprint`,
     `digestAlgorithm: "sha256"`, and `timestampUrl`, with the `.pfx`
     imported from a GitHub secret. EV gives immediate SmartScreen reputation.
  The signer identity is a deployment fact; a build without it is a
  development build and its companion reports `unsigned_release`.
- **Where.** A new `desktop-windows` GitHub Actions workflow on a Windows
  runner: Node 22 (the packaged runtime is the host's Node — same rule as
  Linux), Rust `stable-msvc`, MSVC build tools, the VBSCRIPT optional feature
  for MSI, `cargo test` for the shell, the service, and the tray, `tauri
  build`, the executor MSI, signing, SHA-256 checksums, artifact retention.
- **Smoke on the runner.** Silent-install the desktop app
  (`Nessie_<v>_x64-setup.exe /S`); check `HKCU\Software\Classes\nessie`;
  launch; assert after ten seconds a live process with a main window titled
  "Nessie" and no console; uninstall. Silent-install the executor MSI; assert
  the `NessieExecutor` service is running under its virtual account, the
  ProgramData DACL, and the tray process; uninstall. The Hyper-V conformance
  suite runs on a runner with nested virtualization; a runner without it fails
  the job rather than skipping.

## Delivery phases

1. **Shell parity.** Shared contract items: `desktopPlatform` exposure,
   `DesktopWindowFrame` with `decorations: false` + `shadow: true`, window
   permissions, single instance with `deep-link`, structured companion
   `availability`, platform-aware runtime packaging. Build and run against
   `pnpm dev` on a Windows machine; headless Playwright on
   `http://localhost:5455` proves the web build is unchanged.
2. **Signed release and CI** as above; `docs/running-the-apps.md` replaces
   its two-line Windows section with install, replacement, launch, log
   collection, and signature-verification steps beside the Mac instructions.
3. **Executor platform contract** (shared, phase 3 of the Linux plan).
4. **Desktop enablement.** Authenticode arm, DACL state, process-handle
   liveness, pipe-close stop, `node.exe` packaging. Rust tests cover
   unsupported, unsigned, tampered, pairing, running, stopping, and shutdown;
   the panel keeps showing a clear error and retains no local path, secret,
   or child-process output.
5. **Hyper-V backend.** Generation 2 VM lifecycle over WMI, Hyper-V sockets
   transport, VHDX guest build from the shared kernel + initrd; the conformance
   tests that gate the coding and command profiles on macOS pass on it.
6. **Service and tray.** `nessie-executor-service.exe`, the named-pipe
   control protocol, `nessie-executor-tray.exe`, the MSI with account,
   Hyper-V group, GUID registration, DACLs, and login start.
7. **Release acceptance on a real Windows 11 Pro desktop:**
   1. Install the app; Start shows Nessie; one frameless rounded window with
      Nessie's controls, no console; drag, resize from every edge, double-click
      to maximize (square), restore (round), F11, close.
   2. Sign in through the browser; the window returns authenticated. Start a
      second sign-in with the app open; it completes in the existing window.
   3. Launch again from Start; the existing window is focused.
   4. Enable **Push enabled**; a message from another account produces a
      toast. Record click-to-route and badge results.
   5. **Agents → Executors**: pair this computer through the companion,
      confirm, start, run a file read and a sandboxed command from an agent,
      stop. On Windows 11 Home confirm the `workspace_only` card.
   6. On a second machine with no desktop app install the executor MSI; pair
      from the tray; confirm; reboot; confirm the executor is online before
      login; stop from the tray; quit the tray and confirm the service stays
      up; check the logs folder.
   7. Tamper: replace `node.exe` in Program Files (as Administrator); the
      service refuses to start the daemon, the tray turns red with the reason,
      and the desktop card shows `unsigned_release`.
   8. Deploy a new admin bundle; the window reloads without a reinstall.
   9. Properties → Digital Signatures shows the expected publisher on every
      executable; `Get-AuthenticodeSignature` reports `Valid`.

## Acceptance checklist

- Signed Windows 11 x86_64 NSIS installer (and MSI) opens Nessie from Start
  without a console in a frameless, rounded, shadowed window with Nessie's own
  controls, and points production traffic at `https://app.nessie.works`.
- Authentication returns through `nessie://` to the existing app instance,
  including when the app was already running.
- A running app shows native toasts; click-to-route and badge results are
  recorded in `docs/running-the-apps.md`.
- The desktop app pairs, starts, stops, and reconfigures an executor from
  **Agents → Executors** only on a verified release; unsigned or tampered
  builds refuse before local pairing input is read; Home edition pairs as
  workspace-only and says why.
- The standalone package installs a service under its own virtual account
  and a tray icon; pairing, start, stop, and status work from the tray with
  native confirmations; the executor is online after a reboot with nobody
  logged in; the tray's quit never stops the service.
- CI validates every artifact's signature, runs the Rust tests for shell,
  service, and tray, runs Hyper-V conformance on a nested-virtualization
  runner, and performs the silent install/launch/uninstall smokes.

## Explicit non-goals

- Porting or presenting the legacy SwiftUI voice UI as implicit Windows
  parity.
- Silent local pairing, force-killing a daemon, or storing workspace paths or
  pairing material in the hosted service.
- Executor controls from an unsigned or tampered build; calling a manually
  built unsigned installer a production release.
- Windows 10, ARM64 Windows, or an in-app updater in this release.

## Review and direction changes (2026-09-01)

**Direction changes from Ondrej, applied in this revision:**

- **The executor ships on Windows** as a service (the daemon) with a tray
  icon beside the clock, and the desktop app can enable itself as an executor.
  The earlier revision deferred all of it; its five prerequisites are now the
  executor phases 3–6, with the Hyper-V backend and Hyper-V sockets as the
  sandbox design and Home edition degrading to the workspace bundle.
- **The window is fully custom.** The earlier revision chose the native
  Windows title bar; replaced by the frameless `DesktopWindowFrame` with
  `shadow: true`, which Tauri documents as rounding an undecorated window on
  Windows 11.

**Findings from reviewing the first draft against the code and current
third-party documentation:**

- **Executor parity was treated as a signing task.** The CLI, schema, and
  sandbox backend all refuse or lack Windows; each now has a design.
- **The panel vanished on Windows.** Adopted the `availability` cards.
- **Single instance dropped the sign-in callback.** The plugin's `deep-link`
  feature is required. Added.
- **Click-to-route and the badge were assumed.** Reframed as verified.
- **Runtime packaging is Unix-shaped** (`node` vs `node.exe`, licence path,
  no-op `chmod`). Designed.
- **Graceful stop and state security had no design.** Liveness-pipe stop,
  DACL state, process-handle liveness, and the non-Unix stale-lease deadlock
  are named and fixed in phase 4.
- **Signing method was unspecified.** Two Tauri-supported configurations,
  Azure Artifact Signing recommended, verification as a CI gate.
- **Phase 1's "no visible terminal in development" was a non-issue.** Removed.
- **"CI validates" had no CI.** Named the workflow and its smokes.
