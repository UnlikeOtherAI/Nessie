# Nessie Executor for macOS

Chapter of [Running the Native Apps](overview.md).

## Pairing and unpairing

1. Install **Nessie Executor.app** in `/Applications` and open it. Normal
   releases require Developer ID signing and notarization; another certificate
   or a development build requires an explicit operator decision.
2. Open its menu bar panel, choose **Pair this Mac**, select **Nessie** and
   **Choose folder…**, then **Get pairing code**.
3. Complete the [two-sided pairing flow](../executor-pairing.md#complete-both-halves)
   in the website and the Mac panel. Check the organisation, team and fingerprint.
4. Enable **Start at login** in the app's settings and verify the executor is
   Online in Nessie. The menu bar app owns the daemon: quitting it stops the
   daemon; merely closing its panel does not.
5. Configure the local program and real, nonsymlinked coding roots, then assign agents
   and share the executor in Nessie. Claude and tmux must be available to the
   daemon's configured environment, including when launched at login.

State normally lives in `~/Library/Application Support/Nessie Executor/executor`.
The app can adopt one legacy Desktop or CLI pairing in place; multiple legacy
connections require review. Do not copy a machine's keys to another computer.

To unpair, **Disconnect** or **Delete** the executor in Nessie first, disable
**Start at login**, and quit the menu bar app. Removing the app alone does not
revoke its server identity. For a different team, use **Replace pairing…**;
the app retires the old connection before showing a new code. After pairing
again, assign agents and configure sharing for the new executor.

An installation managed with a custom LaunchAgent must unload that agent too;
the app's Start at login switch only controls its own SMAppService entry.
The LAN development installation uses
`~/Library/LaunchAgents/com.unlikeotherai.nessie.executor.user-install.plist`:
`launchctl bootout gui/$(id -u) <plist-path>` disables its current registration;
remove that exact plist to prevent the next login from registering it again.

## Application and distribution

The Nessie Executor menu bar app is how a Mac becomes an executor without
anybody opening a terminal. It installs from a downloaded disk image, lives as
an icon in the status bar, and from that icon a person reaches the three things
that decide what the machine will do on an agent's behalf: its settings, **where
it can reach**, and **which command-line tools it may run**. The design is
[docs/plans/2026-09-16-executor-menu-bar-app.md](../plans/2026-09-16-executor-menu-bar-app.md);
the app is a client of `nessie-executor`, never a second writer of its state.

The headless CLI loses nothing by this existing. The two are clients of one
authority — the local policy in `<state-dir>/executor-state.json` — and the
Linux daemon chapter
([linux-desktop.md](linux-desktop.md) → "The standalone executor daemon")
describes the same pairing in its terminal form.

## Installing it

The download is `Nessie-Executor-macOS-Apple-Silicon.dmg`
from the GitHub release. **Open it, drag the
app onto the Applications folder beside it, and launch it.** There is no
right-click-Open, no `xattr -d`, no Gatekeeper bypass and no security-settings
detour: the image is signed with the Nessie `Developer ID Application`
certificate, notarized by Apple, and has its notarization ticket stapled to both
the image and the app inside it. If macOS ever refuses one of these downloads,
that is a defect in the release, not a step for the person installing it.

The standalone executor app requires an Apple Silicon Mac and carries its own
pinned Node runtime.

The mounted volume holds exactly two things: the app, and a symlink to
`/Applications` to drop it on. There is no scripted Finder window with a
background image and remembered icon positions — that trick needs a read-write
image opened by a logged-in Finder, which a headless release runner does not
have, and an installer that only assembles correctly on somebody's desk is worse
than a plain one that always does.

To check a download before opening it:

```sh
shasum --check --ignore-missing SHA256SUMS
codesign -dvv Nessie-Executor-macOS-Apple-Silicon.dmg 2>&1 | grep -E 'Authority|TeamIdentifier'
xcrun stapler validate Nessie-Executor-macOS-Apple-Silicon.dmg
spctl --assess --type open --context context:primary-signature -vv Nessie-Executor-macOS-Apple-Silicon.dmg
```

The `Authority=Developer ID Application:` line and a passing `spctl` assessment
are the two facts worth reading. `SHA256SUMS` is published beside the assets.

Do **not** install an image whose file name contains `UNSIGNED-DEVELOPMENT` or
`DO-NOT-INSTALL`. That is the local development artifact described below; it is
never published, and macOS will refuse to open the app it contains.

## You may already have it

Nessie Desktop's Developer ID build carries a copy of this app inside its own
bundle, at `Contents/Library/LoginItems/Nessie Executor.app` — the location
macOS intends for a menu bar helper, and the only one `SMAppService` can
register for launch at login. A Mac with that Desktop installed needs no second
download: **Admin › Computers** has an **Open Nessie Executor** button, and
clicking it puts the icon in the status bar.

The DMG above is still the right download for two Macs: one that runs only the
executor and has no reason to have the chat app on it, and one running the
signed direct-download Desktop DMG, which uses the separate menu bar app
for its local console. Install it with `brew install --cask unlikeotherai/tap/nessie-executor-app`.

Both copies share one bundle identifier, one state directory and one daemon
lease, so **there is only ever one icon.** Whichever copy is launched second
activates the first and exits
(`Sources/Core/SingleInstance.swift`). If a standalone copy is installed in
`/Applications` or `~/Applications`, Desktop opens that one rather than its own
nested copy: its path survives a Desktop upgrade, which is what launch-at-login
registration needs, and it keeps supervising the daemon after Desktop quits.
Before opening a copy it did not ship, Desktop verifies the signature and the
pinned Developer ID team — `/Applications/Nessie Executor.app` is a name, not an
identity — and refuses rather than launching an unverified bundle.

Once this app is supervising the daemon, it owns this Mac. Nessie Desktop's own
**Start daemon** and **Stop daemon** say so and step aside instead of racing it
for the lease. A daemon Desktop started itself stays Desktop's to stop.

## First run and pairing

In the menu bar app, choose **Add team**, choose the folder this Mac may read,
and click **Get pairing code**. The app displays eight digits in large black
text with a Copy button and countdown, followed by its name and fingerprint.
In Nessie, open **Admin › Computers › Pair a computer** and enter those digits.
Check the current team and review the machine fingerprint.

The Mac then names that organisation and team beside its machine fingerprint.
Click **Confirm and connect** on the Mac only when those names match the
destination you chose. Confirmation is bound to the exact claim displayed;
the runtime refuses a changed claim. Polling never confirms a connection.
Expired codes cannot be confirmed, and **Cancel pairing** cancels the pending
attempt through the same runtime that created it. Closing the window leaves
the attempt available until it expires, including after reopening the app.

An already paired Mac shows connections in the menu and **Paired teams** tab.
**Add team** creates another while existing connections keep running.
**Folders** and **Commands** apply only to the selected team's local
permissions; **Settings** contains the login toggle. Names are read live from
Nessie and held only in memory. The console is the same packaged document as
Windows's; see [local executor controls](../executor-local-controls.md).

The pairing form accepts the Nessie API address and defaults to production.
Development builds also permit a local API; releases require HTTPS.
Origin validation remains shared with the CLI contract in
`packages/schemas/src/executor-pairing-origins.ts`, with Swift tests checking
the pinned hosted choices. No copied command, enrollment credential, state
path, or server address appears as the identity of a paired organisation.

The app uses the bundled runtime's JSON `pairing-start`, `pairing-status`,
`pairing-confirm`, and `pairing-cancel` commands. The selected folder and
replacement choice travel on stdin. Keys and pairing state belong exclusively
to that runtime. Once confirmed, the executor starts automatically; reviewed
policy still decides which work it can perform.

The CLI the app runs is inside the app, at
`/Applications/Nessie Executor.app/Contents/Resources/executor-runtime/`, next
to the pinned `node` that runs it, the Node licence, and a `manifest.json`
holding a SHA-256 for each of them. The daemon verifies itself against that
manifest before it serves, so replacing the JavaScript inside an installed app
stops it rather than changing what it does. It is the same layout the desktop
bundle and the Linux package install, produced by the same
`executor/scripts/prepare-runtime.mjs`.

The app supervises the daemon it starts: it spawns
`nessie-executor serve --parent-liveness-stdin` and holds the pipe, so quitting
the app ends the daemon rather than leaving one running with no visible owner.
Opening the app starts an already paired executor after checking its local
state and daemon lease. **Open Nessie Executor when I log in** therefore starts
the paired executor at login too. Stopping it from the menu keeps it stopped
for that app session; status refreshes do not restart it.
An unfinished replacement keeps the prior executor stopped, including after an
app restart when Nessie is temporarily unreachable. Pairing recovery or
cancellation must finish before that machine can start again.

## Where state lives

Everything the pairing produced — the machine key, `executor-state.json` with
the reviewed local policy, the daemon lease — is under the app's own private
application-support directory:

```
~/Library/Application Support/Nessie Executor/executor
```

This stable product directory is independent of the bundle identifier and is
shared by the standalone and nested copies of the menu bar app. Pending code
pairing and completed pairing use the same root. Changing packaging cannot
strand a pairing under an old bundle identifier.

Before creating a connection, the app also checks the documented Desktop,
older menu bar, and CLI state roots, one level deep. Existing pairings are reused
in place and described by the runtime, including live organisation and team
names. New connections live in `Nessie Executor/connections/<connection-id>`
beside the original `executor` directory. Discovery never opens keys, follows
symbolic links, or scans other folders. Development builds with an explicit
state-directory override discover only that directory and its sibling
`connections` root.

That directory is owner-only and is yours. Nothing in it is uploaded, and no
part of it is a copy of anything Nessie owns.

## Uninstalling

1. Quit the app from the status bar menu. The Quit item says what it does to the
   running daemon; a stop is the daemon's own graceful teardown, with the same
   ten-second budget as every other host, and is never a `SIGKILL`.
2. Remove the executor in Nessie (**Admin › Computers**), so the control plane
   stops offering it work.
3. Drag `/Applications/Nessie Executor.app` to the Trash.
4. The pairing state survives on purpose, so a reinstall does not re-pair. To
   forget it, delete
   `~/Library/Application Support/Nessie Executor/executor/`.

If the app registered itself to launch at login, removing the app is enough:
`SMAppService` registrations are keyed to the bundle and stop being honoured
once it is gone.

## What this DMG does not carry

The image carries the app and the packaged executor runtime. It does **not**
carry the macOS micro-VM helper (`executor/vm`) or a guest kernel, so the
sandboxed operations that need a guest — commands, browsers, coding sessions —
are configured at pairing time from paths that already exist on the machine, the
way they are today. File review and drafts work from the workspace bundle
without any of that. Packaging the helper alongside the app is a later,
separate change: it needs the virtualization entitlement decided and its own
provenance check, and shipping an executable this release cannot yet use would
be a capability nobody audited.

## Building the installer

The producer is `executor/packaging/macos/build-dmg.mjs`. It builds the app
through `executor/menubar-macos/scripts/build-app.sh`, embeds the prepared
runtime, signs inside-out with the hardened runtime, notarizes and staples both
the app and the image, and asks Gatekeeper for its verdict before it will call
the result finished. Its plan — the file layout, the signing arguments, and
every refusal below — is `executor/packaging/macos/dmg-plan.mjs`, asserted by
`node --test executor/packaging/macos/dmg-plan.test.mjs` on any host.

The app's icon is the executor's plus on Nessie's dark plate, compiled from
`executor/menubar-macos/Sources/App/Assets.xcassets`. Those images are drawn
from `assets/logo/nessie-executor-mark.svg` by
`node executor/scripts/generate-icons.mjs`, which also draws the Windows
executor icons, so regenerate them after changing the mark. `build-app.sh`
refuses a bundle with no application icon. Without one, Finder, the DMG
window and **System Settings → General → Login Items** show the generic
application icon.

### The release build

```sh
pnpm prisma:generate
pnpm exec turbo run build --filter=@nessie/executor...
NESSIE_EXECUTOR_SIGNING_IDENTITY='Developer ID Application: <LEGAL_NAME> (<TEAM_ID>)' \
NESSIE_DESKTOP_SIGNING_TEAM_ID=<TEAM_ID> \
APP_STORE_CONNECT_API_KEY_ID=<KEY_ID> \
APP_STORE_CONNECT_API_ISSUER_ID=<ISSUER_ID> \
APP_STORE_CONNECT_API_KEY_PATH=/absolute/path/AuthKey_<KEY_ID>.p8 \
  node executor/packaging/macos/build-dmg.mjs --require-signed
```

The environment it reads, and why each name is that name:

| Variable | What it is |
| --- | --- |
| `NESSIE_EXECUTOR_SIGNING_IDENTITY` | The `Developer ID Application` identity, by its full name as `security find-identity -v -p codesigning` prints it. Already the executor's macOS signing-identity variable in `executor/vm/scripts/build-signed-vm-helper.sh`. An ad-hoc `-` is refused here, unlike there. |
| `NESSIE_DESKTOP_SIGNING_TEAM_ID` | The Apple Developer team the signature must belong to, checked against the signed bundle rather than assumed. Already the repository-wide name for this fact (`desktop/scripts/require-signing-team.mjs`, `executor/scripts/prepare-chrome-cookie-import.mjs`). |
| `APP_STORE_CONNECT_API_KEY_ID`, `APP_STORE_CONNECT_API_ISSUER_ID` | The notary credential CI uses. Already this repository's spelling in `.github/workflows/publish-apple-testflight.yml`. |
| `APP_STORE_CONNECT_API_KEY_PATH` | The `.p8` private key on disk, because `notarytool` reads it from a file. In CI the existing `APP_STORE_CONNECT_API_KEY_P8_BASE64` secret is decoded into it for the life of the job. |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` | The other notary shape, for a person notarizing on their own Mac who has an app-specific password rather than a key. Needs `NESSIE_DESKTOP_SIGNING_TEAM_ID` as well, since `notarytool` has no other way to pick the team. |
| `NESSIE_EXECUTOR_VERSION` | Optional. The DMG is normally named after the app's own `CFBundleShortVersionString`; setting this makes the build **refuse** if the app is not at that exact version, which is the check a release wants and a local build does not. |

The refusals, all of them before anything is built:

- Either notary shape must be **complete**. A half-supplied one — the shape of a
  typo in a single CI secret — is an error naming the missing variable, never a
  silent fallback to "then do not notarize".
- `--require-signed`, which CI always passes, turns a missing signing credential
  into a failed run.
- `NESSIE_EXECUTOR_SIGNING_IDENTITY=-` is refused outright.
- A notarization that comes back as anything but `Accepted` is never stapled.
- The finished artifacts are assessed with `spctl`, because a successful
  submission says a ticket was issued, not that this file carries it.
- The app's `CFBundleIdentifier` must be under `com.unlikeotherai.nessie.`.

### The development build, on a Mac with no certificate

```sh
NESSIE_EXECUTOR_DMG_UNSIGNED_DEVELOPMENT=1 node executor/packaging/macos/build-dmg.mjs
```

This exists so the pipeline can be exercised where there is no `Developer ID`
certificate, and it is not an installer. The opt-in has to be typed, the
resulting file is
`NessieExecutor_<version>_<arch>-UNSIGNED-DEVELOPMENT-DO-NOT-INSTALL.dmg`, the
volume a person would see in Finder carries the same words, and the build prints
a closing banner saying the artifact must not be uploaded, sent to anyone, or
described as an installer. macOS will refuse to open the app inside it. The
release workflow cannot produce this build, and its publish step fails if a file
with that marker reaches it.

The build host's Node is the Node that ships, so build on Node 22 — the version
the bundle targets — or the packaged runtime will pin a different one.

### In CI

`.github/workflows/release.yml` → **macOS Executor menu bar** builds the Apple
Silicon installer on a tag. It shares the protected Developer ID credential
setup and inside-out signer with the desktop DMG. Both must pass Gatekeeper;
Homebrew casks are generated only from those verified installers.

The job requires every credential by name before it builds, imports the
`Developer ID` certificate into a temporary keychain, and after the build
verifies the image again independently of the script that produced it —
`codesign --verify --deep --strict`, an `Authority=Developer ID Application:`
and `TeamIdentifier` check, `stapler validate`, and a passing `spctl`
assessment, then the same four against the app mounted from inside the image.
`.github/workflows/ci.yml` → **Test** runs the plan's unit tests on every pull
request; they need neither macOS nor a database.
