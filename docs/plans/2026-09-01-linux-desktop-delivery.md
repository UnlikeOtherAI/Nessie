# Linux desktop delivery

**Status:** active — shell parity implemented; physical Ubuntu acceptance remains
**Owner:** Desktop  
**Target:** Ubuntu 26.04 x86_64 first; other distributions follow the same Tauri shell contract.

## Outcome

Nessie is installable and usable as a native Linux desktop application, without
requiring a terminal after installation. The app opens the same hosted Nessie
workspace as the supported desktop product, accepts the `nessie://` sign-in
callback, delivers native notifications while running, and starts a second
launch by focusing the existing window.

The owning surface is the Tauri desktop window. Its doorways are the desktop
launcher, `nessie://` authentication callback, and notification activation;
all lead to the same entitlement-aware web workspace rather than a Linux-only
UI fork.

## Current baseline

- The shared Tauri shell already owns the web workspace, desktop deep links,
  notifications, and the local executor companion IPC.
- Linux and Windows now share one route-independent custom frame, including the
  pre-authentication screens, and the single-instance integration forwards SSO
  callback arguments into the running deep-link listener on both platforms.
- A provider-discovery failure renders a retry action rather than an indefinite
  loading message. Development builds and AppImages register their handler at
  runtime; the Debian package owns its installed association.
- The executor companion intentionally refuses Linux release builds.
- Ubuntu is available through WSLg for development and window smoke tests. A
  real Ubuntu desktop remains required before calling the packaged install path
  supported for customers.
- WSLg cannot own a Windows browser's `nessie://` callback. The Linux login
  screen therefore exposes the existing, validated session-import surface as
  **Use Windows session**; it accepts only a same-server short-lived access
  token copied from **Account → Debug** in the signed-in Windows app. Native
  Linux browsers continue to use the normal callback registration.

## Delivery phases

### 1. Native shell parity

- Enable the existing Tauri shell on Linux x86_64 and package `.deb` and
  AppImage artifacts.
- Include Linux in the single-instance handling and verify that a duplicate
  launch focuses the original window and delivers its deep-link payload.
- Register `nessie://`, complete desktop SSO from the default browser, and
  verify notification click-through reaches the intended conversation.
- Keep `windows_subsystem = "windows"` Windows-only so Linux starts normally
  without an unwanted console-management workaround.

### 2. Build and install contract

- Document the exact Ubuntu prerequisites (Rust, Node/pnpm, WebKitGTK and
  related Tauri packages) and provide a CI build on an Ubuntu runner.
- Retain both package formats: `.deb` is the supported Ubuntu installation;
  AppImage is a portable evaluator artifact. Publish checksums with both.
- Build the executor runtime through the existing packaging script, including
  its Node binary, licence and hashes. A package must fail closed when any of
  those resources are absent or altered.
- Install the generated `.deb` on Ubuntu, launch it from the application
  launcher, and verify no terminal remains open. Launch and visual inspection
  are release acceptance criteria, not merely build success.

### 3. Local executor decision

Linux must not advertise executor controls until release-integrity verification
is designed for Linux. The immediate Linux release may provide the desktop
workspace, SSO, deep links, and notifications with the Executor page's native
companion panel unavailable. Enabling pairing later requires all of the
following in one change:

- a Linux release-signing and verification design bound to Nessie's signing
  identity, not just a file hash;
- secure private state storage and graceful daemon stop semantics on Linux;
- an Executor-page explanation and actionable alternate path for a person who
  is standing at the panel; and
- package-install, tamper, pair, start, stop, and shutdown coverage on Ubuntu.

## Acceptance checklist

- CI produces reproducible Ubuntu x86_64 `.deb` and AppImage artifacts with
  retained logs and checksums.
- On Ubuntu, the installed launcher opens one usable Nessie window; a second
  launch focuses it instead of opening another window.
- Browser SSO returns through `nessie://` to the existing authenticated app.
- A running app requests notification permission, shows a test notification,
  and notification activation opens its target route.
- The production app points only to `https://app.nessie.works`; development
  continues to use the localhost Vite/API pair.
- The release path is documented in `docs/running-the-apps.md`, including how
  to install, upgrade, remove, and diagnose missing WebKitGTK dependencies.

## Explicit non-goals

- Porting the historical `macos/Nessie` SwiftUI voice and local-orchestrator
  client. It is not the supported desktop product contract.
- Treating WSLg as customer-install validation.
- Shipping an unsigned executor companion just because Linux can run its
  packaged executable.
