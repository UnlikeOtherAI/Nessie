# Windows Desktop

Chapter of [Running the Native Apps](overview.md).

Run the build on a Windows machine:

```sh
pnpm install --frozen-lockfile
pnpm --dir desktop run tauri:build:embedded -- --bundles nsis
```

That command builds the executor's shared dependencies, embeds the local admin
with its production API origin pinned and verified, and then prepares the exact
Node runtime, native helper, licence, and integrity manifest before Tauri builds
the installer.

`packages/billing-statement-protocol/` is a byte-for-byte vendored UOA
contract. Git preserves its upstream LF bytes on every platform (including
Windows), without applying `core.autocrlf`, so its generated-artifact and
SHA-256 verification gates remain valid. Do not edit or regenerate that package
locally; update its upstream pin instead.

If the local Windows Node installer omits its `LICENSE` file, the build
retrieves and validates the official licence for that exact Node version before
including it in the hash-verified runtime layout.

Tauri uses the Windows bundle settings in `desktop/src-tauri/tauri.conf.json` for NSIS and WiX packaging.

To create a build whose executor controls can be used, pin the publisher:

```sh
NESSIE_DESKTOP_WINDOWS_SIGNER_THUMBPRINT=<SHA1_THUMBPRINT> \
  pnpm --dir desktop run tauri:build:embedded -- --bundles nsis,msi
```

That variable is the Windows analogue of macOS's
`NESSIE_DESKTOP_SIGNING_TEAM_ID`: the SHA-1 thumbprint (40 hexadecimal
characters, case-insensitive) of the code-signing certificate the release is
signed with, compiled into the build. At runtime the companion verifies its own
executable with `WinVerifyTrust` and then reads the signer certificate out of
that verification and compares its thumbprint to the pinned one — `WinVerifyTrust`
alone answers "trusted", never "by whom", so a build validly signed by anyone
else is refused exactly like an unsigned one. Sign the bundle with that same
certificate after building it, and do not replace a pinned build with a
differently signed copy: its executor controls will intentionally stay
unavailable. The packaged executor runtime's hash manifest is checked as a
second gate, as on every platform. The trusted workflow also compiles the
manifest's exact Node, executor-bundle, and native-helper hashes into the
desktop executable before signing it. A per-user install is writable by that
user, so the adjacent manifest is never its own authority: replacing JavaScript
and rewriting the manifest still fails against the copy held by the signed
application.

The build above is otherwise an unsigned development build, and without the
pinned thumbprint the Executors panel reports `unsigned_release` and names the
remedy rather than disappearing. On a machine with no Hyper-V — Windows Home,
where it is an edition rather than a setting — the companion pairs as
`workspace_only`: file review and drafts work, sandboxed commands, browsers and
coding sessions do not. A second launch carries the `nessie://` sign-in callback
into the running instance.

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
their valid upstream Authenticode signature. It
runs on `workflow_dispatch` and on a `desktop-v*` tag.

The Windows job also runs the executor's real control loop against a local
protocol peer: enrollment, fresh challenge and claim, descriptor, heartbeat,
poll, receipts, an allowed selected-folder read, a refused traversal, a COW
write, and a draft review. The test uses the packaged Windows DACL helper and
asserts that neither the selected host root nor an outside folder was changed.

Signing is a deployment fact, configured through repository secrets. The
recommended configuration is **Azure Artifact Signing** (formerly Azure Trusted
Signing) through Tauri's `bundle.windows.signCommand`, because no private key
is ever present on a runner and SmartScreen reputation attaches to the managed
identity; an OV/EV certificate through `certificateThumbprint` +
`timestampUrl` is the alternative, and EV gives immediate SmartScreen
reputation. The keys are placeholders in
`desktop/src-tauri/tauri.windows.conf.json` (`digestAlgorithm` is `sha256`; the
rest are `null`) and the workflow overrides them:

A `desktop-v*` tag is a release boundary: the workflow fails immediately when
any signing setting is absent, and every Nessie executable and installer must
have a valid signature whose subject and exact certificate thumbprint match the
pinned publisher. A manual run of the exact `main` branch with `source_ref`
empty is also a signed verification boundary and fails closed when the signer
is absent. This produces an installable security-test artifact without minting
a release tag. Manual source overrides and non-main runs never receive signing
credentials and remain unsigned development evidence only. They also never
reach the persistent self-hosted Hyper-V runner; its administrator-level job is
gated to the exact trusted `main` run or a release tag, after the signed build
and install checks pass.

| Secret | What it holds |
| --- | --- |
| `WINDOWS_SIGN_COMMAND` | the whole sign command, with `%1` where the file goes |
| `WINDOWS_SIGN_TOOL_INSTALL` | the command that installs that signing CLI on the runner |
| `WINDOWS_SIGNER_THUMBPRINT` | the publisher compiled into the release as `NESSIE_DESKTOP_WINDOWS_SIGNER_THUMBPRINT` |
| `WINDOWS_SIGNER_SUBJECT` | the certificate subject every artifact is verified against |
| `AZURE_CLIENT_ID` / `AZURE_TENANT_ID` / `AZURE_CLIENT_SECRET` | passed to the signing CLI when the configuration is Azure |

With all of them set, the workflow verifies every `.exe` and `.msi` with
`Get-AuthenticodeSignature` and fails unless each reports `Valid` with the
expected subject. With them absent it prints an **unsigned development build**
warning, skips the gate, and never calls the result a release — and because no
publisher is pinned into it, the desktop companion and the executor service
both refuse executor controls, which is the same refusal a tampered build gets.

**Verify a signature yourself**, on any machine:

```powershell
Get-AuthenticodeSignature .\Nessie_<version>_x64-setup.exe |
  Format-List Status, StatusMessage, SignerCertificate
```

`Status` must be `Valid` and the certificate subject must be the expected
publisher. The same file's SHA-256 is in `SHA256SUMS` beside it:

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
dotnet tool install --global wix --version 7.0.0
node executor\packaging\windows\build-msi.mjs
# dist\NessieExecutor_<version>_x64.msi
# dist\NessieExecutor_<version>_x64.msi.sha256
```

`NESSIE_EXECUTOR_VERSION` overrides the version taken from
`executor/package.json`; it must be `major.minor.build`, which is all Windows
Installer compares. `NESSIE_WINDOWS_SIGN_COMMAND` (carrying `%1`) signs the
three binaries the package builds *before* they are staged, because the native
helper's bytes are pinned in the runtime manifest and a signature added
afterwards would no longer match it.

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
SHA-256 per file. The guest's FAT32 boot disk is written by the executor itself,
so nothing else is installed for it. Then it:

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
- creates `%ProgramData%\Nessie Executor\executors\`, which the service secures
  with an owner-only DACL (the service account plus SYSTEM) the first time it
  starts, through the same packaged native helper the CLI uses;
- adds a `Run` entry for the installing user so the tray starts at their next
  logon.

**Uninstall** (`msiexec /x`) stops and removes the service, removes the
registry entries and the Run entry, and **leaves `%ProgramData%\Nessie Executor`
in place**. That is deliberate: a pairing is a machine key and a signed policy
revision, and removing a program is not a request to destroy them. Reinstalling
finds its pairings where it left them; delete the folder by hand to forget them.

**Pair from the tray.** In Nessie, **Agents → Executors → Pair executor**
produces an invitation. In the tray: **Pair a new executor…** → paste the
pairing command or link → choose the workspace in the native picker → confirm →
approve one Windows administrator prompt → confirm the fingerprint in Nessie.
The icon turns green. After a reboot the executor is online before anybody logs
in.

That administrator prompt is the only one, and it is worth knowing what it is
for: the daemon runs as a service account with no rights anywhere a person
keeps their work, so somebody with administrative rights has to grant
`NT SERVICE\NessieExecutor` **Read** on the workspace root. Draft changes are
written only to the service's private COW state. The elevated step
merges that one entry into the directory's existing permissions — it never
replaces them — and records the pairing account's SID under the service root.
That recorded SID is what admits the person's ordinary, unelevated tray to the
control pipe afterwards, so nothing prompts again.

**The tray.** Grey means nothing is running, green means a daemon is up, amber
means something is in flight (awaiting a fingerprint confirmation, or a daemon
still tearing its guests down), red means the service could not be reached or
refused to supervise — and the menu's first line says which. Right-click gives
that line, a submenu per paired executor with **Start** and **Stop**, **Pair a
new executor…**, **Open Nessie**, **Open logs folder**, and **Quit**. Quit ends
the tray only: the service and every daemon it supervises keep running, and the
menu entry says so. Left-click opens a small frameless status window with the
same list and the same actions. Every change confirms in a native dialog first.

**The service and the tray talk over `\\.\pipe\NessieExecutor`**, one JSON line
each way, carrying the same five commands the desktop companion offers —
status, pair, start, stop, configure — with the same argument validation. Its
answers carry executor ids and daemon states and nothing else: no path, no key,
no challenge, no child-process output. The pipe admits local Administrators and
the accounts recorded at pairing, refuses remote clients outright, and is
rebuilt with the current account list every time it accepts a connection.

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
