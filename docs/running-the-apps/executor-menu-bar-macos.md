# Nessie Executor for macOS

Chapter of [Running the Native Apps](overview.md).

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

The download is `Nessie-Executor-macOS-Apple-Silicon.dmg` or
`Nessie-Executor-macOS-Intel.dmg` from the GitHub release. **Open it, drag the
app onto the Applications folder beside it, and launch it.** There is no
right-click-Open, no `xattr -d`, no Gatekeeper bypass and no security-settings
detour: the image is signed with the Nessie `Developer ID Application`
certificate, notarized by Apple, and has its notarization ticket stapled to both
the image and the app inside it. If macOS ever refuses one of these downloads,
that is a defect in the release, not a step for the person installing it.

Two DMGs exist because the app carries its own pinned Node, and that binary is
the build host's own. An Apple Silicon Mac wants the Apple Silicon image.

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

## First run and pairing

Pairing is started in Nessie, not on the Mac: **Agents → Executors → Pair
executor** issues an enrollment id and a one-time challenge. In the menu bar
app's **Settings** those two go in beside the API origin
(`https://api.nessie.works` for the hosted service, or your own instance's API
origin), together with the workspace folder the executor may read — chosen
through a normal macOS folder picker.

The app then runs the bundled `nessie-executor pair`, which creates the
machine's private key and prints a fingerprint. **Confirm that fingerprint in
Nessie.** Until an entitled human has confirmed it there and reviewed the local
policy, the executor does nothing: the policy revision lands as
`pending_review`, exactly as it does when a tool is added to the allowlist
later.

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

## Where state lives

Everything the pairing produced — the machine key, `executor-state.json` with
the reviewed local policy, the daemon lease — is under the app's own private
application-support directory:

```
~/Library/Application Support/<bundle identifier>/executors/<executorId>
```

`<bundle identifier>` is what the installed app reports
(`mdls -name kMDItemCFBundleIdentifier "/Applications/Nessie Executor.app"`); it
always begins `com.unlikeotherai.nessie.`, because the installer refuses to
package an app identified as anything else. The `executors/<executorId>` shape
is the one Nessie Desktop already uses on macOS, so a Mac that has both keeps
two separate, owner-only state roots rather than one shared one.

That directory is owner-only and is yours. Nothing in it is uploaded, and no
part of it is a copy of anything Nessie owns.

## Uninstalling

1. Quit the app from the status bar menu. The Quit item says what it does to the
   running daemon; a stop is the daemon's own graceful teardown, with the same
   ten-second budget as every other host, and is never a `SIGKILL`.
2. Remove the executor in Nessie (**Agents → Executors**), so the control plane
   stops offering it work.
3. Drag `/Applications/Nessie Executor.app` to the Trash.
4. The pairing state survives on purpose, so a reinstall does not re-pair. To
   forget it, delete
   `~/Library/Application Support/<bundle identifier>/executors/`.

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

`.github/workflows/release.yml` → **macOS Executor menu bar** builds both
architectures on a tag, in the same workflow as every other direct download, so
it inherits the tag immutability, the "this tag is main's tip" preflight, and
the `direct-download-release` environment. It deliberately does **not** inherit
the neighbouring **macOS** job's stance: that DMG is ad-hoc signed on purpose
and asserts that Gatekeeper rejects it, while this one asserts the opposite and
must be installable with no bypass at all.

The job requires every credential by name before it builds, imports the
`Developer ID` certificate into a temporary keychain, and after the build
verifies the image again independently of the script that produced it —
`codesign --verify --deep --strict`, an `Authority=Developer ID Application:`
and `TeamIdentifier` check, `stapler validate`, and a passing `spctl`
assessment, then the same four against the app mounted from inside the image.
`.github/workflows/ci.yml` → **Test** runs the plan's unit tests on every pull
request; they need neither macOS nor a database.
