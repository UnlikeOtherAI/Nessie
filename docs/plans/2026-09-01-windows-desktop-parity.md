# Windows desktop parity

**Status:** active  
**Owner:** Desktop  
**Target:** signed Windows x86_64 Tauri release.

## Outcome

The Windows desktop application has parity with the supported macOS Tauri
desktop product: an installable, signed release opens the hosted Nessie
workspace without a console window, completes desktop SSO, receives native
notifications, honours single-instance/deep-link behaviour, and can safely run
the locally paired executor companion from the existing **Admin → Executors**
surface.

The owning surface for local execution is **Admin → Executors → Nessie Desktop
companion**. The new-executor flow and an existing executor's detail panel are
its doorways. A Windows person never has to find a hidden tray command or run a
terminal command to pair, start, stop, or review their local policy.

## Product boundary

Windows is not behind the historical `macos/Nessie` SwiftUI application in the
supported product boundary: that app is a separate legacy local-orchestrator
and voice client. Its microphone, voice WebSocket, and `127.0.0.1:4317`
orchestration design are not implemented by the current cross-platform desktop
shell, including macOS. If those experiences become a product requirement,
they need a separately approved cross-platform service protocol and UI scope.

This plan closes the actual supported parity gap: Windows currently has the
same Tauri workspace shell but the executor companion deliberately permits
only a signed macOS release, and Windows does not have a verified signed
installer/release pipeline.

## Delivery phases

### 1. Reliable Windows development and shell validation

- Make the desktop runtime-preparation path work with a normal Windows Node
  installation and retain the exact Node licence and hash in the package.
- Start the local API/admin and Tauri shell without a visible terminal window.
- Launch the real Windows desktop window and visually check the sign-in and
  workspace states, including the desktop-only companion entry point.
- Preserve the existing Windows `windows_subsystem = "windows"` release
  setting so packaged launches do not flash a console.

### 2. Signed companion support

- Add Windows Authenticode verification for the installed Nessie executable
  and bind it to the expected publisher identity compiled into the release.
  A hash-only check is insufficient because it does not establish release
  provenance.
- Permit executor pairing and daemon lifecycle only after that verification and
  the existing packaged-runtime hash validation both pass.
- Implement a Windows graceful-stop mechanism for a managed executor daemon;
  never use force-kill as the normal shutdown path.
- Cover unsupported, unsigned, tampered, pairing, running, stopping, and
  shutdown conditions in the Rust companion tests. The visible panel must
  continue to show a clear error and retain no local path, secret, or child
  process output.

### 3. Release and operational quality

- Build NSIS and MSI installers on a Windows CI runner, retain artifacts and
  checksums, and sign the executable/installers before publication.
- Install the resulting bundle on Windows and smoke-test launcher start,
  second-launch focus, `nessie://` callback, notification click-through, and
  the Executors panel. The release must not open a terminal window.
- Add a documented, signed update channel only after its key custody and
  rollback behaviour are defined; do not claim an updater because an installer
  exists.
- Document the normal install, replacement, launch, log collection, and
  signature-verification steps in `docs/running-the-apps.md`.

## Acceptance checklist

- A signed Windows x86_64 installer opens Nessie from Start without a console
  window and points production traffic at `https://app.nessie.works`.
- Authentication returns through `nessie://` to the existing app instance.
- Notifications and their click targets behave the same as the macOS Tauri
  application while the process is running.
- **Admin → Executors** lets an authorised person select a local workspace,
  pair, confirm, start, stop, and change local policy only from a verified
  release. Unsigned/tampered builds refuse before local pairing input is read.
- CI validates the signed artifacts and a clean Windows installation, with
  release instructions maintained beside the Mac instructions.

## Explicit non-goals

- Porting or presenting the legacy SwiftUI voice UI as implicit Windows parity.
- Silent local executor pairing, background daemon force-killing, or storing
  workspace paths and pairing material in the hosted service.
- Calling a manually built unsigned NSIS/MSI file a production executor
  release.
