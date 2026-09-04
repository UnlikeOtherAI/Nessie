# Linux and Windows delivery — handover

**Status:** code complete on the branch, unverified on real Windows and KVM hardware
**Date:** 2026-09-02
**Branch:** `claude/linux-windows-delivery-design-65byfg` (39 commits on top of `main`, head `2f59052`); no pull request opened
**Plans this implements:** [2026-09-01-linux-desktop-delivery.md](2026-09-01-linux-desktop-delivery.md), [2026-09-01-windows-desktop-parity.md](2026-09-01-windows-desktop-parity.md)
**Operating guides:** [docs/running-the-apps/overview.md](../running-the-apps/overview.md), [linux-desktop.md](../running-the-apps/linux-desktop.md), [windows-desktop.md](../running-the-apps/windows-desktop.md)
**Protocol:** [docs/executor-protocol/overview.md](../executor-protocol/overview.md), [sandbox-forced-egress-and-credentials.md](../executor-protocol/sandbox-forced-egress-and-credentials.md)

## 1. What this hands over

Everything the two plans call for exists in code and passed its gates in a
Linux container: the frameless desktop shell on Windows and Linux, the desktop
app enabled as an executor on request, a standalone Linux daemon, a standalone
Windows service with a tray icon, and a sandbox backend per platform. Nothing
has run on a real Windows machine or a KVM-capable Linux machine. Section 4 is
the ordered list of what those machines must confirm; section 7 is what is
deliberately not done.

Every merge into the branch was gated on lint, typecheck and the touched
packages' tests; the whole repository's `pnpm lint` (29 tasks) and
`pnpm typecheck` (27 tasks) are green at the head.

## 2. What exists now — map

### Shell (both platforms)

| Piece | Where |
| --- | --- |
| Platform exposed to the admin (`window.__nessieDesktopPlatform`) | `desktop/src-tauri/src/shell.rs`, `admin/src/lib/desktop.ts`, `admin/src/providers/ShellEnvironmentProvider.tsx` |
| Per-platform window config (Windows `decorations:false, shadow:true`; Linux `decorations:false, transparent:true`; macOS overlay title bar) | `desktop/src-tauri/tauri.{windows,linux,macos}.conf.json` — each restates the whole `main` window because Tauri merges arrays by replacement; `shell.rs` has a test that the shared half never drifts |
| The one custom frame: drag strip, min/max/close, resize handles, Linux 12 px radius + shadow, F11, Ctrl+Q | `admin/src/components/desktop/DesktopWindowFrame.tsx`, `desktop-window-adapter.ts`, rules in `admin/src/styles.css` |
| macOS-only traffic-light spacer gated off other platforms | `admin/src/layouts/admin-shell/TopBar.tsx` |
| Window permissions (incl. `allow-internal-toggle-maximize` for native double-click) | `desktop/src-tauri/capabilities/{default,development}.json` |
| Single instance on all three platforms with deep-link forwarding | `desktop/src-tauri/Cargo.toml` (`tauri-plugin-single-instance` with `deep-link`), `src/lib.rs` |
| AppImage `nessie://` registration at launch (only under `APPIMAGE`) | `src/lib.rs` |
| Badge on Windows (overlay icon) / Linux (best-effort) | `desktop_set_badge` command, `icons/badge-dot.png`, `desktop_notifications_init.js` |
| Companion availability (`available`, `workspace_only`, `unsigned_release`, `runtime_missing`, `unsupported_platform`) and the explanatory cards | `desktop/src-tauri/src/executor_companion/runtime/availability.rs`, `admin/src/components/features/executors/ExecutorDesktopCompanionPanel.tsx` |

### Executor platform contract

| Piece | Where |
| --- | --- |
| Descriptor `platform {os, architecture, osMajorVersion}` with minimums (macOS 15, Linux kernel major 5, Windows build 19045), `supervisor`, `sandboxBackend`; protocol version stays 1 | `packages/schemas/src/executor-platform.ts`, `executor.ts` |
| Host detection with injectable probe (`/dev/kvm` → `firecracker`; `vmms.exe` → `hyperv`; else `none`) | `executor/src/host-platform.ts`, `descriptor.ts` |
| Workspace-only degradation without virtualization | `executor/src/pair.ts` (configure refusal), descriptor profiles |
| Server persistence/presenter (`Executor.platformFacts` JSON, no migration) | `packages/executor-manage/src/executor-daemon.ts`, `executor-records.ts` |

### Linux

| Piece | Where |
| --- | --- |
| Root-owned package trust root for the desktop companion | `desktop/src-tauri/src/executor_companion/runtime/integrity.rs` (Linux arm) |
| Standalone daemon commands `enable`, `disable`, `status`; systemd user unit template; linger | `executor/src/index.ts`, `executor/src/service-linux.ts`, `executor/packaging/linux/nessie-executor@.service` |
| Packaged-runtime integrity (hashes, root ownership, `/usr/lib` or `/usr/share`) | `executor/src/runtime-integrity.ts` |
| Shared runtime preparation (desktop and package use the same layout) | `executor/scripts/prepare-runtime.mjs`, `desktop/scripts/prepare-executor-runtime.mjs` |
| `.deb` build with pinned Firecracker v1.16.1, pinned CI kernel `v1.15/x86_64/vmlinux-6.1.155`, `build-initrd`, `init` | `executor/packaging/linux/build-deb.mjs` |
| Firecracker backend: API, layout, vsock over Unix sockets, control channel, egress bridge, no jailer, default seccomp | `executor/src/firecracker/**`, seam in `executor/src/guest-vm-backend.ts` |
| Block-image shares (`mkfs.ext4 -d`, unprivileged): runtime (ro), workspace (ro), draft (rw); overlay in the guest under `nessie.shares=block` | `executor/src/guest-images.ts`, `executor/guest/mounts_linux.go` (devices found by ext4 label) |
| Drafts streamed back over the control channel, re-validated on the host | `executor/guest/drafts*.go`, `executor/src/guest-draft-ingest.ts`, `sandbox-manifest.ts` |
| Portable deterministic initrd builder | `executor/guest/cmd/build-initrd` |
| Root-owned artifact trust for kernel/initrd/runtime | `executor/src/guest-vm-artifacts.ts` |
| CI | `.github/workflows/desktop-linux.yml` (`build` on `ubuntu-24.04`; `firecracker-conformance` on `[self-hosted, linux, kvm]`) |

### Windows

| Piece | Where |
| --- | --- |
| Authenticode pinning shared by desktop and service (`WinVerifyTrust` + signer thumbprint compiled in via `NESSIE_DESKTOP_WINDOWS_SIGNER_THUMBPRINT`) | `executor/windows-provenance/`, consumed by `desktop/src-tauri` and `executor/service-windows` |
| Owner-only state as a DACL via the native helper (`secure-directory`, `verify-owner-only`) | `executor/src/state-security.ts`, `executor/native/` |
| Pipe-close graceful stop, process-handle liveness, stale-lease fix | `desktop/src-tauri/src/executor_companion/runtime.rs` (Windows arms) |
| `node.exe` runtime layout, manifest `nodeExecutable`, pinned helper | `executor/scripts/prepare-runtime.mjs` |
| Windows service `NessieExecutor` under `NT SERVICE\NessieExecutor`: supervision, `STOP_PENDING` checkpoints, named pipe `\\.\pipe\NessieExecutor` (JSON lines: `status`, `pair`, `start`, `stop`, `configure`) | `executor/service-windows/` |
| Tray app (Tauri `tray-icon`): four icon states, menu, frameless status window, native confirmations, elevated workspace grant (`--grant-workspace`) | `executor/tray-windows/` |
| Shared names (`SERVICE_NAME`, account, `%ProgramData%` layout, SID helper) | `executor/windows-common/` |
| MSI (WiX 5): service install, Hyper-V Administrators via custom action, Hyper-V socket GUIDs, tray Run entry | `executor/packaging/windows/{nessie-executor.wxs,msi-plan.mjs,build-msi.mjs}` |
| Hyper-V backend: Generation 2 VM via pinned, digest-checked PowerShell scripts; fixed-VHD wrapper → `Convert-VHD`; FAT32 boot disk written by the executor (`EFI/BOOT/BOOTX64.EFI` + `initrd.img`); per-session args inside the initrd (`nessie.args=initrd`) | `executor/src/hyperv/**`, `executor/packaging/windows/scripts/*.ps1` |
| Hyper-V sockets bridge (named pipe ↔ `AF_HYPERV`) | `executor/hyperv-bridge/` |
| EFI-stub guest kernel (6.1.155, `CONFIG_EFI_STUB`, `HYPERV_STORAGE`, `HYPERV_VSOCKETS`, built-in cmdline) | `executor/guest/kernel/{PIN,config,build.sh}` |
| CI | `.github/workflows/desktop-windows.yml` (`guest-kernel` on Linux → `build` on `windows-latest`; `hyperv-conformance` on `[self-hosted, windows, hyperv]`) |

## 3. Verified here versus not

Verified in the Linux container at the head of the branch:

| Suite | Result |
| --- | --- |
| `@nessie/executor` unit tests (run unprivileged) | 150 pass, 1 skip (root-only trust-root case) |
| `@nessie/admin` | 782 pass |
| `@nessie/schemas` / `@nessie/executor-manage` | 121 / 42 pass |
| `desktop/src-tauri` Rust | 33 pass; `cargo build` clean |
| `executor/native`, `windows-provenance`, `windows-common`, `service-windows`, `tray-windows`, `hyperv-bridge` Rust | 12 / 5 / 3 / 36 / 17 / 7 pass |
| Every Rust crate | `cargo check --release --target x86_64-pc-windows-msvc --all-targets` clean |
| Go guest | `linux/amd64` and `linux/arm64` build, `go vet`, `go test` pass; `build-initrd` also builds for `windows/amd64` |
| Linux `.deb` | built, installed with `dpkg -i`, tamper test refused a user-owned runtime file |
| Guest kernel | `build.sh` completed here (~8 min), `bzImage` 10,085,376 bytes, sha256 `a423576b…be921` (not committed) |
| FAT32 boot disk | `fsck.fat -n` clean, `mdir`/`mcopy` round-trip byte-identical, deterministic |
| Playwright | login page framed for Linux, Windows, macOS, and web (screenshots reviewed) |
| Repo-wide | `pnpm lint`, `pnpm typecheck`, markdown structure lint |

Not executed anywhere: any Windows runtime behaviour, any Hyper-V or
Firecracker guest boot, WiX, `msiexec`, a Windows service run, Playwright on
an authenticated route (no API database in the container), database-backed
API suites (no pgvector locally).

## 4. Machine checklists — in this order

### Windows 11 Pro, Hyper-V enabled

1. Pull the branch; `pnpm install`; `rustup default stable-msvc`; install
   Visual Studio C++ build tools, Node 22, and WiX 5 (`dotnet tool install
   --global wix --version 5.0.2`).
2. Shell: `pnpm --filter @nessie/desktop dev` against `pnpm dev`. Confirm the
   frameless window, rounded corners with shadow, Nessie's own controls, drag,
   resize from every edge, double-click maximize (square) and restore (round),
   F11, Alt+F4. Sign in through the browser; start a second sign-in with the
   app open and confirm it lands in the existing window.
3. `cargo test` for `desktop/src-tauri`, `executor/native`,
   `executor/windows-provenance`, `executor/windows-common`,
   `executor/service-windows`, `executor/tray-windows/src-tauri`,
   `executor/hyperv-bridge` — the Windows-only test modules have only been
   typechecked so far.
4. Build unsigned: `pnpm --filter @nessie/desktop tauri:build` (NSIS + MSI)
   and `node executor/packaging/windows/build-msi.mjs` with
   `NESSIE_GUEST_KERNEL` pointing at a `bzImage` from `executor/guest/kernel/build.sh`
   (run on any Linux box). This is the first real exercise of the `.wxs`.
5. Install the executor MSI. Confirm: service `NessieExecutor` running under
   its virtual account; `%ProgramData%\Nessie Executor` DACL is the account +
   SYSTEM; the account is in Hyper-V Administrators; the three
   `GuestCommunicationServices` GUIDs exist; the tray appears with no window.
6. Pair from the tray: invitation from **Agents → Executors → Pair executor**,
   folder picker, one UAC prompt (workspace ACL grant), fingerprint confirmed
   in Nessie, icon green. Reboot with nobody logged in; the executor is online.
7. Sandbox: run a file read and then a sandboxed command from an agent. The
   two things most likely to fail first, with their documented remedies:
   the firmware loading the initrd through the EFI stub with empty load
   options (remedy: a fourth labelled disk), and the firmware booting a
   whole-disk FAT32 volume with no partition table (remedy: a GPT wrapper;
   `fat32Geometry` already returns what it needs).
8. Tamper: replace `node.exe` in Program Files as Administrator; the service
   stays Running, starts no daemon, the tray turns red, the desktop card says
   `unsigned_release`.
9. Signing: set the four `WINDOWS_SIGN*` secrets (section 6) and confirm
   `Get-AuthenticodeSignature` reports `Valid` with the expected subject on
   every `.exe` and `.msi`, and that `WinVerifyTrust` in the desktop and the
   service accepts the signed build and refuses a differently-signed one.
10. Notifications and badge: enable **Push enabled**, receive a toast, record
    whether clicking it opens the route and whether the taskbar badge appears;
    write both results into `docs/running-the-apps/windows-desktop.md`.

### Windows 10 22H2

Steps 2, 4, 5, 6 and 10 above. Expect square corners with the OS shadow and
otherwise identical behaviour. Hyper-V requires Pro/Enterprise/Education; Home
must pair as `workspace_only` with the card naming the editions.

### Ubuntu 26.04 x86_64 with KVM (user in the `kvm` group)

1. Build: `pnpm --filter @nessie/desktop tauri:build -- --bundles deb,appimage`
   and `node executor/packaging/linux/build-deb.mjs` (Node 22 on the host; the
   packaged runtime is the host's Node).
2. Install both `.deb` files. Confirm `xdg-mime query default
   x-scheme-handler/nessie` names the Nessie entry and
   `stat -c '%U %a' /usr/lib/nessie-executor/*` shows root ownership.
3. Shell: frameless rounded window with shadow in a transparent gutter,
   controls, resize, maximize (square), F11, Ctrl+Q; browser sign-in including
   with the app already open; second launch focuses the window.
4. Desktop companion: pair this computer, confirm, start, run a file read and a
   sandboxed command, stop. Then on a machine without `kvm` membership confirm
   the `workspace_only` card.
5. Standalone: `nessie-executor pair …` (command copied from the Executors
   page), confirm, `nessie-executor enable <id>`, reboot, confirm online before
   login, `nessie-executor status`, `disable`, `journalctl --user -u
   nessie-executor@<id>`.
6. Firecracker boot specifics to prove: the guest finds `/dev/vd{a,b,c}` by
   label, the overlay mounts with `userxattr` on the 6.1 kernel, the merged
   `/work` is owned by the daemon's uid, `rm -rf dir` in the guest surfaces
   as `deleted` in `workspace.review`, default seccomp blocks nothing needed.
7. Tamper: `chown` a runtime file to a user; `enable` and `serve` refuse.
8. AppImage: sign-in works from `~/Downloads`, still works after moving the
   file and launching once; its Executors card says controls need the package.

### macOS

Descriptors from before the platform change fail closed. Run
`nessie-executor configure` on the existing state directory (or re-pair) to
propose a new revision; the macOS behaviour is otherwise byte-identical and
33 shell tests cover it.

## 5. Build and run commands

```sh
# Desktop shell, development (both platforms, against pnpm dev)
pnpm --filter @nessie/desktop dev

# Desktop bundles
pnpm --filter @nessie/desktop tauri:build                       # NSIS + MSI on Windows, deb + AppImage on Linux
NESSIE_DESKTOP_SIGNING_TEAM_ID=<team> pnpm --filter @nessie/desktop tauri:build:executor   # macOS executor-capable

# Linux standalone executor package
node executor/packaging/linux/build-deb.mjs                     # dist/nessie-executor_<v>_amd64.deb (+ .sha256)

# Guest kernel for Windows (Linux host, ~8 minutes on 4 cores)
executor/guest/kernel/build.sh                                  # pinned 6.1.155, fails if a required option is missing

# Windows standalone executor package (Windows host, WiX 5)
NESSIE_GUEST_KERNEL=<path to bzImage> node executor/packaging/windows/build-msi.mjs

# Release-provenance pins compiled into the binaries
NESSIE_DESKTOP_SIGNING_TEAM_ID              # macOS Developer ID team
NESSIE_DESKTOP_WINDOWS_SIGNER_THUMBPRINT    # Windows signer SHA-1 thumbprint (desktop and service)
NESSIE_EXECUTOR_VERSION                     # overrides the package version in both build scripts
```

Tests as the gates ran them:

```sh
pnpm exec turbo run lint typecheck test --filter=@nessie/admin
pnpm exec turbo run lint typecheck --filter=@nessie/executor
cd executor && setpriv --reuid=65534 --regid=65534 --clear-groups node --test --import tsx 'test/*.test.ts'   # unprivileged: one test asserts EACCES
cd executor/guest && go vet ./... && go test ./...                 # never write the checked-in guest binary: build with -o /dev/null
cargo test            # in each Rust crate; desktop/src-tauri needs `pnpm --filter @nessie/desktop prepare:executor-runtime` first
cargo check --release --target x86_64-pc-windows-msvc --all-targets
```

## 6. CI: workflows, secrets, runners

| Workflow | Trigger | Jobs | Needs |
| --- | --- | --- | --- |
| `desktop-linux.yml` | `workflow_dispatch`, tags `desktop-v*` | `build` (ubuntu-24.04: cargo test, shell deb + AppImage, executor deb, checksums, install smoke under xvfb), `firecracker-conformance` | a self-hosted runner labelled `[self-hosted, linux, kvm]`; apt repository signing is a commented placeholder |
| `desktop-windows.yml` | `workflow_dispatch`, tags `desktop-v*` | `guest-kernel` (Linux, builds `bzImage`), `build` (windows-latest: cargo test, tauri build, executor MSI, signing, checksums, silent-install smokes), `hyperv-conformance` | secrets `WINDOWS_SIGN_COMMAND` (Tauri `signCommand` with `%1`), `WINDOWS_SIGNER_THUMBPRINT`, `WINDOWS_SIGNER_SUBJECT`, optional `WINDOWS_SIGN_TOOL_INSTALL`, and for Azure Artifact Signing `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_CLIENT_SECRET`; a runner labelled `[self-hosted, windows, hyperv]` |

Without the signing secrets the Windows build labels itself an unsigned
development build and never claims a release. Both conformance jobs fail, not
skip, on a runner without virtualization, and queue until a labelled runner
exists.

## 7. Open items

- **Conformance has never run on hardware.** Register the two self-hosted
  runners (your Windows 11 Pro box, a KVM-capable Linux machine; cloud VMs
  without nested virtualization cannot run Firecracker).
- **Firecracker jailer.** Deliberately not used: it needs root, and the Linux
  daemon runs as the person. Adopting it requires a privileged launcher; the
  guest has no network device and Firecracker's default seccomp is on.
- **apt repository signing** for the Linux packages is a placeholder step in
  the workflow; the trust root (root-owned install) assumes a signed source.
- **No in-app updater** on either platform by decision; the hosted admin
  updates without a shell release, a shell release is a reinstall.
- **AppImage never gets executor controls** (user-writable file).
- **Snap, Flatpak, RPM, AUR, ARM** are not targets.
- **Click-to-route and the badge** are best-effort per platform until a
  release smoke records the result.
- **Swift helper `handshake` subcommand** (`executor/vm`) is invoked by
  nothing since the pairing-handshake runner was deleted; it is documented as
  manual release-candidate tooling and can be removed in an `executor/vm` edit.
- **`GuestVmHandshakeInput` naming**: the shared boot input type now lives in
  `executor/src/guest-vm-session.ts`.

## 8. Decisions taken, with the reason

- **Windows 10 is supported with square corners.** Only Windows 11's window
  manager rounds a top-level window; the per-pixel-alpha alternative forfeits
  the system shadow. Same custom chrome on both; the OS decides the corners.
- **Linux paints its own corners and shadow** in a transparent window because
  Tauri documents `shadow` as unsupported on Linux.
- **Protocol version stays 1; old descriptors fail closed.** The new required
  facts already make the grammars mutually exclusive; a machine whose sandbox
  backend is unknown should be unavailable rather than shimmed.
- **Shares are block images, not virtio-fs**, because Firecracker and Hyper-V
  have no virtio-fs; drafts return over the control channel so the host never
  parses ext4.
- **Hyper-V per-session arguments travel inside the initrd**, because the
  Generation 2 firmware boots `BOOTX64.EFI` with empty load options and the
  EFI stub reads `initrd=` only from those options.
- **The executor writes its own FAT32 boot disk**; mtools (GPL-3.0, external)
  was removed rather than pinned.
- **Root-owned package files are the Linux trust root**; Windows uses pinned
  Authenticode. A self-verified signature would be self-attestation.
- **One `DesktopWindowFrame`, one `windows-provenance` crate, one
  `windows-common` crate** — every duplicate the agents flagged was folded.
