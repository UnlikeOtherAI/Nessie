# Running the Native Apps

This guide gives copy-paste paths for running Nessie's desktop and mobile apps. The desktop path works without an Apple Developer account; the mobile WebView shell needs Apple Developer signing to run on a physical device.

## Prerequisites

- Work from the Nessie repository root.
- Node.js, pnpm, and Rust are already installed locally.
- For the mobile app on a physical device, use an iPhone/iPad on the same Wi-Fi network as your Mac and an Apple Developer Program membership for signing (the app uses a native WebView module, so Expo Go cannot host it).
- For EAS iOS builds later, use an Expo account and an Apple Developer Program membership.

## Mac Desktop - Works Now

There are two desktop modes:

- **Dev:** Tauri loads the local Vite admin at `http://localhost:5455`. The Vite
  dev server proxies `/api` to the local API on `5454`.
- **Installable production bundle:** Tauri embeds a built `admin/dist`. That
  bundle must call the production API directly at
  `https://api.nessie.works`.

Terminal 1:

```sh
pnpm install
pnpm dev
```

This starts the API on port `5454` and the admin app on port `5455`.

Terminal 2:

```sh
pnpm --filter @nessie/desktop exec tauri dev
```

The Nessie desktop window opens and loads the local admin app.

Desktop SSO uses the user's default browser instead of the Tauri webview. The
desktop bundle declares the `nessie` URL scheme; after UOA redirects to
`nessie://auth/callback`, macOS focuses the running app and the admin login page
finishes the PKCE exchange from the deep link.

To create a local distributable that contains the current local admin code:

```sh
VITE_API_BASE_URL=https://api.nessie.works pnpm --filter @nessie/admin build
pnpm --dir desktop exec tauri build --bundles app \
  --config '{"build":{"frontendDist":"../../admin/dist"}}'
```

This produces `desktop/src-tauri/target/release/bundle/macos/Nessie.app`.
The API origin in the first command is intentional:

- `https://api.nessie.works` is the API and returns JSON for
  `/api/auth/providers`.
- `https://app.nessie.works` is the hosted admin web app. Do **not**
  use it as `VITE_API_BASE_URL`; `/api/auth/providers` will return the admin
  HTML shell and the desktop login page will sit at "Loading providers...".

The plain `pnpm --filter @nessie/desktop exec tauri build` command uses
`desktop/src-tauri/tauri.conf.json` as-is. That config points `frontendDist` at
the hosted admin (`https://app.nessie.works`), so it is useful for a
thin remote shell but does not embed un-deployed local admin changes.

To replace the locally installed app:

```sh
osascript -e 'tell application id "com.unlikeotherai.nessie.desktop" to quit' 2>/dev/null || true
ditto desktop/src-tauri/target/release/bundle/macos/Nessie.app /Applications/Nessie.app
codesign --force --deep --sign - /Applications/Nessie.app
open -na /Applications/Nessie.app
```

On first open, right-click the app and choose **Open** if macOS Gatekeeper asks.
A signed and notarized macOS release needs the operator's Apple Developer ID
certificate; `desktop/src-tauri/tauri.conf.json` keeps `signingIdentity` set to
`null` until that certificate is available.

If the installed app gets stuck at **Loading providers...**, check the API
origin first:

```sh
curl https://api.nessie.works/api/auth/providers
```

Expected result is JSON containing the SSO provider. If the response is HTML,
the app was built against the admin web origin instead of the API origin.

## Mobile app — WebView shell

The mobile app is a **WebView shell around the admin web UI** wrapped in native
chrome, mirroring the desktop app. `mobile/App.tsx` renders **one persistent**
`react-native-webview` that loads the admin, sitting above a **native bottom tab
bar** (`react-native-bottom-tabs`; iOS 26 Liquid Glass on iPhone, Material on
Android) with five tabs — Channels · Projects · Knowledge · Admin · Search.
Agents now live **under Admin** (the Admin section's nav lists Agents/Activity/
Designer/Workflows/Triggers/Tools), and **Search** is the trailing tab (iOS 26
separated search role) backed by a global `/search` page. The bar is hidden on
the login / bootstrap screens. On iPhone and Android the bar sits at the bottom;
on iPad (iPadOS 26) `IpadNativeTabBar` renders the same destinations in a
lightweight native **top** row, so `App.tsx` insets the WebView accordingly
(`IS_IPAD`). The iPad deliberately does not mount `react-native-bottom-tabs`:
its empty tab scenes can cover the sibling WKWebView with a black controller
surface after login. Back, Forward, Recent Channels, and Help buttons sit on the
trailing side of the iPad row. Tapping **Search** opens the full `/search` page
on iPhone and Android; on iPad it opens the native search overlay. The URL split
lives in `mobile/src/config.ts`:

- **dev** → `http://<YOUR-MAC-LAN-IP>:5455` (the admin Vite dev server; edits
  hot-reload on the device, and the admin's `/api` calls are proxied to the API)
- **prod** → `https://app.nessie.works` (the hosted admin)

Update the dev branch of `ADMIN_URL` to your Mac's LAN IP before building. The
old native app (login/channels screens) is archived at `archive/mobile-native`.

**Navigation bridge.** Neither tab surface hosts separate WebViews — each drives
the single WebView via the postMessage bridge. Tapping a tab calls
`window.__nessieNavigate(path)` in the SPA; the SPA reports route changes back as
`{ type: 'nessie:route', path }` so the selected tab resyncs. On the web side
this lives in `admin/src/providers/NativeShellBridge.tsx`, gated on
`isReactNativeWebView()` (`admin/src/lib/mobile-shell.ts`). In the native shell
the admin hides its own left rail and bottom tab bar. Phone-sized native layouts
also hide the admin top bar entirely; the iPad native layout hides that web top
bar too and exposes its remaining controls through `window.__nessieToolbarAction`
from `admin/src/layouts/admin-shell/NativeIPadToolbarBridge.tsx`, while global
search opens from the native Search tab overlay. Because that web top bar is
absent on iPhone, `mobile/src/lib/webview-inject.ts` applies the top safe-area
inset to the admin columns' content while leaving their backgrounds edge to
edge; iPad and Android reserve their top inset in the native frame. Android's
floating dock has no independent separator: the shared dock-geometry contract
adds its exact interaction clearance to the WebView columns, keeping the chat
composer entirely above the dock while page backgrounds continue beneath it. The
per-section secondary sidebar (channel list, admin sub-pages, …) opens from a
**top-left hamburger** as a slide-in drawer. Mobile *web* (a phone browser, no
native shell) gets an equivalent web-rendered bottom tab bar instead — and, like
the native phone layout, hides the admin top bar entirely whenever that bottom
tab bar is shown (`hideTopBar` in `AdminShellLayout.tsx`). Global search is
reached from the bottom bar's **Search** tab, and each page renders its own
mobile header (hamburger + title) for drawer access.

The login route is its own full-height touch-scroll container because the page
root remains fixed for the authenticated shell. On phone widths it presents the
sign-in panel before the welcome panel, keeping hosted SSO visible without an
initial scroll; desktop keeps the two-column welcome/sign-in order.

**Lifecycle and session persistence.** Moving the native app to the background
and foreground again preserves the existing WebView instead of navigating or
remounting it on a timer. This keeps the current route, DOM storage, and WebKit
cookie store intact so a normal app switch does not restart session bootstrap or
race refresh-token rotation. Recovery remains event-driven: iOS reloads only
after WebKit reports that its content process terminated, Android remounts after
its render process is gone, and the capped boot watchdog retries genuinely
blank or failed page loads.

**Feedback without motion access.** The mobile shell does not subscribe to
accelerometer data, so iOS/iPadOS does not ask for the broad “Motion & Fitness
Activity” permission at launch. Feedback remains available through Help and
Feedback on iPad and the admin Feedback section on every form factor.

`react-native-webview` and `react-native-bottom-tabs` are native modules, so
**Expo Go cannot host the app** —
you need a prebuilt build (`npx expo prebuild` regenerates `mobile/ios` /
`mobile/android` with autolinking). Building for a physical device requires Apple
Developer signing.

```sh
# 1. Run the admin + API dev servers (repo root); the admin must be LAN-reachable.
pnpm dev                      # API :5454, admin :5455

# 2. Build + install on a connected iPhone/iPad:
cd mobile
npx expo run:ios --device     # prebuild + pods + build + install + launch + Metro
```

On Xcode 26 the Expo installer can hang at "Connecting to device". If so, build
and install manually after `expo prebuild`:

```sh
cd mobile/ios
xcodebuild -workspace Nessie.xcworkspace -scheme Nessie -configuration Debug \
  -destination "id=<DEVICE-UDID>" -allowProvisioningUpdates build
# then locate Nessie.app from the build log and:
xcrun devicectl device install app --device <DEVICE-UDID> <path/to/Nessie.app>
xcrun devicectl device process launch --device <DEVICE-UDID> com.unlikeotherai.nessie
```

### Simulators & emulators (headless verification)

```sh
cd mobile
# iOS simulator (boot one first, e.g. iPhone 17 Pro):
npx expo run:ios --port 8082            # --port avoids the faces-metro clash on 8081
# Android emulator (boot an AVD first):
adb reverse tcp:8082 tcp:8082
npx expo run:android --port 8082
```

**Metro port 8081 is contended on this Mac.** A separate `faces-metro` launchd
job pins Metro to 8081, and the Nessie dev build (no `expo-dev-client`) hardwires
8081, so it red-screens with "Unable to resolve … `/Faces/…`". Until we add
`expo-dev-client` (the durable fix — then `--port`/the dev-launcher URL is
honoured directly), run Nessie's Metro on **8082** and point each device at it:

- iOS sim: `xcrun simctl spawn booted defaults write com.unlikeotherai.nessie RCT_jsLocation "<MAC-LAN-IP>:8082"` then relaunch.
- Android emu: `adb reverse tcp:8082 tcp:8082` (the run command above sets this).

Metro shares the data-volume fsevents problem (see Dev mode), so after editing
RN source restart it with `--reset-cache` for the change to be served.

The build outputs land at `/tmp/gpteen-xcode2/Prod/Debug-iphonesimulator/Nessie.app`
(iOS sim) and `mobile/android/app/build/outputs/apk/debug/app-debug.apk` (Android).

The WebView shows the admin's own login (SSO + local-dev email/password); there
is no separate native login. ATS allows the dev LAN `http://` origin via
`NSAllowsLocalNetworking` in `mobile/app.json`.

## iPhone Dev Build And Push - After Apple Enrollment

Prerequisites:

- Apple Developer Program membership, currently required for real iOS device provisioning.
- Expo/EAS account.
- The `extra.eas.projectId` value in `mobile/app.json` filled by `eas init`.
- The `owner` value in `mobile/app.json` replaced with the Expo account name.

Use the global EAS CLI:

```sh
npm i -g eas-cli
eas login
cd mobile
eas init
eas build -p ios --profile development
```

Or use EAS through `npx`:

```sh
npx eas-cli login
cd mobile
npx eas-cli init
npx eas-cli build -p ios --profile development
```

Install the development build on the device. Unlike Expo Go, the development build gets a native APNs token, so push notifications can work.

## TestFlight

After the Apple Developer account, App Store Connect app record, and internal testers are ready:

```sh
cd mobile
eas build -p ios --profile production
eas submit -p ios
```

The `production` submit profile contains App Store placeholder values. Replace them before submitting.

## Android

For a development build:

```sh
cd mobile
eas build -p android --profile development
```

## Windows Desktop

Run the build on a Windows machine:

```sh
pnpm install
pnpm --filter @nessie/desktop exec tauri build
```

Tauri uses the Windows bundle settings in `desktop/src-tauri/tauri.conf.json` for NSIS and WiX packaging.

## Status And Caveats

The mobile WebView shell has been built and run on a physical iPad (signed with
a development team, installed via `devicectl`): it loads the admin over the LAN
and renders the admin login/workspace. EAS/TestFlight and Android paths are
configured but not yet exercised on those targets.
