# Linux desktop delivery

**Status:** active — design refined 2026-09-01. This revision replaces the
first draft of the same date; "Review of the first draft" at the end records
what changed and why.
**Owner:** Desktop
**Target:** Ubuntu 26.04 x86_64. `.deb` is the supported install; AppImage is
a portable evaluator artifact.
**Related:** [2026-09-01-windows-desktop-parity.md](2026-09-01-windows-desktop-parity.md)
(adopts the shared shell contract below), [2026-06-07-native-apps-and-push.md](2026-06-07-native-apps-and-push.md)
§"Linux desktop discovery scope", [docs/running-the-apps.md](../running-the-apps.md),
[docs/executor-protocol.md](../executor-protocol.md) §"Desktop-packaged companion".

## Outcome

Nessie is installable and usable as a native Linux desktop application with no
terminal after installation. The app opens the same hosted Nessie workspace as
the macOS desktop product, completes browser sign-in through the `nessie://`
callback, shows native notifications while it runs, and a second launch focuses
the existing window instead of opening another.

The owning surface is the Tauri desktop window. Its doorways are the
application launcher, the `nessie://` sign-in callback, and notification
activation. All of them land in the same entitlement-scoped web workspace;
there is no Linux-only UI fork.

## Shared shell contract — one shell, three presentations

This section is the design for every non-macOS desktop platform. The Windows
plan adopts it by reference rather than restating it.

### The window

- **The admin is the product; the shell is a window around it.** Release
  builds load `https://app.nessie.works` as the top-level document
  (`desktop/src-tauri/src/lib.rs` `desktop_webview_url`); development loads
  the Vite admin at `http://localhost:5455`. Routes, theme tokens, keyboard
  behaviour, and every feature are the hosted admin's. Nothing in this plan
  adds a platform-specific screen.
- **Window chrome follows the operating system.** Tauri's `titleBarStyle` and
  `hiddenTitle` are macOS-only fields ("The style of the macOS title bar" /
  "sets the window title to be hidden on macOS" in `tauri-utils`
  `WindowConfig`). On Linux and Windows the window therefore has the system
  title bar and controls, and the admin top bar is **not** the title bar there.
  Today `TopBar.tsx` keys its chrome on `isDesktopApp()` alone and would render
  a 68 px traffic-light spacer (`.admin-topbar-drag-zone--traffic`) plus drag
  regions on every Tauri runtime — a hole left of the Back button under a
  native title bar. The fix is structural: the desktop init script publishes
  `window.__nessieDesktopPlatform` (`'macos' | 'windows' | 'linux'`, from Rust
  `std::env::consts::OS`), `ShellEnvironmentProvider` carries it as
  `desktopPlatform`, and `TopBar` renders the overlay-title-bar treatment only
  when it is `macos`. Everything else about the top bar is identical.
- **Size and colour are shared:** 1280 × 800 default, 1024 × 700 minimum,
  `#2e1132` window background while the hosted admin loads, no forced OS theme
  (`theme: null`). The content follows the person's Nessie theme; the native
  title bar follows the OS setting. That mismatch is accepted; painting our
  own title bar to hide it is not worth a second window-chrome implementation.

### Sign-in and second launch

- Sign-in hands off to the default browser and returns through
  `nessie://auth/callback`; the always-mounted bridge in
  `ExternalAuthProvider.tsx` finishes the PKCE exchange from the deep link.
  The login screen keeps **Cancel sign-in** for an interrupted hand-off.
- **Single instance carries the deep link.** On Windows and Linux the callback
  URL arrives as the argv of a *second* process; on macOS the OS delivers it to
  the running app. `tauri-plugin-single-instance` supports Linux through D-Bus
  (current release 2.4.4) and exposes a `deep-link` feature that forwards that
  argv to the running instance's `onOpenUrl` listener. Today the plugin is
  compiled only for macOS and Windows and its callback only focuses the window,
  so on Windows a sign-in started while the app is already open focuses the
  window and **drops the callback**. The contract: the plugin is enabled on all
  three desktop targets with `features = ["deep-link"]`, registered first (the
  deep-link plugin docs require that order), and its callback still focuses the
  main window. Snap and Flatpak would additionally need D-Bus `own-name` /
  `talk-name` permissions; they are not targets of this plan.

### Notifications and the badge

- A running app posts OS-native notifications through
  `tauri-plugin-notification` (current release 2.4.0) from the same
  authenticated realtime controller as the web UI; the desktop init script
  (`desktop_notifications_init.js`) owns the bridge and the admin never calls
  the plugin directly. The doorway stays **Settings → Notifications → Push
  enabled** while the desktop app is open.
- **Click-to-route is verified per platform, never assumed.** The plugin's
  desktop backend (`plugins/notification/src/desktop.rs`) builds a
  `notify-rust` notification and shows it; it does not report click or action
  events, and the plugin documents its Actions API as mobile-only. The init
  script's `onAction` handler is therefore inert on a desktop platform until
  the plugin gains that event, at which point it starts working with no admin
  change. The baseline contract on Linux and Windows is: the notification
  appears with the title and body the admin composed and the Nessie icon;
  activating it does whatever the desktop does by default; the person reaches
  the conversation through the alerts bell and unread state, which are already
  authoritative. A platform is allowed to claim click-to-route only after a
  release-build smoke test shows the route opening.
- **The badge is best-effort by construction.** The bridge returns `false` when
  the window API is missing or throws, and nothing in the admin depends on it.
  macOS uses the Dock; other platforms are verified in the release smoke and
  documented as either working or absent.

### The Executors panel on a platform that cannot run a daemon

Rule zero applies to a capability's absence as much as its presence: a person
standing at **Agents → Executors** on Linux must see why the companion is not
offered, not a page that silently lacks it. Today
`ExecutorDesktopCompanionPanel.tsx` calls `executor_companion_status`, which on
a non-macOS release fails inside `runtime_directory` →
`require_release_signature` ("currently supported only on signed macOS
releases"), and the panel answers any error by rendering `null`. On Linux and
Windows it vanishes.

The contract:

- `executor_companion_status` returns a structured
  `{ availability, executors }` instead of failing:
  `availability` is one of `available`, `unsupported_platform`,
  `unsigned_release`, `runtime_missing`, each with a person-readable `reason`
  that names the remedy and carries no local path or secret.
- The panel renders on every desktop platform. When `availability` is not
  `available` it shows one explanatory card in place of the controls — on
  Linux: *"Local executors need Nessie Desktop for macOS 15 or later on Apple
  Silicon. This app can review, approve, and promote executor work, but it
  cannot pair or run a local daemon on Linux."* The card links to the
  companion section of `docs/running-the-apps.md`.
- The CLI pairing block on the same page states the platform requirement in
  its copy, because the packaged CLI refuses every other platform at descriptor
  build (`executor/src/descriptor.ts`) and the server schema pins
  `platform.os = 'macos'`, `architecture = 'arm64'`, `osMajorVersion ≥ 15`
  (`packages/schemas/src/executor.ts`).

### No in-app updater in this release

Product updates do not need a shell release: the shell loads the hosted admin
at runtime, and `desktop_build_freshness_init.js` reloads the window when a
new admin bundle is deployed. A shell release is a reinstall. Tauri's updater
supports AppImage but not `.deb` on Linux and needs a minisign key whose
custody and rollback story are undefined; it is adopted, on both platforms at
once, only after those are written down. Until then the release notes say
"install the new package".

## Linux specifics

### Installation formats

| Artifact | Role | Deep link | Notes |
| --- | --- | --- | --- |
| `.deb` | Supported install for Ubuntu | Registered by the package's `.desktop` entry (`MimeType=x-scheme-handler/nessie`, written by the Tauri bundler from the deep-link config) | Depends on `libwebkit2gtk-4.1-0` and `libgtk-3-0` (bundler defaults). Upgrade by installing the newer package; remove with the package manager. |
| AppImage | Portable evaluator artifact | Registered at launch by the shell | Only when the `APPIMAGE` environment variable is present the shell calls the deep-link plugin's `register_all()` on startup, because the plugin documents that AppImage registration uses the executable's absolute path and is invalidated when the file moves. Moving the file means launching it once before signing in. A `.deb` install never registers at runtime; the package owns the entry. |

Both artifacts are published with SHA-256 checksums. RPM, Flatpak, Snap, AUR,
ARM, and other distributions remain follow-on decisions.

### Executor companion on Linux — not in this release, by decision

Signing is not the only gap, and the first draft implied it was. Three
independent facts keep the companion off Linux:

1. The executor CLI and the server schema accept only macOS 15+ on Apple
   Silicon (above).
2. The sandbox backend is a per-session Linux micro-VM created by
   `Virtualization.framework` through the Swift helper in `executor/vm`, with a
   `linux_arm64` guest (`executor/guest`). Linux has no equivalent in the
   repository; one would be a KVM-backed micro-VM or another approved backend
   with its own protocol-document changes.
3. Linux has no OS-enforced code signature comparable to `codesign` +
   Gatekeeper. A package-embedded signature verified by the package itself is
   self-attestation, so "bound to Nessie's signing identity" needs a real
   design (for example a distribution-signed package plus an OS-held trust
   root), not a hash.

Enabling pairing on Linux therefore requires, in one change: a Linux platform
descriptor in schema, CLI, and API; a Linux sandbox backend; release-integrity
verification with an OS-held trust root; secure private state and graceful
daemon stop (the POSIX paths in `executor/src/state-store.ts` and the
`SIGTERM` stop in `runtime.rs` already work on Linux); and Ubuntu coverage for
install, tamper, pair, start, stop, and shutdown. Until then the Executors
panel explains the absence as described in the shared contract.

### Diagnosable failure modes

`docs/running-the-apps.md` gains a Linux section with these, each with the
command that proves the cause:

- **Package refuses to install** — the apt error names the missing
  `libwebkit2gtk-4.1-0` or `libgtk-3-0` dependency; install it or use
  `apt install ./nessie_<version>_amd64.deb`, which resolves dependencies.
- **Window opens blank or white** — a documented WebKitGTK failure with some
  GPU/driver combinations, especially NVIDIA under Wayland (Tauri "Linux
  Graphics Issues"). The proof and workaround is launching with
  `WEBKIT_DISABLE_DMABUF_RENDERER=1`; `WEBKIT_DISABLE_COMPOSITING_MODE=1` is
  the last resort. The shell does not set these itself: they disable
  acceleration for everyone to fix a subset, and a person who needs them can
  put them in the desktop entry.
- **Sign-in never returns** — `xdg-mime query default x-scheme-handler/nessie`
  must print the Nessie desktop entry; for an AppImage, launch it once from its
  current location.
- **No notifications** — the desktop's notification service must be running
  (`org.freedesktop.Notifications` on the session bus); the app's own log,
  visible when launched from a terminal once, names the D-Bus error.

## Delivery phases

### 1. Shell on Linux

- Compile `tauri-plugin-single-instance` for Linux with
  `features = ["deep-link"]`; keep it the first registered plugin; the callback
  focuses `main`.
- Publish `__nessieDesktopPlatform` from the init script; carry it through
  `ShellEnvironmentProvider`; make the top bar's overlay-title-bar treatment
  conditional on `macos`. Verify with headless Playwright on
  `http://localhost:5455` that the web top bar is byte-identical and that the
  macOS treatment still renders when the platform value is `macos`.
- Register the `nessie` scheme at startup only under `APPIMAGE`.
- Replace the companion status failure with the structured `availability`
  result and render the explanatory card. Cover `unsupported_platform` in the
  Rust companion tests and the card in the admin tests.
- Run `cargo test` in `desktop/src-tauri` on Linux; the existing unit tests
  (`lib.rs`, `executor_companion.rs`) must pass unchanged.
- Drop the first draft's `windows_subsystem` item: `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]`
  is ignored by the compiler on every non-Windows target, so Linux already
  starts normally.

### 2. Build, package, and CI

- Build host prerequisites are Tauri's documented Debian/Ubuntu set:
  `libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev
  libayatana-appindicator3-dev librsvg2-dev`, plus a stable Rust toolchain via
  `rustup`. They stay on the host, not in the repository.
- **The packaged executor runtime is the build host's Node.** `prepare-executor-runtime.mjs`
  copies `process.execPath` into the bundle and targets `node22`; CI runs Node
  22 and the WSL development host currently has Node 20. The Linux build host,
  including the CI runner, pins Node 22 so the package never ships a runtime
  older than its bundle target. The runtime is still packaged on Linux — the
  integrity manifest and its fail-closed checks apply to every platform even
  while the companion is unavailable.
- A new `desktop-linux` GitHub Actions workflow on an Ubuntu runner whose
  WebKitGTK ABI matches the target (build on the oldest Ubuntu the package
  claims to support) runs `cargo test`, `pnpm --filter @nessie/desktop
  tauri:build -- --bundles deb,appimage`, writes SHA-256 checksums, and retains
  both artifacts and logs. There is no desktop job in `ci.yml` today; the
  TestFlight workflow's `turbo run … --filter=@nessie/desktop` runs nothing
  because the package declares no lint/typecheck/test scripts.
- CI installs the produced `.deb` on the runner, checks
  `xdg-mime query default x-scheme-handler/nessie`, launches the app under
  `xvfb-run`, and asserts the process is still alive and owns a window titled
  "Nessie" after ten seconds. That proves install and launch, not appearance.
- Bundle icons: the `.desktop` entry uses the PNGs listed under `bundle.icon`;
  if the launcher renders the 128 px icon blurry on HiDPI, add 256 × 256 and
  512 × 512 PNGs in the same change.

### 3. Release acceptance on a real Ubuntu desktop

WSLg validates development ergonomics only. A release candidate is accepted on
a clean Ubuntu 26.04 x86_64 desktop:

1. Install the `.deb`; the launcher shows Nessie; opening it shows one window
   with the native title bar, the admin top bar without a traffic-light gap,
   and the login screen.
2. Sign in through the browser; the window returns to the authenticated
   workspace. Start a second sign-in with the app open; it completes in the
   existing window.
3. Launch Nessie a second time from the launcher; the existing window is
   focused and no second window appears.
4. Enable **Push enabled**; a message from another account produces a native
   notification with the composed title and body. Record whether activation
   opens the route; document the result.
5. Open **Agents → Executors**; the companion card explains the Linux
   limitation; the rest of the page works.
6. Deploy a new admin bundle (or simulate one); the window reloads within the
   freshness interval without a reinstall.
7. Repeat 1–3 with the AppImage from `~/Downloads`, then move it and confirm
   sign-in works after one launch from the new location.

## Acceptance checklist

- CI produces Ubuntu x86_64 `.deb` and AppImage artifacts with retained logs
  and SHA-256 checksums, from a build that ran the shell's Rust tests.
- On Ubuntu, the installed launcher opens one usable Nessie window; a second
  launch focuses it instead of opening another window; the window chrome is
  the system title bar and the admin top bar has no macOS spacer.
- Browser SSO returns through `nessie://` to the existing authenticated app,
  including when the app is already running.
- A running app shows a native notification for a new message; the
  click-to-route result is recorded in `docs/running-the-apps.md`.
- **Agents → Executors** shows the explanatory companion card on Linux.
- The production app points only at `https://app.nessie.works`; development
  continues to use the localhost Vite/API pair.
- `docs/running-the-apps.md` documents install, upgrade, removal, and the four
  diagnosable failure modes above.

## Explicit non-goals

- Porting the historical `macos/Nessie` SwiftUI voice and local-orchestrator
  client. It is not the supported desktop product contract.
- Treating WSLg as customer-install validation.
- Shipping an executor companion on Linux, signed or not, before the four
  prerequisites above land together.
- Snap, Flatpak, RPM, AUR, ARM, or an in-app updater in this release.

## Review of the first draft (2026-09-01)

What the code and current third-party documentation showed, and what changed:

- **Executor absence was framed as a signing gap.** It is three gaps: the CLI
  and schema pin macOS/arm64/15+, the sandbox is Virtualization.framework, and
  Linux has no OS-held code-signing trust root. Rewritten as a decision with
  the full prerequisite list.
- **The panel vanished instead of explaining.** The first draft asked for "an
  Executor-page explanation" only as a future pairing prerequisite; Rule zero
  makes it part of *this* release. Added the structured `availability` result.
- **Window chrome was not designed.** `titleBarStyle`/`hiddenTitle` are
  macOS-only, and the top bar keys on `isDesktopApp()` alone. Added the
  platform-exposure contract.
- **Single instance would drop the sign-in callback.** The plugin's
  `deep-link` feature is required on argv-delivering platforms. Added.
- **Click-to-route was an assumption.** The plugin's desktop backend reports no
  click events. Reframed as verified-per-platform with a stated baseline.
- **AppImage sign-in was undecided.** Added `register_all()` under `APPIMAGE`
  and documented the move caveat from the plugin docs.
- **The `windows_subsystem` item was a no-op.** Removed.
- **Node version of the packaged runtime was unpinned.** The script copies the
  host's Node; the WSL host is on 20 and the bundle targets 22. Pinned to 22.
- **"CI produces" had no CI.** Named the missing workflow, its runner
  constraint, and the install/launch smoke it runs.
- **Updater was unaddressed.** Decided: none in this release, shared with the
  Windows plan, with the reason the product still updates.
