# Linux desktop delivery

**Status:** active — design refined 2026-09-01, then re-scoped the same day
on Ondrej's direction: the executor ships on Linux (standalone daemon and
desktop enablement), and the window is fully custom chrome, not the native
frame. "Review and direction changes" at the end records every revision.
**Owner:** Desktop
**Target:** Ubuntu 26.04 x86_64. `.deb` is the supported install; AppImage is
a portable evaluator artifact for the shell only.
**Related:** [2026-09-01-windows-desktop-parity.md](2026-09-01-windows-desktop-parity.md)
(adopts the shared contracts below), [2026-06-07-native-apps-and-push.md](2026-06-07-native-apps-and-push.md)
§"Linux desktop discovery scope", [docs/running-the-apps/overview.md](../running-the-apps/overview.md),
[docs/executor-protocol/overview.md](../executor-protocol/overview.md).

## Outcome

Nessie is installable and usable as a native Linux desktop application with no
terminal after installation. The app opens the same hosted Nessie workspace as
the macOS desktop product inside a window that is entirely Nessie's design,
completes browser sign-in through the `nessie://` callback, shows native
notifications while it runs, and a second launch focuses the existing window.

A Linux machine can also be an **executor**, in either of two shapes:

- **The desktop app, enabled on request.** From **Agents → Executors** a
  person pairs this computer exactly as on macOS: native folder picker, native
  confirmations, a daemon supervised by the running app.
- **A standalone daemon** for computers without the desktop app: the
  `nessie-executor` command-line package, run as a systemd user service that
  starts at boot and survives logout.

The owning surfaces are the Tauri window and, for the standalone daemon, the
`nessie-executor` command; the doorways are the launcher, the `nessie://`
callback, notification activation, and the **Agents → Executors** page, which
is where every pairing starts and where every executor's state is read.

## Shared shell contract — one shell, three presentations

This section is the design for every desktop platform. The Windows plan
adopts it by reference rather than restating it.

### The window — fully custom chrome

Decision (Ondrej, 2026-09-01): the Linux and Windows apps must not look like a
basic native application. No OS title bar, no OS border, rounded corners, and
edge-to-edge Nessie design. macOS already has this through the overlay title
bar with traffic lights and the OS's own rounded corners; it is unchanged.

- **The admin is the product; the shell is a frame around it.** Release
  builds load `https://app.nessie.works` as the top-level document
  (`desktop/src-tauri/src/lib.rs` `desktop_webview_url`); development loads
  the Vite admin at `http://localhost:5455`. Routes, theme tokens, keyboard
  behaviour, and every feature are the hosted admin's. The frame is the only
  platform-specific presentation, and it is one component.
- **Frameless on Windows and Linux.** `titleBarStyle`/`hiddenTitle` are
  macOS-only fields (their `WindowConfig` doc comments say "the macOS title
  bar" / "hidden on macOS"), so both other platforms use `decorations: false`.
  - Windows: `shadow: true`. Tauri's config documents that for an undecorated
    window this gives "a 1px white border, and on Windows 11, it will have a
    rounded corners" with the OS shadow. Windows 10 is supported with the same
    custom chrome and square corners: its window manager never rounds a
    top-level window, and Microsoft documents the per-pixel-alpha alternative
    as forfeiting the system shadow. The window is not transparent on either
    version; the OS decides the corner shape (Windows plan).
  - Linux: `transparent: true`, because Tauri documents `shadow` as
    "Unsupported" on Linux and an undecorated GTK window has square corners.
    The admin paints a 12 px radius on the app root and a soft shadow inside
    a transparent margin. This needs a compositing window manager; Ubuntu's
    GNOME always composites. Maximized and fullscreen windows drop the radius
    and the margin.
- **`DesktopWindowFrame` is the one frame component.** It mounts at the admin
  root — above the router, so the login screen has it too — when
  `desktopPlatform` is `windows` or `linux`, and renders: a top drag strip
  (`data-tauri-drag-region`, which Tauri applies only to the element carrying
  it, so interactive children stay clickable); window controls at the top
  right — minimize, maximize/restore, close — through the Tauri window API
  with the `core:window:allow-minimize`, `allow-toggle-maximize`, and
  `allow-close` permissions added to both capability files; double-click on
  the drag strip toggles maximize; and 8 px invisible resize handles on the
  edges and corners that call `startResizeDragging` (its permission is
  already granted), because an undecorated window has no OS resize border.
  `TopBar.tsx` keeps its drag zones and loses the macOS-only 68 px
  traffic-light spacer off macOS. Accepted trade-off: Windows 11's snap-layout
  flyout does not appear over a custom maximize button; Win+Arrow snapping
  still works.
- **Platform reaches the admin structurally.** The desktop init script
  publishes `window.__nessieDesktopPlatform` (`'macos' | 'windows' | 'linux'`,
  from Rust `std::env::consts::OS`); `ShellEnvironmentProvider` carries it as
  `desktopPlatform`. Nothing reads the user agent.
- **Fullscreen** toggles with F11 (`core:window:allow-set-fullscreen`) and is
  edge-to-edge with no frame.
- **Size and colour are shared:** 1280 × 800 default, 1024 × 700 minimum,
  `#2e1132` behind the document while the hosted admin loads (on Linux this is
  the app root's own background, since the window itself is transparent).
  Tauri merges `tauri.<platform>.conf.json` with JSON Merge Patch, and a
  patched array replaces the base array, so each platform file restates the
  complete `main` window; a Rust unit test (`shell.rs`) fails if the shared
  half of those three statements drifts.

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
  authoritative. A platform may claim click-to-route only after a release-build
  smoke test shows the route opening.
- **The badge is best-effort by construction.** The bridge returns `false` when
  the window API is missing or throws, and nothing in the admin depends on it.
  macOS uses the Dock; other platforms are verified in the release smoke and
  documented as working or absent.

### The Executors page tells the truth about this device

Rule zero applies to a capability's absence as much as its presence. Today
`ExecutorDesktopCompanionPanel.tsx` calls `executor_companion_status`, which
on a non-macOS release fails inside `runtime_directory` →
`require_release_signature`, and the panel answers any error by rendering
`null`. On Linux and Windows it vanishes.

The contract:

- `executor_companion_status` returns `{ availability, reason, executors }`
  instead of failing. `availability` is one of `available`,
  `workspace_only` (this device can pair but has no virtualization, so only
  the COW workspace bundle can be offered), `unsigned_release`,
  `runtime_missing`, `unsupported_platform`; `reason` is person-readable,
  names the remedy, and carries no local path or secret.
- The panel renders on every desktop platform. `available` shows the controls
  as today; every other state shows one card in their place with the reason
  and the remedy — for `workspace_only` on Linux: *"This computer can pair as
  an executor for file review and drafts. Sandboxed commands, browsers and
  coding sessions need virtualization: add your user to the `kvm` group and
  sign in again."*
- Executors paired by a standalone daemon appear in the page's list like any
  other; the descriptor's new `supervisor` fact (`desktop` or `service`) and
  `platform` let the detail panel say *"Nessie Executor service on Linux"* and
  point at the command-line controls instead of offering desktop buttons it
  cannot press.
- The CLI pairing block on the page is the doorway for the standalone daemon
  and states the supported platforms.

### No in-app updater in this release

Product updates do not need a shell release: the shell loads the hosted admin
at runtime, and `desktop_build_freshness_init.js` reloads the window when a
new admin bundle is deployed. A shell release is a reinstall. Tauri's updater
supports AppImage but not `.deb` on Linux and needs a minisign key whose
custody and rollback story are undefined; it is adopted, on both platforms at
once, only after those are written down.

## Shared executor contract — the same executor, three hosts

Everything below applies to Linux and Windows alike; the Windows plan adds its
service and tray specifics.

### Two supervisors, one executor id each

| Supervisor | Where it runs | Lifetime | Controls |
| --- | --- | --- | --- |
| `desktop` | The Nessie desktop app, as today on macOS: packaged runtime, native folder picker, native confirmations, daemon as a child with the parent-liveness pipe | While the app runs | **Agents → Executors** companion panel |
| `service` | The standalone `nessie-executor` package | Boot to shutdown, independent of login | Linux: the `nessie-executor` command and systemd; Windows: the service and its tray app |

An executor id has exactly one supervisor; the daemon lease already refuses a
second daemon for the same state directory, and the two supervisors use
different state roots, so they cannot collide by accident. The descriptor
gains `supervisor` so the server and the page know which controls apply.

### Platform contract

`ExecutorCapabilityDescriptorSchema.platform` widens from the macOS literals
to `{ os: 'macos' | 'linux' | 'windows', architecture: 'arm64' | 'x64',
osMajorVersion }` with per-OS minimums (macOS 15; Linux kernel major 5 —
the descriptor carries only the major, and the packaged guest artifacts
require 5.10; Windows build 19045, Windows 10 22H2, because Windows 10 is a
supported target). Descriptors gain `supervisor` and `sandboxBackend`; the
protocol version stays 1 because the new required facts already make the two
grammars mutually exclusive, so an executor paired before the change fails
closed until `nessie-executor configure` proposes a new revision — no upgrade
shim, by decision (`docs/executor-protocol/overview.md` §4.5).
`executor/src/descriptor.ts` builds it per host, the API
keeps refusing anything outside the enum, and the Go guest gains `linux/amd64`
builds beside today's `linux_arm64` files (`executor/guest`). This is one
contract change across schema, CLI, and API.

### Sandbox backend per host

The macOS backend is a per-session Linux micro-VM under
`Virtualization.framework` (`executor/vm`). The guest protocol — kernel +
initrd boot, a vsock control channel, no network device, all egress through
the daemon's forced gateway — is what the new backends reproduce.

| Host | Backend | Why | Transport |
| --- | --- | --- | --- |
| Linux | **Firecracker** micro-VM per session, under its `jailer`, run as the daemon's user | KVM-based, supports x86_64 and aarch64, boots a kernel with an `initrd_path`, and implements virtio-vsock by bridging guest `AF_VSOCK` ports to host Unix sockets — so the guest stays byte-identical to macOS and the daemon adds a Unix-socket transport beside its vsock one | Unix socket ↔ `AF_VSOCK`; no TAP device is ever created |
| Windows | **Hyper-V** Generation 2 VM per session | Hyper-V sockets: host `AF_HYPERV` with the VSOCK template service GUID, guest `AF_VSOCK` unchanged (guest kernel needs `CONFIG_HYPERV_VSOCKETS`). Generation 2 boots UEFI, so the guest ships as a VHDX built from the same kernel + initrd; no network adapter | `AF_HYPERV` ↔ `AF_VSOCK` |

Firecracker requires read/write access to `/dev/kvm`; Hyper-V is available
only on Windows 11 Pro, Enterprise, or Education with SLAT and firmware
virtualization enabled. **A host without virtualization still pairs**, and
advertises only the COW workspace bundle (`file.list`, `file.read`,
`file.write`, `workspace.review`, `sandbox.stop`) — the same bundle the
desktop policy editor already controls and the only one that needs no guest.
The availability card and the descriptor's `profiles` say so, and the remedy
is named (`kvm` group; enable Hyper-V). Nothing pretends a sandbox exists.

### Release integrity per host — an OS-held trust root, never a self-check

macOS binds executor controls to `codesign` and a pinned Developer ID team.
The equivalents:

- **Linux:** the `.deb` (desktop app and standalone package alike) is served
  from an apt repository signed with Nessie's release key; apt verifies the
  signature at install and dpkg installs root-owned files. At runtime the
  companion and the daemon require every packaged runtime file to be owned by
  root and not group- or world-writable, in addition to today's hash manifest.
  Only an administrator can produce that state, which is what makes it a trust
  root rather than a self-attestation. A user-writable copy — an AppImage, a
  build in a home directory — passes the shell but never gets executor
  controls, exactly like an ad-hoc-signed macOS build.
- **Windows:** Authenticode on every executable, verified in-process and
  pinned to the release's publisher (Windows plan).

### Private state and graceful stop per host

- **Linux:** `executor/src/state-store.ts` and `daemon-lease.ts` already prove
  privacy with POSIX ownership and mode bits, and `runtime.rs` already stops a
  daemon with `SIGTERM` and checks liveness with `kill(pid, 0)`. All of it
  works on Linux unchanged. State roots: `~/.local/state/nessie-executor/<id>`
  for the service supervisor; the app data directory Tauri already derives for
  the desktop supervisor.
- **Windows:** owner-only state is a DACL, not mode bits, and stop is the
  liveness pipe, not a signal (Windows plan).

## Linux specifics

### Installation formats

| Artifact | Role | Deep link | Executor |
| --- | --- | --- | --- |
| `nessie_<v>_amd64.deb` | Supported desktop install | Registered by the package's `.desktop` entry (`MimeType=x-scheme-handler/nessie`, written by the Tauri bundler) | Desktop supervisor available (root-owned runtime) |
| `Nessie_<v>_amd64.AppImage` | Portable shell for evaluation | Registered at launch: only when `APPIMAGE` is set the shell calls `register_all()`, because the plugin documents that AppImage registration uses the executable's absolute path and is invalidated when the file moves; moving it means launching once before signing in | Never — user-writable file, `unsigned_release` card |
| `nessie-executor_<v>_amd64.deb` | Standalone daemon for computers without the desktop app | — | Service supervisor |

All artifacts come with SHA-256 checksums and are published through the
signed apt repository (the AppImage is a direct download). Desktop `.deb`
depends on `libwebkit2gtk-4.1-0` and `libgtk-3-0` (bundler defaults). RPM,
Flatpak, Snap, AUR, ARM, and other distributions remain follow-on decisions.

### The standalone daemon — `nessie-executor` on Linux

The package installs the same runtime layout the desktop bundles
(`/usr/lib/nessie-executor/{node,nessie-executor.cjs,manifest.json,NODE_LICENSE}`
produced by the same `prepare-executor-runtime.mjs`, plus the Firecracker
binary, its jailer, and the guest kernel/initrd/runtime bundle), a
`/usr/bin/nessie-executor` launcher, and a systemd user unit template
`nessie-executor@.service` whose `ExecStart` is
`/usr/bin/nessie-executor serve --state-dir %h/.local/state/nessie-executor/%i`.

How a person uses it, all from the Executors page's CLI block:

1. **Pair.** `nessie-executor pair --api https://api.nessie.works --enrollment <id> --challenge <token> --state-dir ~/.local/state/nessie-executor/<executorId> --workspace /path` — the existing command; the block on the page already renders it.
2. **Confirm** the fingerprint in Nessie, as today.
3. **Enable.** `nessie-executor enable <executorId>` runs
   `systemctl --user enable --now nessie-executor@<executorId>` and, after
   printing exactly what it means, `loginctl enable-linger` — systemd's own
   description: "a user manager is spawned for the user at boot and kept
   around after logouts", which is what makes the daemon a daemon. The command
   refuses to enable a state directory whose runtime fails the root-ownership
   or manifest check.
4. **Operate.** `nessie-executor status`, `disable <executorId>`; logs with
   `journalctl --user -u nessie-executor@<executorId>`. `systemctl --user stop`
   sends `SIGTERM`, which is the existing graceful path; the unit's
   `TimeoutStopSec` matches the daemon's own ten-second teardown budget and
   never escalates to `SIGKILL` while guests are tearing down
   (`KillMode=mixed` is not used).

`configure`, `configure-browser`, and `configure-codex` keep their existing
contracts; the browser and coding profiles require the Firecracker artifacts
the package installs and are refused without `/dev/kvm` access.

### The desktop app as an executor on Linux

Identical to macOS from the person's side: **Agents → Executors → Pair
executor → Choose workspace and pair this computer** (the button copy stops
saying "this Mac"), native folder picker, native confirmation, fingerprint
confirmation in Nessie, **Start daemon**. `require_release_signature` gains a
Linux arm that performs the root-ownership check; the packaged runtime and
Firecracker artifacts live under the app's resource directory in
`/usr/lib/Nessie`. The daemon runs while the app runs; a person who wants it
to outlive the app installs the standalone package instead, and the page says
so on the card.

### Diagnosable failure modes

`docs/running-the-apps/overview.md` gains a Linux section with these, each with the
command that proves the cause:

- **Package refuses to install** — the apt error names the missing
  `libwebkit2gtk-4.1-0` or `libgtk-3-0`; `apt install ./nessie_<v>_amd64.deb`
  resolves dependencies.
- **Window opens blank or white** — a documented WebKitGTK failure with some
  GPU/driver combinations, especially NVIDIA under Wayland (Tauri "Linux
  Graphics Issues"). Proof and workaround: launch with
  `WEBKIT_DISABLE_DMABUF_RENDERER=1`; `WEBKIT_DISABLE_COMPOSITING_MODE=1` is
  the last resort. The shell does not set these itself.
- **Window has square corners or a black margin** — no compositor is running;
  the frame needs one. Ubuntu GNOME always composites; other sessions are not
  supported targets.
- **Sign-in never returns** — `xdg-mime query default x-scheme-handler/nessie`
  must print the Nessie desktop entry; for an AppImage, launch it once from its
  current location.
- **No notifications** — the session's `org.freedesktop.Notifications` service
  must be running; the app's own log, visible when launched from a terminal
  once, names the D-Bus error.
- **Executor shows "workspace only"** — `ls -l /dev/kvm` and `id` show whether
  the user is in the `kvm` group; log out and in after adding.
- **Executor controls unavailable in the desktop app** — the app was not
  installed from the package: `stat /usr/lib/Nessie/executor-runtime/node`
  must show root ownership.

## Delivery phases

### 1. Shell on Linux

- Compile `tauri-plugin-single-instance` for Linux with
  `features = ["deep-link"]`; keep it the first registered plugin; the callback
  focuses `main`.
- Publish `__nessieDesktopPlatform`; carry it through `ShellEnvironmentProvider`.
- Build `DesktopWindowFrame` (drag strip, controls, resize handles, radius,
  shadow margin, maximized/fullscreen handling), add the window permissions,
  set `decorations: false` + `transparent: true` for Linux and
  `decorations: false` + `shadow: true` for Windows in `tauri.conf.json`
  (platform-keyed through Tauri's per-platform config files), and remove the
  macOS-only spacer from `TopBar.tsx` off macOS. Headless Playwright on
  `http://localhost:5455` proves the web build is unchanged and that the
  frame renders when the platform value is injected.
- Register the `nessie` scheme at startup only under `APPIMAGE`.
- Replace the companion status failure with the structured `availability`
  result and render the cards. Cover every state in the Rust companion tests
  and the admin tests.
- Run `cargo test` in `desktop/src-tauri` on Linux; existing tests pass
  unchanged.

### 2. Build, package, and CI

- Build host prerequisites are Tauri's documented Debian/Ubuntu set:
  `libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev
  libayatana-appindicator3-dev librsvg2-dev`, plus a stable Rust toolchain via
  `rustup`. They stay on the host, not in the repository.
- **The packaged executor runtime is the build host's Node.**
  `prepare-executor-runtime.mjs` copies `process.execPath` and targets
  `node22`; CI runs Node 22 and the WSL development host has Node 20. Every
  build host pins Node 22.
- A new `desktop-linux` GitHub Actions workflow on an Ubuntu runner whose
  WebKitGTK ABI matches the target runs `cargo test`,
  `tauri:build -- --bundles deb,appimage`, builds `nessie-executor_<v>_amd64.deb`,
  writes SHA-256 checksums, signs the apt repository metadata, and retains
  artifacts and logs. There is no desktop job in `ci.yml` today.
- CI installs both `.deb` files on the runner, checks
  `xdg-mime query default x-scheme-handler/nessie`, checks root ownership of
  `/usr/lib/Nessie/executor-runtime` and `/usr/lib/nessie-executor`, launches
  the app under `xvfb-run`, and asserts the process is alive with a window
  titled "Nessie" after ten seconds. Appearance is checked by a person.
- Bundle icons: if the launcher renders the 128 px icon blurry on HiDPI, add
  256 × 256 and 512 × 512 PNGs in the same change.

### 3. Executor platform contract

Schema, CLI, and API accept Linux and Windows platforms and the `supervisor`
fact; the Go guest builds for `linux/amd64`; `descriptor.ts` reports the real
host and, when virtualization is absent, restricts `profiles` to the workspace
bundle. Contract tests cover an unknown platform being refused and a
workspace-only descriptor being accepted.

### 4. Firecracker backend

A `LinuxMicroVmBackend` beside the macOS one: Firecracker under its jailer,
initrd boot (`CONFIG_BLK_DEV_INITRD`, `switch_root` not `pivot_root` per
Firecracker's initrd docs), vsock bridged over the Unix socket path, no
network device, egress only through the daemon's gateway. The conformance
tests that gate the coding and command profiles on macOS run against it on a
KVM-capable Linux runner; a runner without KVM must fail the job, not skip it.

**Landed.** The fork the phrase "beside the macOS one" invited was avoided:
spawning moved behind one `GuestVmBackend` seam
(`executor/src/guest-vm-backend.ts`) chosen from the descriptor's own
`sandboxBackend`, with `virtualization_framework` keeping today's argv exactly
and `executor/src/firecracker/` implementing the jailer, the four-call API
sequence, the two guest-initiated vsock channels, graceful stop, and chroot
cleanup. The guest builds for `linux/amd64` as well as `linux/arm64` — nothing
in it was arch-specific, so the `_linux_arm64.go` files became `_linux.go` and
`AF_VSOCK` is declared once (Go's syscall tables omit it on amd64). The
standalone `.deb` ships Firecracker and its jailer pinned by version and by the
upstream published SHA-256, plus the amd64 guest, with a `resources/manifest.json`
of digests. `firecracker-conformance` in `.github/workflows/desktop-linux.yml`
runs the backend suites on `[self-hosted, linux, kvm]` and fails when
`/dev/kvm` is absent. Contract: `docs/executor-protocol/overview.md` §8 → "Linux
backend — Firecracker".

**Two design statements did not survive contact.** First, the table above says
the guest "stays byte-identical to macOS", and it does for boot, control, and
egress — but *not* for the filesystem: the guest mounts `/work` and `/runtime`
as **virtiofs**, and Firecracker implements no virtio-fs device. Both shares
must be re-expressed (block devices are the obvious candidate) before a Linux
guest can actually boot with a workspace, and that change reaches the guest,
`sandbox-workspace.ts`, and the workspace-review read-back together. Second,
the plan assumed the daemon could run the jailer; Firecracker documents the
jailer as running **as root**, so the backend refuses at session start when it
is not, and the standalone package's supervisor has to supply that privilege.

### 5. Standalone package and desktop enablement

The `nessie-executor` `.deb`, the systemd unit template, the `enable` /
`disable` / `status` commands, the root-ownership check in both supervisors,
and the "this computer" copy in the companion panel.

### 6. Release acceptance on a real Ubuntu desktop

WSLg validates development ergonomics only. A release candidate is accepted on
a clean Ubuntu 26.04 x86_64 desktop with KVM:

1. Install the desktop `.deb`; the launcher shows Nessie; opening it shows one
   frameless window with rounded corners, a shadow, Nessie's own controls, and
   the login screen. Drag, resize from every edge, double-click to maximize
   (corners square), restore (corners round), F11 fullscreen, close.
2. Sign in through the browser; the window returns authenticated. Start a
   second sign-in with the app open; it completes in the existing window.
3. Launch Nessie again; the existing window is focused, no second window.
4. Enable **Push enabled**; a message from another account produces a native
   notification. Record whether activation opens the route.
5. **Agents → Executors**: pair this computer through the companion, confirm
   the fingerprint, start the daemon, run a file read and a sandboxed command
   from an agent, stop the daemon. Repeat on a machine without `kvm` group
   membership and confirm the `workspace_only` card and the descriptor.
6. On a second Ubuntu machine with no desktop app, install
   `nessie-executor`, pair, confirm, `enable`, reboot, and confirm the
   executor is online before anyone logs in; `disable`; check the journal.
7. Tamper: replace `/usr/lib/nessie-executor/node` with a user-owned copy;
   `enable` refuses and the desktop card shows `unsigned_release`.
8. Deploy a new admin bundle; the window reloads without a reinstall.
9. Repeat 1–3 with the AppImage from `~/Downloads`, move it, and confirm
   sign-in after one launch from the new location; confirm its Executors card
   says executor controls need the package install.

## Acceptance checklist

- CI produces the desktop `.deb`, the AppImage, and the `nessie-executor`
  `.deb` with checksums and signed repository metadata, from a build that ran
  the shell's Rust tests and the executor's Firecracker conformance on KVM.
- On Ubuntu the installed launcher opens one frameless, rounded, shadowed
  window with Nessie's own controls; drag, resize, maximize, fullscreen, and
  close all work; a second launch focuses it.
- Browser SSO returns through `nessie://` to the existing authenticated app,
  including when the app is already running.
- A running app shows a native notification for a new message; the
  click-to-route result is recorded in `docs/running-the-apps/overview.md`.
- The desktop app pairs, starts, stops, and reconfigures an executor on
  Linux from **Agents → Executors** with the same native confirmations as
  macOS; a host without KVM pairs as workspace-only and says so.
- The standalone daemon pairs from the command line, enables as a lingering
  systemd user service, is online after a reboot with nobody logged in, and
  stops gracefully.
- A user-writable runtime is refused by both supervisors.
- `docs/running-the-apps/overview.md` documents install, upgrade, removal, the
  standalone daemon's commands, and the seven diagnosable failure modes.

## Explicit non-goals

- Porting the historical `macos/Nessie` SwiftUI voice and local-orchestrator
  client. It is not the supported desktop product contract.
- Treating WSLg as customer-install validation.
- Executor controls from an AppImage or any user-writable install.
- A Linux tray application; the command line and systemd are the Linux
  control surface (Tauri documents tray events as unsupported on Linux, and
  nobody asked for one).
- Snap, Flatpak, RPM, AUR, ARM, or an in-app updater in this release.

## Review and direction changes (2026-09-01)

**Direction changes from Ondrej, applied in this revision:**

- **The executor ships on Linux.** The earlier revision deferred it behind
  prerequisites; they are now the executor phases 3–5: platform contract,
  Firecracker backend, standalone package with systemd, desktop enablement,
  root-ownership trust root. A host without KVM degrades to the workspace
  bundle rather than refusing.
- **The window is fully custom.** The earlier revision chose the native
  title bar off macOS; replaced by the frameless `DesktopWindowFrame` design
  (no borders, rounded corners, Nessie's own controls), with the Tauri
  platform facts that shape it (Windows `shadow: true` rounding on Windows 11
  and square corners on Windows 10; Linux transparent window + painted
  corners, no OS shadow).

**Findings from reviewing the first draft against the code and current
third-party documentation:**

- **Executor absence was framed as a signing gap.** It is three gaps — the
  CLI and schema pin macOS/arm64/15+, the sandbox is Virtualization.framework,
  and Linux has no OS-held code-signing trust root — each now has a design.
- **The panel vanished instead of explaining.** Added the structured
  `availability` result and cards.
- **Single instance would drop the sign-in callback.** The plugin's
  `deep-link` feature is required on argv-delivering platforms. Added.
- **Click-to-route was an assumption.** The plugin's desktop backend reports no
  click events. Reframed as verified-per-platform with a stated baseline.
- **AppImage sign-in was undecided.** Added `register_all()` under `APPIMAGE`.
- **The `windows_subsystem` item was a no-op** on non-Windows targets. Removed.
- **Node version of the packaged runtime was unpinned.** Pinned to 22.
- **"CI produces" had no CI.** Named the workflow and its smoke.
- **Updater was unaddressed.** Decided: none in this release.
