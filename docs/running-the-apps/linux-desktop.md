# Linux Desktop

Chapter of [Running the Native Apps](overview.md).

## Pairing and unpairing

In Nessie Desktop, open **Admin › Computers › Pair a computer › Connect this computer**.
Choose a workspace, review the account and team, then confirm the native dialog.
Repeat while signed into another account to add an independent connection;
existing connections continue running. Each executor has its own Start/Stop
controls. The CLI supports the same independent pairings as described below.

For a headless machine, install the standalone Debian executor package as an
administrator, then pair and run it as the ordinary user who owns the local
programs. Do not pair as root.

```sh
sudo apt install ./nessie-executor_<version>_amd64.deb
mkdir -p "$HOME/NessieWorkspace"
nessie-executor pair --api nessie --workspace "$HOME/NessieWorkspace"
```

Claim the displayed code in Nessie's **Admin › Computers › Pair a computer**, choose the
real team and private access for personal terminal programs, then confirm the
named organisation and team in the CLI. The interactive pairing command enables
the service after confirmation. A JSON/noninteractive pairing client must enable
it explicitly, using the executor ID returned by confirmation:

```sh
nessie-executor enable <executor-id> --yes
nessie-executor status
systemctl --user status nessie-executor@<executor-id>.service
journalctl --user -u nessie-executor@<executor-id>.service -n 50
loginctl show-user "$USER" -p Linger
```

Lingering starts the user manager at boot and keeps it running after logout.
Enabling it may require an administrator. Expect `Linger=yes`, an enabled/active
unit and Online in production. State belongs to that user under
`~/.local/state/nessie-executor/<executor-id>`. The package runtime is root-owned
under `/usr/lib/nessie-executor`; its bundle must be mode 0644 even when the
builder uses a group-writable umask. Runtime verification rejects writable code.

Install tmux and authenticate kimix as the same user. Configure its absolute
command path and environment using the [terminal guide](../executor-protocol/terminal-sessions.md).
Keep coding roots separate from the paired workspace and executor state. Review
the resulting capability revision and agent grants in Nessie; pairing alone
does not authorize agent execution.

To unpair, **Disconnect** or **Delete** in Nessie, then run
`nessie-executor disable <executor-id>`. This stops and disables only that unit.
`loginctl disable-linger` affects all of your user services, so use it only if
none must survive logout. Uninstall with `sudo apt remove nessie-executor` if
desired; this is not server revocation. Preserve state until old work is closed
and revocation is complete. To replace a connection, pair again with
`--replace --executor <executor-id>`, review
the new destination, and enable the new executor ID. Never reuse another
computer's state directory.

The desktop shell is not yet a release, but it now compiles on Linux: single
instance with the deep-link feature, the frameless transparent window, and an
executor companion that verifies a package-manager install (root-owned runtime
under `/usr/lib` or `/usr/share`) and reports `workspace_only` when `/dev/kvm`
is not readable and writable by the current user. The Firecracker sandbox
backend is still outstanding. The delivery design — Ubuntu 26.04 x86_64 `.deb`
as the supported install, AppImage as an evaluator artifact for the shell only,
the shared frameless window/notification/sign-in contract, and the desktop app
enabled as an executor — is
[docs/plans/2026-09-01-linux-desktop-delivery.md](../plans/2026-09-01-linux-desktop-delivery.md).
The standalone executor daemon below is built and installed by
`.github/workflows/desktop-linux.yml`, which also builds the shell's `.deb` and
AppImage, publishes SHA-256 checksums, and proves both packages install.

Windows and Linux render one shared undecorated window frame. The traffic-light
controls, window-layout chooser, drag regions, and eight resize edges live above
the router, so they remain available on login, bootstrap, error, and
authenticated screens. Linux clips the transparent native window to rounded
corners while it is not maximized or full screen, and returns to a flush
rectangle in either edge-bound state. The Debian package installs the
`nessie://` handler; development builds and AppImages register their current
executable at runtime. Launch an AppImage once after moving it so the callback
returns to its new location, and a callback launch is forwarded into the
existing process rather than being lost when the second process exits.

WSLg is the development exception: its Linux window is displayed by Windows,
so a Windows browser sends `nessie://` to the installed Windows app. Use the
Linux login screen's **Use Windows session** doorway, copy Session debug from
**Admin › Advanced › Session debug** in the signed-in Windows app, and paste it there. Only the
same-server short-lived access token is imported; cookies, identity claims,
storage, and refresh credentials are ignored. Repeat the transfer after that
token expires. A normal Linux desktop browser does not need this bridge.

### The standalone executor daemon

`nessie-executor` turns a Linux computer with no desktop app into an executor:
a systemd **user** service, one instance per executor id, started at boot and
kept running after logout. The desktop app supervises its own daemon instead
and only while it runs; a computer that should stay online installs this
package.

Build the package (Node 22 — the packaged runtime is a copy of the build
host's Node):

```sh
node executor/packaging/linux/build-deb.mjs
# dist/nessie-executor_<version>_amd64.deb
# dist/nessie-executor_<version>_amd64.deb.sha256
```

`NESSIE_EXECUTOR_VERSION` overrides the version taken from
`executor/package.json`.

**Install.** In production the package comes from the signed Nessie apt
repository, and that signature plus dpkg's root-owned install is the trust
root: the daemon refuses to serve from a runtime that is not root-owned,
under `/usr/lib` or `/usr/share`, and byte-identical to its sha256 manifest.
A locally built file installs the same way for evaluation:

```sh
sha256sum --check dist/nessie-executor_<version>_amd64.deb.sha256
sudo apt install ./dist/nessie-executor_<version>_amd64.deb
```

**Pair.** Copy the command from **Admin › Computers › Pair a computer**; it
carries the enrollment id and challenge:

```sh
nessie-executor pair --api https://api.nessie.works \
  --enrollment <enrollmentId> --challenge <token> \
  --state-dir ~/.local/state/nessie-executor/<executorId> \
  --workspace /absolute/path/to/workspace
```

Then confirm the printed fingerprint in Nessie.

**Enable.** This verifies the paired state and the packaged runtime, reloads
your user manager, starts and enables the service, and turns on lingering:

```sh
nessie-executor enable <executorId>          # prompts before enabling lingering
nessie-executor enable <executorId> --yes    # unattended; no prompt
```

Lingering (`loginctl enable-linger`) starts your systemd user manager at boot
and keeps it running after you log out, which is what keeps the executor online
with nobody signed in. It applies to your whole user account. The command
prints that before it asks, refuses without a terminal unless `--yes` is given,
and changes nothing if you decline.

**Operate.**

```sh
nessie-executor status                # every paired executor, plus linger state
nessie-executor status <executorId>
journalctl --user -u nessie-executor@<executorId>
nessie-executor disable <executorId>  # stops and disables; leaves lingering alone
loginctl disable-linger               # stop the user manager at boot as well
```

Stopping is the daemon's own graceful path: systemd sends `SIGTERM`, the daemon
stops every guest session and releases its lease, and the unit waits fifteen
seconds for a ten-second teardown budget. It never escalates to `SIGKILL`
(`SendSIGKILL=no`), because killing a daemon mid-teardown strands a micro-VM
and a workspace overlay. A stop that hangs is therefore visible rather than
silent — `systemctl --user status nessie-executor@<id>` shows it, and
`systemctl --user kill -s SIGKILL nessie-executor@<id>` is the explicit
escalation.

**Remove.** `nessie-executor disable <executorId>` first, then
`sudo apt remove nessie-executor`. Paired state in
`~/.local/state/nessie-executor/` is yours and is left in place; delete that
directory to forget the pairing, and remove the executor in Nessie.

### Diagnosable failure modes

| Symptom | What proves the cause |
| --- | --- |
| Package refuses to install | The apt error names the missing `libwebkit2gtk-4.1-0` or `libgtk-3-0`; `apt install ./nessie_<v>_amd64.deb` resolves dependencies. |
| Window opens blank or white | A WebKitGTK/driver combination, most often NVIDIA under Wayland. Launch with `WEBKIT_DISABLE_DMABUF_RENDERER=1`; `WEBKIT_DISABLE_COMPOSITING_MODE=1` is the last resort. The shell never sets these itself. |
| Square corners or a black margin | No compositor is running; the frameless window needs one. Ubuntu GNOME always composites. |
| Sign-in never returns | `xdg-mime query default x-scheme-handler/nessie` must name the Nessie desktop entry; an AppImage must be launched once from its current location. |
| No notifications | The session's `org.freedesktop.Notifications` service must be running; launch the app from a terminal once and read the D-Bus error. |
| Executor shows "workspace only" | `ls -l /dev/kvm` and `id` show whether you are in the `kvm` group; log out and back in after adding yourself. |
| `enable` or `serve` refuses the runtime | It says which file failed. `stat -c '%U %a' /usr/lib/nessie-executor/*` must show `root` and no group or world write bit; reinstall from the apt repository. A user-writable copy never gets executor controls. |
| Executor controls missing in the desktop app | The app was not installed from the package: `stat /usr/lib/Nessie/executor-runtime/node` must show root ownership. |
