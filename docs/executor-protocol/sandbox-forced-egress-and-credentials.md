# 8. Sandbox, forced egress, and credentials

Chapter of [the executor protocol](overview.md); section numbering follows the overview.

The backend is a per-session Linux micro-VM. The selected workspace is
read-only through virtiofs. It has no host shell, home, Docker socket, SSH
agent, host mount beyond that root, inherited environment, or direct network.
The descriptor's `sandboxBackend` names which hypervisor starts that guest on
this host (§4.5); the guest protocol — kernel + initrd boot, a vsock control
channel, no network device, all egress through the daemon's forced gateway —
is the same one on every backend, and a host reporting `none` runs no guest and
advertises only the copy-on-write workspace bundle.

`executor/vm` is the macOS-native bootstrap boundary for the
`virtualization_framework` backend. Its
checked-in Swift package can probe support and validate a proposed Linux boot
configuration on Apple Silicon/macOS 15+: owner-owned, non-link, single-link
kernel/initrd/disk files; a bounded CPU/memory allocation; a read-only guest
disk; and entropy only. Its configuration deliberately contains no virtual
NIC, host filesystem share, graphics attachment, or host process bridge. It
does not advertise any executor operation. Normal configuration validation does
not start a guest; its separate release-candidate smoke command may start and
stop one signed helper process only to prove the packaging boundary. A later
guest broker must add the COW share and forced-egress endpoint as one reviewed
unit; a browser or coding descriptor is forbidden until that unit is live.
The macOS-native verification command is `swift test --package-path executor/vm`.
The bootstrap also has a fixed, guest-initiated virtio-socket control port for
that future broker. It is one connection on one VM's device, rejects replacement
while live, and is neither a host TCP listener nor a route to another VM. Its
checked-in `GuestControlSession` owns that connection's non-blocking file
descriptor but never closes it itself: terminal state returns ownership to the
matching `VZVirtioSocketConnection`, preventing descriptor reuse from crossing
VMs. It carries no executable descriptor capability until the guest broker, run
binding, COW transport, and egress route are delivered together.

Its v1 transport codec is a 4-byte big-endian length plus at most a 64 KiB JSON
frame, with a 32 KiB payload ceiling; streaming input holds only a partial frame
plus one fixed read chunk. The guest's first and only token-bearing frame is an
empty-payload `hello` containing a fresh 32-byte base64url boot token; request,
response, and close frames cannot carry that token. The host verifies that exact
hello in constant-time before any request, accepts no guest-initiated request,
and permits only one host request awaiting a matching response. It closes the
channel on malformed/unsolicited input, I/O failure, a 10-second handshake
deadline, or a bounded request deadline (30 seconds by default, never over five
minutes). The per-session initrd builder remains responsible for provisioning
the token only to the matching guest. Frames themselves remain capability-free
until typed browser/coding schemas and a run-bound handler exist.

The later egress channel has a separate session proof, never a replay of the
control hello. Both ends derive its 43-byte base64url value as
`HMAC-SHA-256(bootstrapToken, "nessie-executor-egress-v1")`. The control token
is still accepted only in the first control `hello`; it is not persisted,
placed in an egress frame, or retained after that hello. The derived value is
kept only by the guest proxy and the matching host VM broker, which use it to
authenticate a dedicated guest-initiated tunnel before the broker can connect
to the owner-only local CONNECT gateway. This derivation is checked in on both
the Swift host and Linux guest. The host now has the corresponding per-VM
virtio listener, but no guest proxy, gateway bridge, or browser descriptor
exists yet.

That future tunnel begins with exactly 48 bytes: ASCII `NEXG`, byte version
`1`, then the 43-byte derived base64url token. It is a one-way authentication
prelude, not a control envelope: it has no request ID, payload, operation,
policy, or bootstrap credential. Any short, long, unknown-version, malformed,
or non-canonical prelude is rejected before its remaining bytes could reach the
daemon's CONNECT gateway. The listener rejects a wrong but well-formed session
proof in constant time, has a maximum of 16 active or admitting tunnels, and
gives an authenticated descriptor only to its VM-bound bridge callback. It
does not parse HTTP, resolve a name, create a TCP connection, or point at a
generic host socket; the descriptor is closed when its exact tunnel owner
releases it.

`executor/guest` is the first guest image component: a statically linked Linux
arm64 `/init`, with no shell, package manager, host mount, or network client.
`build-guest-initrd.sh` accepts the canonical bootstrap token only on standard
input (never an argument or log), rejects a non-canonical value, and writes a
one-use uncompressed initrd only into a new file in an owner-only `0700` parent.
The archive and its private parent are session material and must be removed by
the VM owner after the VM stops. On boot the guest validates and removes its
token file before it connects to host CID 2 on the fixed virtio port, sends the
hello, and clears its mutable token buffer. It implements the reviewed typed
browser, command, and coding handlers; an unknown or malformed host request
still receives only `EXECUTOR_GUEST_CAPABILITY_UNAVAILABLE`.

Root exists in the guest only long enough to mount `/proc` and the explicitly
requested COW virtiofs share and to remove the one-use token file. Before it
opens a control or egress socket, init drops groups, GID, and UID to the COW
mount's non-root visible owner (or `65534:65534` when no workspace is mounted).
A root-owned share fails boot instead of leaving a privileged workload behind.
Browser, CLI, and any future child process inherit that unprivileged identity;
there is no setuid helper or privilege reacquisition path in the guest image.

The VM configuration can now add exactly one `nessie-cow` virtiofs device. It
is writable only from inside the guest and mounts at `/work` with `nodev`,
`nosuid`, and `noexec`; the host directory must be an absolute, non-link,
owner-private ordinary directory. This primitive is intentionally not a generic
share or a command-line feature. Its eventual launcher must derive that URL
only from `ensureSandboxWorkspace` for the exact server-bound run, never from a
paired root, user request, model value, or descriptor field. The guest exits
before hello if its explicitly requested COW mount cannot be made. No current
descriptor attaches this device, so it cannot weaken the existing COW-only
operation set.

The same configuration has a separate `nessie.egress=1` guest boot flag, but
it refuses to set that flag unless the matching control socket is enabled. The
guest then binds its proxy only to `127.0.0.1:8137`, caps itself at 16 streams,
and opens each only through host-CID virtio port `49153` after writing the
derived-tunnel prelude. It has no TCP listener outside loopback and no direct
guest network interface. The matching host bridge accepts only an authenticated
VM-bound descriptor and an absolute, non-link, current-user-owned Unix socket
in an owner-only directory (maximum 96 path bytes). It copies bounded buffered
bytes in each direction to that socket, then closes both ends on EOF, I/O
failure, or overflow. It has no origin, HTTP, DNS, credential, TCP, or remote
socket code; those decisions remain inside the already owner-private CONNECT
gateway. The daemon uses this route only for a reviewed, locally configured,
exact-run browser session; it still exposes neither a general proxy nor any
coding operation.

The signed helper now has an internal long-lived `session` command for the
companion launcher. It requires the lease-derived COW directory, an existing
owner-private CONNECT-gateway socket, and the boot token on standard input. It
starts the VM with egress booted but admission closed; only a verified control
hello opens the egress listener, which then creates one bridge per authenticated
tunnel. The companion allocates that socket in a distinct short owner-private
temporary directory—rather than relaxing the 96-byte Unix-socket bound for a
possibly deep COW path—and deletes it with the session. It emits a sanitized
ready result and stops every bridge, socket, and VM on signal or control-channel
termination. A reviewed `browser.open` daemon command can now start this
session only from a server-bound run and an owner-configured local browser
policy; the channel composer is its human-only doorway. It is not a general
browser, proxy, shell, or coding-session facility.

After that ready line, the already private helper stdin/stdout pipes become the
only companion-to-helper control transport. The helper reads exactly the 43-byte
bootstrap first (without treating EOF as part of the token), then accepts only
bounded length-delimited normal request frames and returns only the matching
response frames. It has no TCP or Unix control listener. A wrong frame, wrong
response ID, response overflow, pipe close, or request timeout terminates the
VM session; at most one guest request is outstanding. The first typed request,
`runtime.inspect`, returns only booleans for declared browser/tmux/Codex/Claude
entrypoints. It proves the authenticated companion → helper → guest path; typed
run-bound handlers remain responsible for starting an operation.

The same private seam implements the browser bundle for the exact server-bound
run whose reviewed local policy contains all browser operations. Its caller must
pass the local exact HTTPS-origin policy before forwarding; the
guest independently accepts only a bounded HTTPS URL without credentials or a
port. It executes only the manifest-declared browser under `/runtime`, never a
shell or `PATH` lookup, with a fixed no-first-run/no-QUIC proxy argv and an
environment containing only a COW-local `HOME` and `TMPDIR`. Its profile must
be owner-private under `/work` and rejects pre-existing links or shared
directories. The browser can reach only the guest loopback proxy, whose
authenticated egress bridge still enforces the local origin policy. This is a
bounded product operation: it has no remote debugging listener, general
workflow-selection parameter, or agent path outside the exact bound tool, and
it is stopped with its VM session. Its `browser.observe` request can query only
the browser's fixed guest-loopback DevTools `/json/list` endpoint through a
dialer pinned to `127.0.0.1:9222`; it returns at most 32 sanitized page targets,
a bounded a11y tree (≤200 nodes), and an optional ≤8 KiB downscaled WebP inside
the 64 KiB control-frame ceiling. `browser.act` cannot evaluate script or accept
coordinates: it drives the five typed actions over CDP and requires a freshly
observed node for element actions. It cannot connect to any other address or
expose a DevTools WebSocket. The daemon keeps the live VM only under the
server-provenanced run ID, rejects a second browser launch for that run, and
does not let a browser command select a different VM or executor.

Browser, command, and coding runtimes enter a session only as a complete
owner-private `nessie-guest-runtime.json` bundle. Its versioned manifest names
every regular file, its SHA-256 digest, and whether it is executable; it also
names only declared executable browser, tmux, Codex, and Claude entrypoints.
The companion rejects symbolic links, hard links, shared permissions, extra or
missing files, invalid relative paths, non-owner files, a changed digest, and
a bundle with neither browser nor tmux. Verification produces an artifact
reference only: it does not execute a host file, search `PATH`, or make the
bundle an advertised descriptor capability. It hashes runtime artifacts in
bounded streams rather than loading an executable payload into companion
memory. Before a session starts, the companion copies the already verified,
manifest-digest-bound source into a new lease-owned `runtime` directory, hashes
the copied files again, and makes its files and directories non-writable. The
VM mounts that session snapshot—not the source bundle—so later source-bundle
edits cannot change a running guest. Teardown restores only the private
snapshot directories long enough for the companion to delete them. A later
guest-image mount must still carry that snapshot into the VM and re-check its
exact digest.

The VM now mounts that verified bundle on its own `nessie-runtime` virtiofs tag
at `/runtime`, read-only with `nosuid,nodev`. Unlike the COW workspace it is
executable: a `noexec` runtime mount would make a browser, tmux, or CLI
impossible. The writable `/work` COW mount remains `nodev,nosuid,noexec`, so
guest execution can originate only from the read-only runtime payload (or the
fixed initrd `/init`), never from a workspace edit. A runtime-requested boot
fails before control hello if its exact mount is unavailable. The companion
passes the verified manifest's `sha256:` digest in the VM-only boot contract;
before privilege drop or control hello, the guest hashes that manifest, rejects
an altered/duplicate/missing digest, validates the declared file set and
entrypoints, and hashes every runtime file again. A changed bundle therefore
fails closed across the host-to-guest mount interval rather than relying on the
host-side check alone.

Before that launch, the companion creates an owner-only `guest-lease.json`
beside the exact COW draft. It contains the run ID, executor binding fence, and
server command ID plus a random local lease ID—never a host path, token, or raw
argument. A second lease or sandbox stop fails while it exists; release requires
all four exact values. This makes VM teardown/recovery an explicit state change
instead of allowing a new command to erase a live guest's draft.

`runGuestVmHandshake` is the companion-only bridge between that lease and the
signed helper. It re-reads the durable lease immediately before each child
process, verifies owner-private builder/kernel/helper artifacts, creates a
fresh private VM directory, and sends the random boot token only to each
child's standard input. Its helper argv contains the lease's COW workspace and
no other host root. It discards the token-bearing initrd/console directory and
releases the lease in `finally`; a child timeout kills the helper first. This
is still a handshake probe, not a model tool or an `ExecutorSession` launch.

The signed helper's `handshake` command is the release-candidate integration
check for that exact pair. It reads the same 43-byte token from standard input,
starts one VM with the control socket enabled, requires the matching guest hello
within its bounded timeout, invalidates the socket, and stops the VM. It prints
only a verified/failure status, never the token, guest output, or a local path.
It creates no `ExecutorSession`, binding, descriptor, or executor operation;
`EXECUTOR_VM_GUEST_HANDSHAKE_FAILED` is a local packaging/guest failure and must
keep browser and coding profiles unavailable.

### Linux backend — Firecracker

On Linux the same guest runs under Firecracker, one micro-VM per session. Only
the hypervisor and the *shape of its two shares* differ: the artifact checks,
the COW lease, the initrd build, the runtime snapshot, the forced-egress
gateway, and every guest frame above them are shared, and the choice between
backends is made once from the descriptor's own `sandboxBackend` (§4.5) by
`selectGuestVmBackend`. A host reporting `none` or `hyperv` is refused there in
words rather than falling through to another backend.

**Binaries.** The executor's stored `browserSandbox`/`codexSandbox`
`vmHelperPath` is the Firecracker binary itself; `kernelPath` is the packaged
guest kernel and `guestInitrdBuilderPath` the packaged initrd builder. The
standalone package installs all of them root-owned under
`/usr/lib/nessie-executor/resources/`: `firecracker/firecracker` pinned by
version *and* by the SHA-256 the upstream release publishes for its own
archive, and `guest/{init,build-initrd,vmlinux}`, with every shipped resource's
digest recorded in `resources/manifest.json`. No executor state field was
added: the Linux meaning of the existing paths is this paragraph.

**Root ownership is the second admissible provenance.** A guest artifact is
admitted by `verifyPrivateGuestVmFile` if it is this account's own file with no
group or other permissions at all, **or** if it is owned by uid 0, is not group-
or world-writable, and resolves under `/usr/lib` or `/usr/share`. The second is
not a relaxation of the first: apt verifies the repository signature and dpkg
lays those files down root-owned, a state only an administrator can produce, so
a user-writable copy in a home directory can never impersonate it. Symbolic
links are refused on either path, and root ownership *outside* those prefixes
proves nothing and is refused.

**No jailer, and therefore no chroot.** Firecracker documents its jailer as
running as root — it unshares a mount namespace, `pivot_root`s into a session
chroot, `mknod`s `/dev/kvm` and chowns the jail before dropping privileges — and
neither Linux supervisor is root: the standalone package is a systemd *user*
service and the desktop supervisor runs as the person. The backend therefore
runs Firecracker directly, the posture upstream's own getting-started guide
uses, and takes its isolation from what it does not configure: no network
interface and so no TAP device, an owner-only directory for every socket and
image, and Firecracker's **default seccomp filter**, which is on unless
`--no-seccomp` is passed and is deliberately never passed. The host gate is
therefore read/write access to `/dev/kvm`, refused before anything is staged
with the `kvm` group named as the remedy. A privileged launcher that could
restore the jailer is a stated non-goal of this release
([the Linux plan](../plans/2026-09-01-linux-desktop-delivery.md) records why).

**Configuration.** Per session the backend spawns
`firecracker --api-sock <owner-only path> --id <session>` — an argv list, never
a shell string — waits for the API socket, and issues these calls on it:

| Call | Body |
| --- | --- |
| `PUT /boot-source` | `kernel_image_path`, `initrd_path`, and `boot_args` |
| `PUT /machine-config` | `vcpu_count`, `mem_size_mib`, `smt: false` |
| `PUT /vsock` | `guest_cid: 3`, `uds_path` |
| `PUT /drives/{runtime,workspace,draft}` | `drive_id`, `path_on_host`, `is_root_device: false`, `is_read_only` |
| `PUT /actions` | `{"action_type": "InstanceStart"}` |

There is deliberately **no** `PUT /network-interfaces` and no TAP device is
ever created. The guest's only route off the machine is the same vsock-bridged
forced-egress gateway it has on macOS.

`boot_args` is Firecracker's documented baseline `console=ttyS0 reboot=k
panic=1 pci=off` plus `rdinit=/init` and the `nessie.*` flags the guest reads
back out of `/proc/cmdline` — `nessie.runtime_manifest=<digest>`,
`nessie.runtime=1`, `nessie.workspace=1`, `nessie.shares=block`, and
`nessie.egress=1` for a session that has a gateway. The guest init stays in the
initramfs and never calls `pivot_root`: an initrd-mounted rootfs cannot be
unmounted, so Firecracker's documentation requires `switch_root` instead, and
mounting in place satisfies that by construction.

**Shares are block images, because no hypervisor but Apple's has virtio-fs.**
The guest mounts `/runtime` and `/work` as virtiofs on macOS; Firecracker
implements no virtio-fs device and neither does Hyper-V, so on those hosts the
same two shares arrive as raw ext4 images over virtio-block. The images are
built per session **without root** by `mke2fs -d`, which populates a filesystem
from a directory tree in userspace — no loop device, no `mount`, no privileged
helper — with `-E root_owner=<uid>:<gid>` so the guest drops to the account that
owns the workspace rather than to root, `-N` sizing the inode table from the
measured file count, and `-O ^has_journal -m 0` because a session image is never
recovered. The daemon refuses to build them at all when it is running as uid 0,
naming that rather than letting the guest fail its own root-owned-workspace
check at boot. A machine with no `mkfs.ext4` is told to install e2fsprogs.

Three images, and the attach order **is** the contract: Firecracker's block
devices appear in the guest in the order they were configured, so the host
attaches runtime, workspace, draft and the guest reads `/dev/vda`, `/dev/vdb`,
`/dev/vdc`. That ordering has been an upstream bug before (device-tree
insertion order on aarch64, firecracker#1264), so each image also carries an
ext4 volume label — `nessie-runtime`, `nessie-work`, `nessie-draft` — that the
guest reads straight out of the superblock and refuses if it is not the one the
order promised. The order decides; the label proves. Both halves are stated in
`GUEST_BLOCK_DEVICE_ORDER` (`executor/src/firecracker/layout.ts`) and in
`executor/guest/mounts_linux.go`.

Inside the guest the paths are unchanged. `/runtime` is the runtime image,
read-only, `nosuid,nodev` and deliberately executable. `/work` is an **overlay**:
the workspace image is the read-only lower layer, the draft image the writable
upper and work layers, mounted `nodev,nosuid,noexec`, so guest execution can
still originate only from the read-only runtime or the initrd's own `/init`. The
merged root takes its owner from the upper layer, so the draft image's root
owner is what the guest drops privileges to — the same derivation virtiofs
gives it. The overlay is mounted `userxattr`, which puts overlayfs's own markers
in the `user.` namespace instead of `trusted.` (which needs CAP_SYS_ADMIN to
read); that is what lets the guest still report a directory its workload emptied
after it has dropped privileges, and it requires Linux 5.11 or newer. The
packaged kernel is Firecracker's own CI 6.1 build, pinned by key and by the
SHA-256 of the bytes that key returned — upstream publishes no checksum file
beside these objects, unlike its release archives, so the digest recorded in
`build-deb.mjs` is what makes a later change to the object fail the build.

**Drafts come back over the control channel; the host never parses ext4.** Two
new control operations carry them. `workspace.draft_scan {cursor}` pages the
overlay's upper layer — at most 64 entries a call, pre-order so a directory
always precedes its contents, names sorted — each entry a relative path,
permission bits and one of `file`, `dir` or `whiteout` (overlayfs records a
deletion as a 0:0 character device), with `opaque` on a directory the workload
emptied. `workspace.draft_read {path, offset, maxResultBytes}` returns at most
16 KiB of a regular file, well inside the 32 KiB payload ceiling. Symbolic
links, sockets and fifos are never reported: they have no promotion meaning.
The guest refuses an absolute path, a `.`/`..` segment or any symbolic-link
component, and the host independently re-validates every path through
`resolveWorkspaceWritePath` — the same no-follow resolver promotion uses — and
writes with `O_NOFOLLOW`, bounded at 10,000 files and 128 MiB. A whiteout
removes; an opaque directory is emptied before the entries that follow are
applied, which is what makes `rm -rf dir` visible to a review.

The session drains that stream into the run's own overlay directory before it
stops, and `sandbox-workspace.ts` drains it again at the top of
`promotionManifestForSandbox`, so `workspace.review` and promotion keep their
exact contracts and see live work. A block-mode session registers its flush by
run id for the duration; a virtiofs session registers nothing, because its guest
already wrote straight into that directory — the absence of a draft reader on
`ActiveGuestVmSessionProcess` *is* the fact that the share is a share.

**The initrd builder is a portable binary.** `executor/vm/scripts/build-guest-initrd.sh`
uses BSD `stat -f` and shells out to `go build`, so it is macOS-only and needs a
Go toolchain on the machine running the daemon. `executor/guest/cmd/build-initrd`
is a drop-in for the same `guestInitrdBuilderPath` contract —
`--output <absolute> [--codex-auth <absolute>] --bootstrap-token-stdin`, token
on standard input only, never argv, never a log, never an error message — that
writes a gzip newc cpio archive from an already-built guest init found as its
own sibling (`--init` overrides). Output is deterministic: mtime 0, uid/gid 0, a
fixed member order and a timestamp-free gzip header, so identical inputs give
byte-identical archives. Members are `/init` 0500, `/etc` and `/etc/nessie`
0700, the one-use token 0400, and the Codex auth profile 0400 when one is
staged. The macOS shell builder is unchanged and still in use there.

**Transports.** Firecracker maps guest `AF_VSOCK` ports 1:1 onto host Unix
sockets. Both of Nessie's channels are guest-initiated, so both arrive on
`<uds_path>_<port>` listeners the backend opens *before* `InstanceStart` —
Firecracker resets a guest connection for which nothing is listening. Port
49152 is the control channel and 49153 the forced-egress tunnel, the same
numbers the macOS helper uses. The control listener admits one connection,
reads the guest's `hello` frame, compares its token in constant time, and only
then presents the stream to the shared control client, exactly as the signed
Swift helper does; a second connection is destroyed rather than allowed to
replace a live channel. Each egress tunnel presents the 48-byte
`NEXG`+version+token prelude derived as
`HMAC-SHA-256(bootstrapToken, "nessie-executor-egress-v1")` before its bytes
are relayed to the daemon's owner-only CONNECT gateway.

The host-initiated direction is implemented for completeness and follows
Firecracker's framing: connect to `uds_path`, send `CONNECT <port>\n`, and wait
for `OK <assigned_hostside_port>\n` before speaking anything else. Nothing in
the session path uses it, because the guest dials out on both channels.

**Path length.** `sun_path` is 108 bytes on Linux and the executor's state root
already spends most of it, so the API socket and both vsock sockets live in
their own short owner-only temporary root — the same treatment the egress socket
already gets — and a session id is 16 hex characters rather than a UUID. The
drive images have no such bound and stay in the session directory under the
state root, where they are disk-backed rather than on a tmpfs.

**Stop.** Closing the control channel is what ends this guest: its init returns
on EOF. `SendCtrlAltDel` is issued as the documented graceful action but is
best-effort, because Firecracker documents it as Intel and AMD only — it
emulates an i8042 keyboard that aarch64 micro-VMs do not have. The backend then
waits, kills the process on timeout, and removes both the socket root and the
image directory: a surviving image is a surviving copy of the workspace, so
nothing is left behind on stop, on guest exit, or on any failure during start.

**Not yet proven on hardware.** Every layer above has host-side coverage — the
argv and API sequence, a real `mke2fs -d` image verified with `e2fsck` and
`debugfs`, the draft protocol asserted against one fixture both the Go encoder
and the host validator are tested on, the device-order contract, and a
deterministic initrd whose members are decoded back out — but no guest has
booted. That needs `/dev/kvm`. The KVM-gated `firecracker-conformance` job in
`.github/workflows/desktop-linux.yml` is where the boot is proved; it fails
rather than skips when `/dev/kvm` is absent, and GitHub-hosted runners have
none.

### Desktop-packaged companion

A companion launched this way is the `desktop` supervisor: the shell sets
`NESSIE_EXECUTOR_SUPERVISOR=desktop`, the descriptor states it, and the
Executors page offers this panel's controls rather than the standalone
package's command line (§4.5).

Nessie Desktop packages the executor CLI as a bundled CommonJS entrypoint with
the exact Node runtime used to build it, that runtime's license, and a
hash-manifest. The desktop process verifies that each packaged file is ordinary
and that both executable hashes match the manifest before it launches the
daemon. A signed release's application signature protects the manifest and
resources; the hash check makes a damaged or partial local bundle fail closed.

The remote admin webview can ask the desktop process only to pair an existing
server invitation, start/stop an already paired executor, or change the initial
workspace-operation policy. It cannot name an executable, a state directory, a
workspace path, or arbitrary command arguments. Workspace selection occurs in a
native folder dialog, the state directory is derived privately from the server
executor id, and every mutable action is repeated in an OS-native confirmation
dialog. The pairing challenge is written to the packaged CLI's standard input
through `--pair-input-stdin` together with the locally selected workspace,
never passed in the child argument list. The desktop IPC response reports only
executor id and daemon state; it never returns the local path, key, auth profile
path, terminal output, browser data, or secret.

The desktop policy editor currently controls only the COW workspace bundle.
Browser/Codex configuration continues to require their separately verified CLI
artifact inputs and cannot be upgraded into a desktop action by webview input.
Release IPC is available only to `https://app.nessie.works` after the outer app
has passed a pinned Developer ID team/signature check; the development build has
a separate local-only capability and cannot target the production API. On a
desktop exit, a private parent-liveness pipe makes the daemon stop all guest
sessions before it drops its owner-only singleton lease, so a restarted desktop
does not duplicate a still-tearing-down daemon.

### Managed Codex coding sessions

`nessie-executor configure-codex` verifies an owner-private Codex auth-file
*path* and the exact guest artifacts, then proposes a new descriptor revision
containing `coding.launch`, `coding.observe`, `workspace.review`, and
`sandbox.stop`. The source contents never reach Node, executor state, a
descriptor, Nessie, logs, or command arguments: the owner-controlled initrd
builder alone reads it, the guest moves it once into a fresh private home below
`/run/nessie-executor`, and removes the root-only initrd leaf before dropping
privileges. VM teardown removes that home and the whole initrd.

Each approved coding run is exactly that four-operation bundle on a fresh,
otherwise unbound run. `coding.launch` consumes its durable `coding_session`
row from `pending` to `active`, starts the manifest-pinned Codex executable in
one dedicated tmux server, and passes the model instruction only after a `--`
option delimiter. The server has a fixed socket and target (`=nessie:0.0`);
caller input, display names, and a pre-existing tmux server never become
targets. The guest can reach only `https://chatgpt.com` through the pinned
companion gateway. There is no direct DNS, network, host home, keychain,
global Codex configuration, or API-token environment inheritance.

The authenticated outer Codex process uses its guest-private home, but the
model-generated child commands run in the named workspace sandbox. That policy
denies the whole executor-control directory and network access. Before launch,
the exact Codex binary must prove that both direct and nested
dangerously-permissive child sandboxes receive `EACCES`/`EPERM` when attempting
to read the control/auth canaries, connect to the tmux socket, or reach the
known-live guest egress listener. A failed proof fails the launch. This makes
the authenticated parent and its model-controlled children distinct enforced
principals rather than relying on same-UID modes or an environment variable.

`coding.observe` returns only typed `{ agent, lifecycle, exitStatus? }` state.
The companion derives that state solely from the fixed tmux dead-pane fields;
it never captures a terminal pane. An exited session moves to `attention`, where
the agent may use the bundle's `workspace.review` operation; `sandbox.stop`, a
timeout, daemon fencing, VM exit, or revocation stops the guest and erases the
transient login material. There is no remote terminal attach, prompt channel,
or terminal-control API.

Its optional `--workspace-cow` argument exists only for the companion's
lease-derived release probe. It passes that one COW directory into the fixed VM
configuration, so the guest must mount it before hello can succeed. It is never
populated from a server command, model tool argument, browser request, or UI
field; the daemon's lease object is the only supported source.
The helper carries the `com.apple.security.virtualization` and
`com.apple.security.hypervisor` entitlements. `sh
executor/vm/scripts/build-signed-vm-helper.sh` creates an ad-hoc local validator
only; a runnable release helper must be embedded in the signed companion app
with its release provisioning profile. An unsigned or improperly signed helper
fails closed in `Virtualization.framework` before a guest can start. Its `smoke`
command is therefore a release-candidate integration check, not a host fallback
or a development-mode substitute for that packaging boundary.

The guest's only virtual NIC terminates at the daemon's authenticated egress
gateway. There is no NAT bridge or direct DNS resolver; firewall rules deny
direct TCP, UDP/QUIC, proxy bypass, and alternate DNS. Chromium must use this
gateway. The gateway enforces HTTP(S), CONNECT, WebSocket, redirect, origin,
download, and upload policy. It uses `@nessie/runtime` `safeFetch` or
`pinnedFetch` for HTTP handling and constrained `pinnedConnect` for the raw
CONNECT transport, rather than implementing a second SSRF policy.

The companion gateway is an owner-only Unix-socket HTTPS CONNECT listener with
no TCP listener or generic forwarding mode. Its raw socket path uses runtime
`pinnedConnect`, so URL validation and literal-IP dial occur as one operation
rather than validating then re-resolving a hostname. Each browser or coding VM
gets its own bridge, runtime snapshot, and guest profile; browser origins come
only from the owner-local allowlist, while Codex has its one fixed origin.

The managed runtime can contain Codex and Claude artifacts, but the product
coding bundle launches only Codex. Neither host `~/.codex`/`~/.claude`, the
keychain, nor global CLI tokens are mounted. The only supported login source is
the staged owner-private Codex auth file described above; a CLI-inherited proof,
environment variable, or same-UID helper would give arbitrary workspace code a
delegated provider capability and is forbidden. Executor fencing and teardown
close the guest route immediately.

Raw local data can reach a model provider only within the explicit bounded run
consent. Nessie persists only redacted manifests, argument/policy digests,
result digests, and structured status. Raw file content, terminal output,
browser DOM, credentials, and factor material are forbidden from database
records, audit, logs, realtime events, and error reports.
