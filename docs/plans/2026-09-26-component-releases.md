# Component releases — one release per thing a person installs

**Status:** proposed. The Windows half of the edge channel shipped with Windows
signing on 2026-09-26 (`windows-edge.yml`). CLI candidates and immutable
`executor-v*` publication are implemented in [package distribution](../releasing-executor-packages.md);
the broader per-component stable pointers remain proposed.
**Date:** 2026-09-26
**Owner:** Desktop
**Operating guide:** [releasing](../releasing.md)

## The problem

One `vX.Y.Z` tag rebuilds every client — macOS, Windows, Linux, Android and the
executor installers — and publishes them together in one GitHub Release,
whether or not each one changed. So a Windows-only fix makes every Mac offer an
"update" with nothing in it; the executor cannot ship without the desktop app;
and because every download link and the desktop updater read
`releases/latest/download/…`, the newest release must always contain every
asset.

## How monorepos that ship several products handle it

Each separately installable product is a **component** with its own version,
its own tag prefix and its own GitHub Release, and a component is released only
when something it is built from changed. GitHub has no notion of a component:
it is a tag naming convention (`desktop-v0.1.1402`, `executor-v0.0.1402`) plus
the list of paths each component is built from. It is how release-please's
manifest mode, Changesets' independent mode and Nx Release's independent
projects work, and how Tauri's own repository tags `tauri-v2.x`,
`@tauri-apps/cli-v2.x` and `tauri-bundler-v2.x` separately.

Three further conventions matter here:

- **One version per app across operating systems.** VS Code, Slack, Signal and
  Zed ship a platform-specific fix as a new version everywhere; the other
  platforms get an update that changes nothing for them. Publishing a version
  for some platforms only (Tailscale does, for some patches) needs a separate
  update feed per platform, which is worth it only when no-op updates become a
  real cost.
- **Services are versioned by commit, not by release.** The API, worker, admin
  and web already deploy continuously through the exact-SHA gate; they have no
  GitHub Release and need none.
- **Build once, promote.** The binary that ships is the binary that was built
  and tested — the rule Deploy already follows for images.

## The model

### Components

| Component | Tag and release | What it publishes | Built from |
| --- | --- | --- | --- |
| Desktop | `desktop-v<version>` | Windows setup and MSI, macOS DMGs and updater archives, Linux AppImage and deb, `latest.json` | `desktop/`, `assets/`, and everything the executor is built from — the desktop carries the executor runtime |
| Executor | `executor-v<version>` | Windows MSI, macOS menu bar DMGs, Linux deb | `executor/`, the workspace packages its runtime bundles, the lockfile, the Windows build workflow |
| Android | `android-v<version>` | the APK | `mobile/` and what it bundles |
| iOS | App Store | — | `mobile/` |
| Services | none (Deploy, by SHA) | container images | `api/`, `worker/`, `admin/`, `web/`, `packages/` |

What counts as a change is code, not convention:
`scripts/release-components.mjs` lists each component's inputs, and its test
fails if the executor starts bundling a workspace package its inputs do not
cover.

### Versions

`MAJOR.MINOR` lives in the component's manifest and changes by pull request
when a person decides the product moved. The third number is `main`'s
first-parent commit count at the commit being built:

- it only grows, so every build installs over the previous one — Windows
  Installer refuses a same-version upgrade, and Tauri's updater compares SemVer;
- it fits Windows Installer's `255.255.65535`;
- it is computed from the commit, so an edge build and a stable release of the
  same commit carry the same version, a stable release never needs a rebuild,
  and moving between channels never looks like a downgrade.

Components move independently: the desktop can be `0.1.1402` while the
executor is `0.0.1402`, and the executor stays at its last version while only
the desktop changes.

### Channels

- **Edge** (built). Every merge to `main` that changes a component's inputs
  rebuilds, signs and replaces that component's rolling pre-release
  (`desktop-edge`, `executor-edge`) under stable asset names. Unchanged
  components keep their build. Windows is the first platform on it.
- **Stable** (proposed). A person cuts a release — a manual `Promote` workflow
  choosing the components, defaulting to every component that changed since its
  last stable release. For each, it takes the signed edge artifacts of the
  chosen commit, creates `<component>-v<version>` and its GitHub Release, and
  moves that component's stable pointer: a rolling `desktop-stable` /
  `executor-stable` release holding the current files under stable names, and
  for the desktop the signed `latest.json` the updater reads.

### What happens when

| Change | Edge | Stable release |
| --- | --- | --- |
| Nothing the Mac app is built from | no Mac build | no new desktop version for anyone; Mac keeps its release and sees no update |
| A Windows-only desktop fix | desktop rebuilt | a new desktop version for every platform; Mac gets a no-op update |
| Executor code | executor and desktop rebuilt | both released: the desktop carries the executor runtime |
| Server code only | nothing | nothing; Deploy ships it |

Components still have to work together across versions. That is the protocol's
job, not lockstep numbering: the desktop already loads the hosted admin rather
than embedding it, and the executor protocol's signed descriptors carry what a
machine can do.

## Moving from the single `v*` release

1. **Done:** Windows builds are signed, and the Windows edge channel publishes
   desktop and executor separately, only when each changed.
2. Before the first stable release, point the desktop updater at
   `releases/download/desktop-stable/latest.json` instead of
   `releases/latest/download/latest.json`, which follows whichever component
   released last. No release has ever been published, so no installed app reads
   the old address.
3. Replace `release.yml` with the `Promote` workflow above. Platforms without an
   edge build yet (macOS, Linux) are built from the promoted commit until they
   join the edge channel.
4. macOS and Linux join the edge channel as their signing lands: Developer ID
   for the desktop DMG (the executor DMG already has it), and a package-signing
   key for Linux.
5. Point the website's download links at the per-component stable pointers.

## Decisions needed

- Adopt per-component releases and retire the single `v*` tag — recommended.
- Number stable desktop releases the same way as edge builds, which moves the
  desktop from `0.1.1` to `0.1.<build>` — recommended, because anything else
  makes an edge install look newer than the next stable release.
- Who cuts stable releases: a person through `Promote` (recommended to start),
  or automatically on a schedule once the edge channel has earned trust.
