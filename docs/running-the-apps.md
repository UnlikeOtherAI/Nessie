# Running the Native Apps

This guide gives copy-paste paths for running Nessie's desktop and mobile apps. The desktop shell works without an Apple Developer account; production executor controls require a signed macOS desktop release. The mobile WebView shell needs Apple Developer signing to run on a physical device.

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

In dev, the companion intentionally pairs only with the local API at
`http://127.0.0.1:5454`. It cannot pair an unsigned development app with the
production API. Production executor pairing, local workspace selection, daemon
lifecycle, and policy controls require an intact signed macOS 15+ release; the
app verifies its own signature before exposing the companion IPC.

Desktop SSO uses the user's default browser instead of the Tauri webview. The
desktop bundle declares the `nessie` URL scheme; after UOA redirects to
`nessie://auth/callback`, macOS focuses the running app and the admin login page
finishes the PKCE exchange from the deep link.

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
release window is pinned to the hosted admin even if a build-time config tries
to replace `frontendDist` with local assets. Loading an embedded bundle from
`tauri://localhost` would make its calls to `https://api.nessie.works`
third-party in the macOS WebKit view; WebKit blocks that refresh-cookie storage,
which logs the user out when the access JWT expires.

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
lightweight native **top** row. Full-screen iPad places it flush below the top
safe area, while a Stage Manager window centres it in that window's title bar;
`App.tsx` keeps a 12-point clearance between that chrome and the WebView's first
row (`IS_IPAD`). The iPad deliberately does not mount `react-native-bottom-tabs`:
its empty tab scenes can cover the sibling WKWebView with a black controller
surface after login. Back, Forward, Recent Channels, and Help buttons sit on the
leading side of the iPad row, using the same theme-derived chrome as the tabs.
The active workspace's initial and name appear ahead of those controls; tapping
it opens the web shell's existing workspace menu, so context switching and
adding a workspace follow the same entitlement-aware flow as the desktop rail.
The signed-in person's SSO avatar, presence indicator, and active-status badge
sit immediately after the iPad tab group in the same native chrome. Tapping it
opens the canonical web account menu (presence, status, settings, and logout),
so the native presentation does not fork any account actions; the duplicate web
header trigger is omitted on native iPad and iPhone shells.
Tapping **Search** opens the full `/search` page
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
absent on iPhone, the native `App.tsx` frame reserves the status-bar inset for
every phone route — including tab roots whose content is not a direct admin
column — while `mobile/src/lib/webview-inject.ts` leaves full-screen web
surfaces clear of the home indicator. The iPhone tab controller uses its
transparent scroll-edge appearance, so the page-matched native root supplies
the intended backdrop without a second tinted bar beneath the glass controls;
iPad and Android reserve their top inset in the native frame. Android's
floating dock has no independent separator: the shared dock-geometry contract
adds its exact interaction clearance to the WebView columns, keeping the chat
composer entirely above the dock while page backgrounds continue beneath it. The
per-section secondary sidebar (channel list, admin sub-pages, …) opens from a
**top-left hamburger** as a slide-in drawer. Mobile *web* (a phone browser, no
native shell) gets an equivalent web-rendered bottom tab bar instead — and, like
the native phone layout, hides the admin top bar entirely whenever that bottom
tab bar is shown (`hideTopBar` in `AdminShellLayout.tsx`). Global search is
reached from the bottom bar's **Search** tab, and each page renders its own
mobile header (hamburger + title) for drawer access. Where that top bar is
hidden, the mobile header also provides the signed-in user's canonical account
control: the same avatar, presence/status badges, and account menu used at the
bottom of the desktop rail. A shell with that rail never renders a second
top-bar account badge.

On the native iPhone and Android **Channels** index (including its ordinary
query-string state), `NativePhoneConversationMenuChrome` adds a theme-specific
dark workspace header above that retained WebView: the workspace control opens
the existing entitlement-aware switcher, Recent Channels delegates to the
existing toolbar bridge, and the account control opens the canonical account
menu. Its bottom-right **+** opens native actions for **Project**,
**Channel**, or **Message**; each delegates to the same web-shell handler and
dialog as the sidebar, rather than creating a second permission path. The
WebView sidebar carries a native-touch marker on iPhone, iPad, and Android so
only those installed interfaces use Slack-scale 38-point rows and 14px menu
type; desktop remains compact even on a touchscreen. Project folder rows alone
are bold. Human, agent, and workspace avatar tiles use the same subtly rounded
square shape everywhere. Human avatar presence badges use a three-pixel cutout
that matches the sidebar background.

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
xcrun devicectl device process launch --device <DEVICE-UDID> com.km.nessie
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

- iOS sim: `xcrun simctl spawn booted defaults write com.km.nessie RCT_jsLocation "<MAC-LAN-IP>:8082"` then relaunch.
- Android emu: `adb reverse tcp:8082 tcp:8082` (the run command above sets this).

Metro shares the data-volume fsevents problem (see Dev mode), so after editing
RN source restart it with `--reset-cache` for the change to be served.

The build outputs land at `/tmp/gpteen-xcode2/Prod/Debug-iphonesimulator/Nessie.app`
(iOS sim) and `mobile/android/app/build/outputs/apk/debug/app-debug.apk` (Android).

The WebView shows the admin's own login (SSO + local-dev email/password); there
is no separate native login. ATS allows the dev LAN `http://` origin via
`NSAllowsLocalNetworking` in `mobile/app.json`.

### Mobile navigation

The mobile shell keeps the native system tab bar as the primary section switcher
and leaves page data, URLs, and conversation state in the admin React app.

- On a **phone**, selecting or reselecting Channels, Projects, Knowledge, or
  Admin opens that tab's contextual navigation list first. Selecting an item
  then enters its detail route; a conversation's Back control returns to the
  Channels list.
- Conversation information is addressable at
  `/channels/:channelId/info`, with nested `/members` and `/members/add`
  destinations. This gives a cold deep link the same deterministic Back path
  as an in-app navigation sequence.
- **iOS** uses the translucent circular conversation Back affordance alongside
  the system Liquid Glass tab bar. **Android** uses the same routes and
  hierarchy, but keeps its normal Material-style Back affordance rather than
  imitating iOS glass.
- **iPad and desktop** retain their side navigation beside the selected detail;
  conversation information is an inspector, not a phone-style replacement.

## iPhone Dev Build And Direct APNs Push

Nessie sends iOS notifications **directly from its own worker/API to APNs**. It
does not use Expo Push. The iOS app registers its raw APNs token after an
authenticated WebView route loads; the authenticated admin then stores that
token with the current organization. A notification tap returns to the exact
channel message when its deep-link target is still available. On a cold launch,
the native shell caches that target before creating the WebView and the React
navigation bridge reads it only after the router has mounted. The SPA root
redirect also selects that cached target before its ordinary `/channels`
landing route runs, so the default Personal Assistant conversation cannot
replace the notified conversation. The target remains cached until the SPA
reports that exact route back, then is cleared to prevent reopening an old
message later. Direct APNs routing metadata is carried in the top-level
`body` object: Expo serializes that remote `userInfo.body` as
`NotificationContent.data`, which is the native bridge's actionable payload.

### Simulator deep-link replay

Use the maintained APNs fixture and WebView route harness to prove both a cold
notification tap and a warm tap without waiting for a live agent reply. Start
the harness and Metro with its URL, then use `simctl push` with
`mobile/test/fixtures/cold-deeplink.apns`; the harness renders the exact path it
acknowledges back to the native shell. This exercises the same APNs custom data
shape and native notification-response bridge as production:

```sh
pnpm --filter @nessie/mobile test:deeplink-simulator
EXPO_PUBLIC_ADMIN_URL=http://YOUR_MAC_LAN_IP:5462 pnpm --filter @nessie/mobile start -- --dev-client
xcrun simctl push <simulator-udid> com.km.nessie mobile/test/fixtures/cold-deeplink.apns
```

For the cold case, terminate Nessie before sending and tap the system banner.
For the warm case, leave Nessie running on another path, send the same fixture,
and tap its banner. Both must render the fixture's full reply-thread URL; a
Personal Assistant route or an in-app banner destination is a failure.

Before a real-device build can receive pushes, an Apple Developer Account
Holder or Admin must do the one-time Apple portal setup for
`com.km.nessie`:

- Enable the **Push Notifications** capability on the App ID.
- Create an APNs **Authentication Key** (`.p8`) with its Key ID. Download it
  once and put it in the platform secret-management process; Apple does not
  allow it to be downloaded again.
- Record the Apple Team ID and use `com.km.nessie` as the APNs
  topic. The `.p8` key replaces APNs certificate files; it is valid for both
  sandbox and production hosts.

The application configuration includes Expo's `expo-notifications` plugin.
After `npx expo prebuild --platform ios --no-install`, confirm Xcode generated
`ios/Nessie/Nessie.entitlements` with `aps-environment`. Xcode's automatic
signing must use the Apple team whose App ID has the capability above. The
committed `mobile/app.json` pins Expo's `ios.appleTeamId` to that team so a
fresh prebuild keeps the same signing owner. The
development build reports `sandbox` with its device token; TestFlight and App
Store builds report `production`, and Nessie records that environment per token
so both can coexist.

The remaining prerequisites are:

- Apple Developer Program membership for device provisioning and the portal
  actions above.
- An Expo/EAS account for remote builds (optional for a local Xcode build).
- The `extra.eas.projectId` value in `mobile/app.json` filled by `eas init`.
- The `owner` value in `mobile/app.json` replaced with the Expo account name.

### Android FCM prerequisite

Android uses the same in-house sender, but Firebase issues the raw FCM token.
Before an Android production build can register or receive pushes for
`com.km.nessie`, add the Firebase project's `google-services.json` to the
mobile build configuration and upload the corresponding Firebase
**service-account JSON** through **Settings → Push credentials**. The first is
safe client build configuration; the second is the server credential used by
Nessie to call FCM directly and must remain in the encrypted server-side secret
store. Both files must belong to the same Firebase project and Android app ID.

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

### Configure and prove the in-house sender

1. Sign in to Nessie on that physical iPhone or iPad and grant notification
   permission. This registers the native APNs token for the signed-in user and
   current organization. Every signed session has a globally ordered,
   server-issued registration generation, so out-of-order former-session
   requests — including those from a former account — cannot reclaim it. Logout
   retains a non-deliverable tombstone with a newer generation for the same
   reason. A simulator cannot prove APNs delivery.
2. Sign in as a platform super-admin, open **Settings → Push credentials**, and
   upload the `.p8` key with its Key ID, Team ID, topic
   `com.km.nessie`, and either environment. The secret is encrypted
   in Nessie's server-side secret store and is never returned to a client.
3. Select **Send test to this iPhone**. Nessie looks up only the operator's
   newest iOS token in the current organization, selects that token's APNs host
   (`sandbox` or `production`), and sends a real alert directly to APNs. An
   “APNs accepted” response is provider acceptance, not a claim that iOS
   displayed the banner.
4. Send a channel message. The worker sends the sender as the notification
   title and the destination as a `# channel` context (an APNs subtitle, composed
   into the Android/browser title); a direct mention keeps its explicit
   “mentioned you in # channel” subtitle. This is followed by a whitespace-normalized,
   truncated message preview (at most 140 characters). It coalesces bursts by
   the main channel feed or the individual reply conversation and carries that
   exact `/channels/:channelId/threads/:threadId/replies/:rootMessageId` link.
   Muted channels and quiet-hours remain suppressed. Tokens from another
   organization are never selected. For a live agent turn, leave that exact
   thread before its terminal reply: the requester receives one completion
   notification per run. A reply based on restricted sources is rechecked
   against live membership and disclosure grants immediately before delivery
   and uses only the generic body “An agent reply is ready.” Every native and
   browser push also carries that recipient's current total badge: unread
   channel messages plus visible assigned-work and knowledge attention. This is
   an absolute total, never a per-notification increment, so a later
   task/knowledge push cannot overwrite channel unread badges.

For a production check, repeat step 3 with a TestFlight build. It must reach
the production APNs host; a sandbox development token must not be sent there.

### Per-user delivery controls and open-page suppression

Each person controls their own delivery at **Settings → Notifications**. All
important categories start enabled: channel messages, direct mentions, and
operational budget warnings/blocks for organisation owners. The account-level switch and quiet hours
remain a higher-priority stop for every category; a muted channel continues to
suppress its channel and mention pushes.

Every visible Nessie browser tab or native WebView sends a short-lived,
strictly ordered structured foreground surface heartbeat. Its channel target
contains the channel, its container thread, and either a null main-feed target
or the reply conversation's root message, and is accepted only for an active
organization member with channel access. Browser heartbeats additionally require
the window to have focus. Under the same per-user lock used for session
revocation, the API also verifies the heartbeat's exact refresh session is
still live. Before delivering, the in-house worker checks whether any of that
user's active sessions is already displaying the exact channel feed, reply
conversation, or
operational-usage page the notification would open. If so, it does not send an
APNs/FCM/browser push—the realtime stream is already updating that destination.
A foreground **desktop or browser** client elsewhere in Nessie is not
suppressed: it receives its in-app banner and registered devices receive the
native delivery. The native iPhone/iPad/Android WebView does not render the
duplicate in-app message banner; its system push remains the notification
surface. A later
background signal wins over a delayed earlier foreground request, and `pagehide`
sends an unconditional null target. Backgrounded, unfocused, stale, revoked,
deactivated, and unrelated pages never suppress delivery; the API reaps expired
session records every five minutes. The selected-surface signal is shared with
the in-app banner: viewing Files, Info, or Runs in the same channel clears both
server delivery suppression and local-banner suppression.

Read state has the same precision as suppression. Each top-level post is the
root of its own reply conversation; opening reply A advances only A's cursor,
not reply B's. Opening the channel feed acknowledges its visible roots without
acknowledging their replies. Existing thread-wide read cursors remain a safe
baseline during the rollout, so deployment never reintroduces historical
unread items.

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

The current `com.km.nessie` release is `0.1.1 (2)`, freshly compiled and
installed on paired physical iPhone, iPad, and Android devices. The iOS
launches registered active sandbox APNs tokens, and the in-house APNs test
action has been accepted by Apple for the configured production credential.
This proves registration and provider acceptance; it does not substitute for a
TestFlight/App Store production-token test.

The Android app loads its authenticated workspace successfully, but it has no
active FCM registration until the matching Firebase `google-services.json` and
server-side Firebase service-account credential are supplied. Android push
delivery therefore remains intentionally unverified rather than falling back
to a different Firebase project or sender.
