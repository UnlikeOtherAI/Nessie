# Windows Desktop

Chapter of [Running the Native Apps](overview.md).

## Pairing and unpairing

There are two supervisors with different OS identities. The standalone
**Nessie Executor** tray controls the boot-time `NessieExecutor` Windows
service. Its virtual service account cannot run your personal Claude sessions.
For Claude and interactive terminals, use **Nessie Desktop's user-session
executor**, running as the Windows account where Claude is authenticated.
Do not pair both supervisors as if they were one connection.

Both can hold multiple independent account connections. Choose **Add account**
in the tray, or **Executors → Pair executor → Connect this computer** in Desktop.
The latter runs under your Windows account and is appropriate for personal
terminal programs. Adding an account never replaces or stops an existing one.
The headless equivalent is `nessie-executor pair --cli`; use `status` to list
connections and a specific executor ID when starting, stopping or replacing one.

1. Install the intended application. Public releases use Authenticode signing;
   an explicitly requested development build can use Desktop's debug runtime.
2. Open its local executor controls, select **Nessie** as the server, choose a
   workspace folder and request a pairing code. In a development build, check
   that the destination is production rather than its local-server option.
3. Complete the [website claim and local confirmation](../executor-pairing.md#complete-both-halves).
   Use private access for personal local programs. Review the live team name.
4. Check Online in Nessie, review Permissions and grant agents access separately.
   Use the real `claude.exe`, not an npm/PowerShell shim; Windows supplies ConPTY.

The service starts at boot; its tray starts at login. Desktop/user-session
executors require that user's login environment. Preserve state in the owning
supervisor's directory: never copy service keys into Desktop or vice versa.
The tray refuses to silently duplicate an existing Desktop/CLI pairing.

To unpair, **Disconnect** or **Delete** in Nessie first. Then stop the owning
daemon. For the service, an administrator can run `Stop-Service NessieExecutor`
and uninstall **Nessie Executor** through Installed apps. For Desktop, stop the
local executor and use its local forget control after server revocation.
Uninstalling either application alone does not revoke the server pairing.

The explicitly requested 2026-09-24 LAN development install loads the hosted
production UI and runs its user daemon at login through
`%LOCALAPPDATA%\Nessie\executor-start.ps1`. Its two startup values are **Nessie**
and **Nessie Executor (development)** under
`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`. Remove these values to
disable that installation's automatic startup. Its executor state is under
`%LOCALAPPDATA%\com.unlikeotherai.nessie.desktop\executors\<executor-id>`,
and its daemon log is `%LOCALAPPDATA%\Nessie\executor-daemon.log`.
This development installation does not claim Authenticode or automatic updates;
replace it with the signed release when the certificate is available.

### Desktop application icon

The Mac application's `assets/icon-1024.png` is the canonical Nessie icon for
every Tauri desktop bundle. Regenerate the Windows `.ico`, Linux PNGs, and
other platform exports together after changing that source asset:

```sh
pnpm --dir desktop run icons:generate
```

Run the build on a Windows machine:

```sh
pnpm install --frozen-lockfile
pnpm --dir desktop run tauri:build:embedded -- --bundles nsis
```

That command builds the executor's shared dependencies, embeds the local admin
with its production API origin pinned and verified, and then prepares the exact
Node runtime, native helper, licence, and integrity manifest before Tauri builds
the installer.

> **This build is for verification, not for daily use.** Embedding freezes the
> admin at the moment you built it, and an embedded shell has no way to learn it
> is stale: it serves its own `index.html` from `tauri.localhost`, so
> `admin/src/lib/build-freshness.ts` can never see a different asset signature,
> and the direct updater is a CI-only Cargo feature this command does not
> enable. The API keeps deploying. The first time the control plane projects a
> field the frozen bundle's strict schemas do not know, whole screens stop
> working, and the only remedy is reinstalling.
>
> That is not hypothetical: an embedded build left installed as a daily driver
> lost the entire executor access-management surface — every operation grant and
> assignment form — the day the API began sending `workspaceFolders` on
> descriptor revisions.
>
> **For daily use install the CI release instead.** It loads the hosted admin
> from `https://app.nessie.works` (`desktop_webview_url()` forces that for any
> release build that was not explicitly embedded) and, with the direct updater,
> keeps itself current.

`packages/billing-statement-protocol/` is a byte-for-byte vendored UOA
contract. Git preserves its upstream LF bytes on every platform (including
Windows), without applying `core.autocrlf`, so its generated-artifact and
SHA-256 verification gates remain valid. Do not edit or regenerate that package
locally; update its upstream pin instead.

If the local Windows Node installer omits its `LICENSE` file, the build
retrieves and validates the official licence for that exact Node version before
including it in the hash-verified runtime layout.

Tauri uses the Windows bundle settings in `desktop/src-tauri/tauri.conf.json` for NSIS and WiX packaging.

To create a build whose executor controls can be used, sign it and pin the
publisher. With an Azure CLI login (`az login`) that holds the Artifact Signing
Certificate Profile Signer role on `UOAartifactAccount`:

```powershell
pwsh executor\packaging\windows\signing\sign.ps1 -Prepare
# prints the two variables to set; then, in the same shell:
$env:NESSIE_WINDOWS_SIGN_COMMAND = '<printed sign command>'
$env:NESSIE_WINDOWS_PUBLISHER_EKU = '<printed profile EKU>'
$config = @{ bundle = @{ windows = @{ signCommand = @{ cmd = 'pwsh'; args = @(
  '-NoLogo', '-NoProfile', '-NonInteractive', '-File',
  (Resolve-Path executor\packaging\windows\signing\sign.ps1).Path, '%1') } } } }
$config | ConvertTo-Json -Depth 8 | Set-Content $env:TEMP\tauri.signing.conf.json
pnpm --dir desktop run tauri:build:embedded -- --bundles nsis,msi --config $env:TEMP\tauri.signing.conf.json
```

`-Prepare` installs the pinned Artifact Signing client and proves signing works
by signing a probe before you build. `NESSIE_WINDOWS_PUBLISHER_EKU` is the
Windows analogue of macOS's `NESSIE_DESKTOP_SIGNING_TEAM_ID`: the certificate
profile's EKU (`1.3.6.1.4.1.311.97.` and the arcs that name
`NessiePublicTrust`), compiled into the build. At runtime the companion
verifies its own executable with `WinVerifyTrust`, then reads the signer
certificate out of that verification and requires the pinned EKU among its
enhanced key usages — `WinVerifyTrust` alone answers "trusted", never "by
whom", so a build validly signed by anyone else, including another Artifact
Signing customer, is refused exactly like an unsigned one. The pin is never a
certificate thumbprint: Artifact Signing renews the certificate daily and each
is valid for 72 hours, so a thumbprint would reject tomorrow's build; the
profile EKU is the same for every certificate the profile ever issues. The
packaged executor runtime's hash manifest is checked as a second gate, as on
every platform. The trusted workflow also compiles the manifest's exact Node,
executor-bundle, and native-helper hashes into the desktop executable before
signing it. A per-user install is writable by that user, so the adjacent
manifest is never its own authority: replacing JavaScript and rewriting the
manifest still fails against the copy held by the signed application.

Without those two variables the build is an unsigned development build, and
the Executors panel reports `unsigned_release` and names the remedy rather than
disappearing. On a machine with no Hyper-V — Windows Home,
where it is an edition rather than a setting — the companion pairs as
`workspace_only`: file review and drafts work, sandboxed commands, browsers and
coding sessions do not. A second launch carries the `nessie://` sign-in callback
into the running instance, shows and restores it if minimized, and focuses it.

The executor's private state under `%LOCALAPPDATA%\Nessie\executors\<id>` is
owner-only through an explicit, non-inherited DACL granting the signed-in user
and SYSTEM alone, established and re-verified through the packaged
`nessie-executor-native.exe` helper — Node reports no uid and a fixed
`0o666`-shaped mode on Windows, so the POSIX ownership checks would either be
vacuous or fail closed on every load. Stopping a daemon closes its
parent-liveness pipe and waits the same ten seconds as every other host; a
sandbox daemon is never force-killed.

### Releases, and how they are signed

`.github/workflows/desktop-windows.yml` builds every Windows artifact on a
`windows-latest` runner — the NSIS installer, the desktop MSI, and the
standalone executor MSI — runs the Rust tests for the shell, the executor's
native helper, the shared provenance crate, the service, and the tray, signs
what it built, and then proves both packages install, launch, and uninstall. The
desktop native helper is signed before its runtime hash is written; the
standalone service, tray, native helper, Hyper-V bridge, and Windows initrd
builder are signed before packaging. Both packaged Node executables must retain
their valid upstream Authenticode signature. It runs on `workflow_dispatch`,
for every relevant merge to `main` through `windows-edge.yml` (which publishes
the `desktop-edge` and `executor-edge` pre-releases — see
[releasing](../releasing.md#edge-builds-from-main)), and for a `v*` release tag
through `release.yml`.

The Windows job also runs the executor's real control loop against a local
protocol peer: enrollment, fresh challenge and claim, descriptor, heartbeat,
poll, receipts, an allowed selected-folder read, a refused traversal, a COW
write, and a draft review. The test uses the packaged Windows DACL helper and
asserts that neither the selected host root nor an outside folder was changed.

Every branch also reports the **Windows Native** check, from the Desktop CI
workflow (`.github/workflows/desktop-ci.yml`, beside Linux Desktop Bundle, so a
desktop build never holds a server deploy). It runs only when
`desktop/`, `executor/`, or `assets/` changes (and reports an explicit skip
otherwise), then tests every Windows Rust crate and the WiX installer authoring.
Those failures block the affected pull request before a release build is
attempted once repository branch protection lists **Windows Native** from the
GitHub Actions app (ID `15368`) among required checks; preserve strict branch
protection as disabled when adding it alongside the existing nine checks. Before
testing the desktop crate it generates Prisma, then prepares the unsigned
packaged runtime that Tauri's resource manifest requires. Each Cargo command is
an isolated fail-fast PowerShell step. Windows then builds the unsigned NSIS
and MSI desktop installers, runs WiX validation, and uses the same install,
launch, and uninstall smoke script as the release workflow. The standalone
executor MSI uses the same release service/tray smoke script. Hosted Windows
runners cannot build the production Linux guest kernel, so the PR job writes a
hash-verified, deliberately non-bootable fixture that carries the required
command-line marker. That reaches the real MSI staging, WiX validation, and
service/tray install–uninstall lifecycle without hiding a release-only kernel
boot claim. The release workflow remains responsible for building and booting
the pinned production kernel. These are temporary CI inputs: the source check
receives no signing secrets and neither uploads nor publishes them; signing
remains the release workflow's separate responsibility.

Releases are signed with **Azure Artifact Signing** as **UnlikeOtherAI s.r.o.**
(account `UOAartifactAccount`, certificate profile `NessiePublicTrust`, Public
Trust, North Europe). Who signs is committed rather than hidden in secrets:
`executor/packaging/windows/signing/publisher.json` names the endpoint, account,
profile, certificate subject, the profile EKU the apps pin, the timestamp
authority, and the exact Artifact Signing client package with its SHA-256.
`sign.ps1` beside it is the only signing command: Tauri's
`bundle.windows.signCommand` (object form, because the string form splits on
spaces), `NESSIE_WINDOWS_SIGN_COMMAND` for the executor package's binaries and
the desktop's native helper, and the workflow's MSI step all call it with one
file, and it refuses unless the result is `Valid`, timestamped, from the
expected subject and carries the profile EKU. The Tauri keys in
`desktop/src-tauri/tauri.windows.conf.json` stay `null` placeholders; the
workflow supplies the command.

Signing is keyless. Whether a build is signed is decided by its source alone —
`main` itself (a push through `windows-edge.yml` or a manual run with
`source_ref` empty) or the exact `vX.Y.Z` tag a release runs for — and only
those builds join the `windows-signing` environment. Its GitHub OIDC token is
exchanged, one fresh token per signature, for the `nessie-github-signing`
user-assigned managed identity, whose federated credential trusts that
environment alone and which holds only the Artifact Signing Certificate Profile
Signer role. The environment deploys only from `main` and `v*` tags, so a
workflow edited on a branch cannot sign. There is no signing secret to leak or
rotate; `AZURE_CLIENT_ID` and `AZURE_TENANT_ID` are plain environment
variables. A signed build that cannot sign fails — `sign.ps1 -Prepare` signs a
probe before anything is built, so a missing role or a recreated profile fails
in the first minute — and every Nessie `.exe` and `.msi` it produced is checked
again before upload. Manual source overrides and branch runs are unsigned
development evidence, never enter the environment, and never reach the
persistent self-hosted Hyper-V runner; its administrator-level job is gated to
the exact trusted `main` run or a release tag, after the signed build and
install checks pass. An unsigned build pins no publisher, so the desktop
companion and the executor service both refuse executor controls — the same
refusal a tampered build gets.

A recreated certificate profile gets a new EKU. `sign.ps1 -Prepare` then fails
naming the EKU the certificate actually carries; update `profileEku` in
`publisher.json`, and every installed build pinned to the old profile keeps
refusing executor controls until it is replaced by one pinned to the new one.

**Verify a signature yourself**, on any machine:

```powershell
Get-AuthenticodeSignature .\Nessie_<version>_x64-setup.exe |
  Format-List Status, StatusMessage, SignerCertificate
```

`Status` must be `Valid` and the certificate subject must be
`CN=UnlikeOtherAI s.r.o., O=UnlikeOtherAI s.r.o., L=Mnichovice, S=Central Bohemia, C=CZ`.
The certificate's thumbprint changes daily — Artifact Signing renews it — so
compare the subject, not the thumbprint. The same file's SHA-256 is in
`SHA256SUMS` (or the `.sha256` beside an edge download):

```powershell
Get-FileHash .\Nessie_<version>_x64-setup.exe -Algorithm SHA256
```

### Installing, replacing, and collecting logs

**Install** by running `Nessie_<version>_x64-setup.exe`. It is a per-user NSIS
install, so it needs no administrator and lands under
`%LOCALAPPDATA%\Nessie`. `Nessie_<version>_x64_en-US.msi` installs the same app
for deployment tooling. Start opens Nessie in one frameless window with its own
controls and no console — rounded with a shadow on Windows 11, square with a
shadow on Windows 10, which is the OS's decision rather than ours.

**Replace** a build by running the newer installer over it: NSIS closes the
running app, replaces it, and keeps the `nessie://` registration and every
local executor pairing. The admin bundle itself is served from
`https://app.nessie.works`, so a new admin deployment reaches an installed app
by reloading the window; only shell changes need a new installer.

**Collect logs** from two places, because there are two programs:

- The desktop app writes nothing to disk of its own. Reproduce with the
  developer tools open (`Ctrl+Shift+I`) and copy the console.
- The executor service writes to `%ProgramData%\Nessie Executor\logs\service.log`
  — the folder the tray's **Open logs folder** opens. Every refusal a person can
  act on lands there: an unsigned or tampered runtime, a state root that would
  not secure, an executor that did not start at boot. It never contains a
  pairing challenge, a key, or a child process's output.

```powershell
Get-Content "$env:ProgramData\Nessie Executor\logs\service.log" -Tail 100
Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Service Control Manager' } |
  Where-Object { $_.Message -like '*NessieExecutor*' } | Select-Object -First 20
```

### The standalone Nessie Executor package

`NessieExecutor_<version>_x64.msi` turns a Windows computer with no desktop app
into an executor. It installs a **service** that owns the daemon and a **tray
icon** that controls it. The desktop app supervises its own daemon instead, and
only while it runs; a computer that should stay online installs this package.

Build it on Windows, with Node 22 (the packaged runtime is a copy of the build
host's Node), the MSVC toolchain, and the WiX toolset:

```powershell
dotnet tool install --global wix --version 5.0.2
node executor\packaging\windows\build-msi.mjs
# dist\NessieExecutor_<version>_x64.msi
# dist\NessieExecutor_<version>_x64.msi.sha256
```

WiX is deliberately pinned to 5.0.2. WiX 7 requires explicit acceptance of
its OSMF EULA; moving to that license is an owner decision and must not be
silently accepted by the build or CI.

`NESSIE_EXECUTOR_VERSION` overrides the version taken from
`executor/package.json`; it must be `major.minor.build`, which is all Windows
Installer compares. `NESSIE_WINDOWS_SIGN_COMMAND` (carrying `%1`) signs the
three binaries the package builds *before* they are staged, because the native
helper's bytes are pinned in the runtime manifest and a signature added
afterwards would no longer match it.

Every executable the package builds carries the executor's icon and a name.
The tray gets them from Tauri. The service, the native helper and the Hyper-V
bridge embed them through their crates' `build.rs`, so Task Manager lists
**Nessie Executor Service**, **Nessie Executor Helper** and **Nessie Executor
Hyper-V Bridge** rather than bare file names beside the generic program icon.
Those icons, the tray's four states and the Apps & features icon are drawn by
`node executor/scripts/generate-icons.mjs` from
`assets/logo/nessie-executor-mark.svg`.

**Install** with one administrator prompt:

```powershell
Get-FileHash .\NessieExecutor_<version>_x64.msi -Algorithm SHA256
msiexec /i .\NessieExecutor_<version>_x64.msi
```

It installs `C:\Program Files\Nessie Executor\` — the packaged runtime
(`node.exe`, `nessie-executor.cjs`, `manifest.json`, `NODE_LICENSE`,
`nessie-executor-native.exe`) plus `nessie-executor-service.exe` and
`nessie-executor-tray.exe`. It also installs the Hyper-V sandbox payload under
`resources\` — `nessie-hyperv-bridge.exe`, the four pinned PowerShell scripts
that create, start, stop and remove a session's virtual machine, the guest
kernel and initrd builder under `guest\`, and a `manifest.json` recording one
SHA-256 per file. The service verifies a selected VM artifact against that
installed manifest before it uses it; these package-owned files remain readable
under Program Files while service state and copied credentials remain protected
by their owner-only DACL. The guest's FAT32 boot disk is written by the executor
itself, so nothing else is installed for it. Then it:

- registers the **NessieExecutor** service ("Nessie Executor") to start
  automatically as the virtual account `NT SERVICE\NessieExecutor`: no
  password, no interactive logon, its own SID;
- adds that account to the built-in **Hyper-V Administrators** alias
  (`S-1-5-32-578`, named by SID because its display name is localized), which
  is what lets it create and destroy the per-session Hyper-V VMs. A Windows
  edition without Hyper-V has no such group; the install succeeds anyway and
  the executor pairs as `workspace_only`;
- registers the Hyper-V socket service GUID
  `0000c000-facb-11e6-bd58-64006a7986d3` under
  `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Virtualization\GuestCommunicationServices`
  with `ElementName` = `Nessie Executor`. That GUID is not free to choose: a
  Linux guest is addressed by Microsoft's VSOCK template GUID with the guest's
  vsock port in its first field, and `0x0000c000` is 49152, the guest's control
  port;
- creates `%ProgramData%\Nessie Executor\executors\` and, before the first
  service start, runs the packaged native helper as Windows Installer to give
  the state root and its `executors` and `pending` child roots an owner-only,
  non-inherited DACL (the service account plus SYSTEM). The service re-verifies
  that boundary at every start;
- adds a `Run` entry for the installing user so the tray starts at their next
  logon.

**Uninstall** (`msiexec /x`) stops and removes the service, removes the
registry entries and the Run entry, and **leaves `%ProgramData%\Nessie Executor`
in place**. That is deliberate: a pairing is a machine key and a signed policy
revision, and removing a program is not a request to destroy them. Reinstalling
finds its pairings where it left them; delete the folder by hand to forget them.

**Pair from the tray.** Open **Nessie Executor → Pair with Nessie**, choose the
workspace folder, and approve Windows granting the service read access. The
tray shows eight digit boxes and the remaining ten-minute lifetime. In Nessie,
open **Agents → Executors → Pair executor** and enter that code. Choose
the organisation, team and sharing scope there. Back on the computer, review
the organisation and team by name and choose **Connect this computer**. Only
this local confirmation activates the pairing and starts its daemon.

The tray restores an unfinished attempt after restart. A lost response keeps
the same private machine key and code; a completed confirmation can also be
recovered without claiming again. **Cancel** retires the server attempt before
the local pending key is removed. An existing pairing is shown by organisation
and team and offers **Replace pairing** or **Keep pairing**. Replacement stops
the old daemon and proves possession of its key to revoke that server binding
before the new pairing can continue. Several simultaneous teams are not part
of this flow.
Replacement refuses while local drafts or sandbox artifacts remain, using the
same guard as changing workspace folders; those bytes never move into a new
organisation's binding implicitly.

The tray connects to Nessie by default. Self-hosted operators retain the CLI's
configured-origin input; no address or invitation command appears in the
normal tray flow. Organisation and team names are fetched live using the
machine key and never copied into durable executor state. An unsigned or
tampered release remains refused by the service: code pairing does not bypass
the publisher or runtime-integrity checks.

Running `nessie-executor pair` without an explicit state directory on Windows
points to **Nessie Executor → Pair with Nessie**. It creates no separate pairing
under the user's profile. Explicit operator state directories and the native
JSON commands retain their configured behavior.

After a reboot the service starts before anybody logs in. If Nessie is
unavailable, the tray shows **starting** while the service retries with bounded
backoff. **Stop** cancels those retries for the current service run; **Start**
requests them again. A reboot returns completed pairings to their configured
always-on state. An unfinished pairing never starts a daemon.

That administrator prompt is the only one, and it is worth knowing what it is
for: the daemon runs as a service account with no rights anywhere a person
keeps their work, so somebody with administrative rights has to grant
`NT SERVICE\NessieExecutor` **Read** on the workspace root. Draft changes are
written only to the service's private COW state. The elevated step
merges that one entry into the directory's existing permissions — it never
replaces them — then uses the locally ACL-gated control pipe's enrollment
command, which requires an administrator token, to record the SID from the
elevated connection. The tray never writes
the private service root. That recorded SID is what admits the person's
ordinary, unelevated tray to the control pipe afterwards, so nothing prompts
again.

**The tray.** Grey means nothing is running, green means a daemon is up, amber
means something is in flight (awaiting local confirmation, or a daemon
still tearing its guests down), red means the service could not be reached or
refused to supervise — and the menu's first line says which. Right-click gives
that line, a submenu per paired executor with **Start** and **Stop**, **Pair with Nessie**, **Open Nessie**, **Open logs folder**, and **Quit**. Quit ends
the tray only: the service and every daemon it supervises keep running, and the
menu entry says so. Left-click opens a small frameless status window with the
same list and the same actions. Pairing confirmation names the organisation and
team beside its local button; replacement additionally asks in a native dialog.

**The service and the tray talk over `\\.\pipe\NessieExecutor`**, one JSON line
each way. `pairingStart`, `pairingStatus`, `pairingConfirm` and `pairingCancel`
run the packaged CLI's corresponding JSON commands inside the verified service.
A confirmation carries the digest of the exact organisation/team claim the
person saw. The service serializes these actions, keeps pending keys private,
and requires the Windows account that started the attempt to finish it.
A pending attempt in a different directory from an existing pairing is refused;
an old binding and its replacement attempt in the same directory are one pairing.
If retained drafts or sandboxes block replacement, the CLI returns the bounded
`workspace_cleanup_required` error code and the tray explains the required cleanup.
Unknown command failures use a fixed message; child output is never shown.
`status`, `start`, `stop`, `describe` and configuration controls remain on the
same pipe. Pairing answers contain the code, expiry and live display labels;
private keys never leave the service. The pipe admits local Administrators and
recorded accounts, refuses remote clients, and refreshes its account list at
each connection.

**Folder and policy controls remain local.** The Executors page shows the
selected folder's basename so a person can recognize the active boundary, but
the full path never leaves the companion. Nessie uses one canonical workspace
root per local pairing. **Change folder** opens the native picker and
confirmation, refuses while any local draft or sandbox remains, and submits a
new signed descriptor revision for review when the daemon is running. If it is
stopped, the revision remains local until the next Start; the stopped executor
is never briefly advertised as online. It never broadens several folders to a
common parent. The operation checkboxes are populated from that executor's
stored local descriptor rather than optimistic defaults. **Forget pairing on
this computer** stops the locally supervised daemon, removes the machine key
and folder selection, and permanently deletes its local COW draft copies after
one explicit native confirmation; the server-side executor and audit history
remain for an owner to retain or revoke.

Every native confirmation states the data boundary accurately: the full local
path and pairing secret stay on the machine, while requested file content and
bounded action output are transmitted to Nessie and the configured model
provider when an allowed operation runs. A native refusal is rendered verbatim
on the Executors page so its recovery instruction is not replaced by a generic
web error.

**A tampered install refuses in words rather than disappearing.** Replace
`node.exe` in `Program Files` as an administrator and the service keeps running,
starts no daemon, and answers every control command with the reason; the tray
turns red and shows it; the desktop app's Executors panel shows
`unsigned_release`. Stopping the service instead would leave the tray reporting
"the service is not running", which names the wrong remedy.
