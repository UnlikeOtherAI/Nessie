# Running the Native Apps

This guide gives copy-paste paths for running Nessie's desktop and mobile apps.
The desktop shell can run unsigned for UI development, but executor controls
require a publisher-verified release on macOS, Windows, or Linux. The mobile
WebView shell needs Apple Developer signing to run on a physical device.

For public desktop and Android downloads, see
[Publishing direct downloads](../releasing.md). The release workflow owns the
signed macOS and Windows installers, Linux packages, the Android APK, and their
checksums; iOS remains an App Store delivery.

## Table of Contents

- This file: physical-device delivery, prerequisites, the Mac desktop shell, desktop notifications, Mac TestFlight, status and caveats.
- [mobile.md](mobile.md) — the mobile WebView shell, device builds, push, iOS TestFlight, Android.
- [windows-desktop.md](windows-desktop.md) — the Windows desktop app, signed release, the Nessie Executor service and tray.
- [linux-desktop.md](linux-desktop.md) — the Linux desktop app and the standalone `nessie-executor` daemon.

## Default physical-device delivery

**“Put the latest build on my phone/tablet” means a self-contained, direct
device deployment.** Build the `mobile` `device` profile, install that exact
IPA on each named physical device with `xcrun devicectl`, launch it, and verify
that it remains running. Do not treat an EAS download link as delivery.

This is the default unless the request explicitly names TestFlight, a store
release, Metro hot reload, or an Expo development client. The resulting app
embeds its JavaScript, loads the hosted Nessie service, and does not need the
developer Mac or its local network after installation. It does still need normal
internet access for `https://app.nessie.works`.

The mobile release must use a React version supported by its React Native
renderer. Nessie's pnpm workspace is hoisted, so changing React requires
updating the mobile React Native/Expo SDK in the same release rather than letting
the web workspace's React package drift into an incompatible device bundle.

Apple labels the required direct iOS installation signature **Ad Hoc**. That is
only the provisioning method: it is a normal standalone app, not the Expo
development launcher and not TestFlight. The profile pins the hosted
`https://app.nessie.works` URL into the binary so a phone never needs a local
server selector. A true Expo debug client is for developer work and requires
Metro, so it is not a substitute for this request.

## Prerequisites

- Work from the Nessie repository root.
- Node.js, pnpm, and Rust are already installed locally.
- For the mobile app on a physical device, use an iPhone/iPad on the same Wi-Fi network as your Mac and an Apple Developer Program membership for signing (the app uses a native WebView module, so Expo Go cannot host it).
- For EAS iOS builds later, use an Expo account and an Apple Developer Program membership.

## Mac Desktop - Works Now

There are two desktop modes:

- **Dev:** Tauri loads the local Vite admin at `http://localhost:5455`. The Vite
  dev server proxies `/api` to the local API on `5454`.
- **Installable production bundle:** Tauri loads the hosted admin at
  `https://app.nessie.works`. The hosted admin and API share the
  `nessie.works` site, so macOS WebKit can retain the API's HttpOnly refresh
  cookie and renew the short-lived access JWT.

Terminal 1:

```sh
pnpm install
pnpm dev
```

This starts the API on port `5454` and the admin app on port `5455`.

Terminal 2:

```sh
pnpm --filter @nessie/desktop dev
```

The Nessie desktop window opens and loads the local admin app.

The desktop script first bundles the local `nessie-executor` CLI and the exact
Node runtime into private app resources. It records their hashes and the Node
license in the bundle; use the package scripts below rather than invoking the
Tauri binary directly, so the companion cannot launch a stale or missing
executor runtime.

The window itself is configured per platform. `desktop/src-tauri/tauri.conf.json`
holds everything the three desktop targets share, and Tauri merges
`tauri.macos.conf.json`, `tauri.windows.conf.json`, or `tauri.linux.conf.json`
over it for the target being built. That merge is RFC 7396 JSON Merge Patch, in
which a patched array replaces the whole array rather than merging into it, so
each platform file restates the complete main window and a Rust unit test
(`src/shell.rs`) asserts they still agree on size, minimum size, and background
colour. macOS keeps the overlay title bar with its traffic lights; Windows and
Linux are frameless (`decorations: false`, with `shadow` on Windows and a
transparent window on Linux) and the admin draws Nessie's own chrome. Windows
and Linux render one route-independent frame above the router, so its shared
traffic-light controls, layout chooser, drag surface, and eight resize edges
remain reachable on sign-in, bootstrap, error, and authenticated screens.
Normal Linux windows clip the transparent native surface to softly rounded
corners; maximized and full-screen windows remain flush. The design
behind that split is
[docs/plans/2026-09-01-linux-desktop-delivery.md](../plans/2026-09-01-linux-desktop-delivery.md)
→ "Shared shell contract", which the Windows plan adopts by reference.

## Connected Chrome tab foundation

`executor/chrome-extension/` contains the signed-release source for Nessie's
MV3 extension and `native-host.template.json` documents its pinned native host
manifest. Do not load the template with a development extension id or point it
at an arbitrary executable. The connected-tab operations are intentionally not
configurable or advertised yet: the server-side private-run and disclosure gate
must land first, so no signed-in browser session can be invoked prematurely.

In dev, the companion intentionally pairs only with the local API at
`http://127.0.0.1:5454`. It cannot pair an unsigned development app with the
production API. Production executor pairing, local workspace selection, daemon
lifecycle, and policy controls require an intact publisher-verified desktop
release: Developer ID on macOS, the pinned Authenticode publisher on Windows,
or the root-owned package runtime on Linux. The app verifies that trust root
before exposing the companion IPC.

Desktop SSO uses the user's default browser instead of the Tauri webview. The
desktop bundle declares the `nessie` URL scheme; after UOA redirects to
`nessie://auth/callback`, macOS focuses the running app and the always-mounted
callback bridge finishes the PKCE exchange from the deep link, including while
an authenticated workspace screen remains open.

Windows and Linux use the same callback bridge. Their single-instance plugin
forwards a callback from a second process into the already-running app, shows
and restores a minimized window, and then focuses it. The provider list has an
explicit failure state and retry action, so a temporary network or API failure
cannot leave the sign-in page claiming it is still loading indefinitely.

An interrupted browser hand-off is always recoverable: the login screen offers
**Cancel sign-in**, and a new deliberate sign-in replaces only the exact stale
attempt it observed. In a web browser, returning with Back cancels the pending
attempt instead of reopening the provider; a restored browser page also
reconciles its session again so it cannot remain at **Loading workspace…**.

### Desktop notifications

The desktop app uses the same authenticated realtime message controller as the
web UI, then sends its system alert through Tauri's native macOS notification
API. Enable **Push enabled** in Nessie’s **Settings → Notifications** while the
desktop app is open to trigger the macOS permission prompt; then leave Nessie
allowed in **System Settings → Notifications**. This handles new messages and
agent replies, honours the exact conversation focus rule, and opens the exact
reply conversation when the user clicks the alert.

This is a native OS notification from the running desktop process, not a
remote APNs registration. A completely quit Mac app cannot receive it. True
APNs delivery to a quit macOS app requires a macOS App ID with the Push
Notifications entitlement, its own APNs device-token registration, and
per-topic APNs credentials in the server; Nessie currently registers only iOS
and Android device tokens.

While the desktop app is running, its Dock badge is the same authoritative
attention total as mobile: unread channel messages plus assigned work and
published knowledge that remain visible to the signed-in user. It refreshes
from the authenticated SPA state and clears when that total reaches zero. A
quit desktop app cannot refresh its Dock badge until macOS APNs registration is
implemented.

To create a production distributable:

```sh
NESSIE_DESKTOP_SIGNING_TEAM_ID=<APPLE_TEAM_ID> pnpm --dir desktop run tauri:build:executor --bundles app
codesign --force --deep --options runtime --sign 'Developer ID Application: <LEGAL_NAME> (<APPLE_TEAM_ID>)' \
  desktop/src-tauri/target/release/bundle/macos/Nessie.app
```

This produces `desktop/src-tauri/target/release/bundle/macos/Nessie.app`. A
normal release window is pinned to the hosted admin. The deliberate
`tauri:build:embedded` path is the exception for Windows/Linux UI verification:
it builds the local admin with `VITE_API_BASE_URL=https://api.nessie.works`,
verifies that API origin in the entry bundle, and then packages the embedded
assets. Do not reproduce those internal build steps manually. An embedded
bundle without that explicit API origin calls the wrong local HTML shell and
cannot complete session bootstrap.

- `https://api.nessie.works` is the API and returns JSON for
  `/api/auth/providers`.
- `https://app.nessie.works` is the hosted admin web app. Do **not**
  use it as `VITE_API_BASE_URL`; `/api/auth/providers` will return the admin
  HTML shell and the desktop login page will sit at "Loading providers...".

Use `pnpm dev` to exercise un-deployed admin changes in the desktop shell. Its
localhost Vite origin and API proxy remain first-party for local refresh cookies.

To replace the locally installed app:

```sh
osascript -e 'tell application id "com.unlikeotherai.nessie.desktop" to quit' 2>/dev/null || true
ditto desktop/src-tauri/target/release/bundle/macos/Nessie.app /Applications/Nessie.app
open -na /Applications/Nessie.app
```

On first open, right-click the app and choose **Open** if macOS Gatekeeper asks.
A signed and notarized macOS release needs the operator's Apple Developer ID
certificate; `desktop/src-tauri/tauri.conf.json` keeps `signingIdentity` set to
`null` until that certificate is available. An ad-hoc signature is sufficient
for the ordinary desktop shell, but executor controls stay unavailable. Configure
a real Developer ID signing identity and pass its team id as
`NESSIE_DESKTOP_SIGNING_TEAM_ID` before `tauri:build:executor` to pair a production
executor. The companion compiles that team id into the release and verifies the
final application has a matching Developer ID signature, including the packaged
executor runtime. Do not replace the app with an ad-hoc-signed copy after this
step: its executor controls will intentionally remain unavailable.

Every platform pins its own publisher this way, because a runtime hash manifest
alone is a self-attestation: whoever can rewrite the binary can rewrite the
manifest beside it. macOS pins a Developer ID team through
`NESSIE_DESKTOP_SIGNING_TEAM_ID`; Windows pins an Authenticode certificate
through `NESSIE_DESKTOP_WINDOWS_SIGNER_THUMBPRINT` (see **Windows Desktop**);
Linux has no in-process signature to read, so its trust root is the package
manager — a root-owned runtime under `/usr/lib` or `/usr/share` that only an
administrator can produce (see **Linux Desktop**).

For Nessie releases, do not create, install, or describe an ad-hoc-signed app as
a usable desktop release unless Ondrej explicitly requests that kind of build.
Before installing an executor-capable build, verify it with
`codesign --verify --deep --strict` and confirm its authority is `Developer ID
Application` with the configured signing team. If the certificate or private key
is absent, leave the installed app untouched and report the signing blocker.

### Mac TestFlight

Mac TestFlight uses a separate, sandboxed build configuration. It loads the
same hosted Nessie product and retains desktop SSO and notifications, but it
does not bundle the local executor runtime: that helper currently depends on a
Developer ID signature and user-selected workspace access that has not yet
been redesigned for App Sandbox inheritance. Follow the canonical
[Apple TestFlight publishing guide](../publishing-apple-testflight.md) for its
versioning, signing, validation, Xcode Organizer upload, and tester steps.

If the installed app gets stuck at **Loading providers...**, check the API
origin first:

```sh
curl https://api.nessie.works/api/auth/providers
```

Expected result is JSON containing the SSO provider. If the response is HTML,
the app was built against the admin web origin instead of the API origin.

## Status And Caveats

The current `com.km.nessie` TestFlight upload is `0.1.1 (3)`. App Store Connect
accepted the upload on 2026-08-14; the exported archive was independently
verified as an Apple Distribution build for team `59S95D279D` with the
production APNs entitlement, beta reporting enabled, and export compliance
declared. The previously installed `0.1.1 (2)` development build registered
active sandbox APNs tokens, and the in-house APNs test action was accepted by
Apple for the configured production credential. Actual delivery to a
TestFlight-installed production token remains the final device check.

The Android app loads its authenticated workspace successfully, but it has no
active FCM registration until the matching Firebase `google-services.json` and
server-side Firebase service-account credential are supplied. Android push
delivery therefore remains intentionally unverified rather than falling back
to a different Firebase project or sender.
