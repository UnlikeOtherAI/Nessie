# Running the Native Apps

This guide gives copy-paste paths for running Nessie's desktop and mobile apps. The desktop path works without an Apple Developer account; the mobile WebView shell needs Apple Developer signing to run on a physical device.

## Prerequisites

- Work from the Nessie repository root.
- Node.js, pnpm, and Rust are already installed locally.
- For the mobile app on a physical device, use an iPhone/iPad on the same Wi-Fi network as your Mac and an Apple Developer Program membership for signing (the app uses a native WebView module, so Expo Go cannot host it).
- For EAS iOS builds later, use an Expo account and an Apple Developer Program membership.

## Mac Desktop - Works Now

Terminal 1:

```sh
pnpm install
pnpm dev
```

This starts the API on port `5554` and the admin app on port `5555`.

Terminal 2:

```sh
pnpm --filter @nessie/desktop exec tauri dev
```

The Nessie desktop window opens and loads the local admin app.

Desktop SSO uses the user's default browser instead of the Tauri webview. The
desktop bundle declares the `nessie` URL scheme; after UOA redirects to
`nessie://auth/callback`, macOS focuses the running app and the admin login page
finishes the PKCE exchange from the deep link.

To create a local distributable:

```sh
pnpm --filter @nessie/desktop exec tauri build
```

This produces an unsigned `.app` and `.dmg`. On first open, right-click the app and choose **Open**. A signed and notarized macOS release needs the operator's Apple Developer ID certificate; `desktop/src-tauri/tauri.conf.json` keeps `signingIdentity` set to `null` until that certificate is available.

## Mobile app — WebView shell

The mobile app is a **thin WebView shell around the admin web UI**, mirroring the
desktop app. There are no hand-built native screens: `mobile/App.tsx` renders a
single full-screen `react-native-webview` that loads the admin. The URL split
lives in `mobile/src/config.ts`:

- **dev** → `http://<YOUR-MAC-LAN-IP>:5555` (the admin Vite dev server; edits
  hot-reload on the device, and the admin's `/api` calls are proxied to the API)
- **prod** → `https://nessie.unlikeotherai.com` (the hosted admin)

Update the dev branch of `ADMIN_URL` to your Mac's LAN IP before building. The
old native app (login/channels screens) is archived at `archive/mobile-native`.

`react-native-webview` is a native module, so **Expo Go cannot host it** — you
need a prebuilt build installed on the device. Building for a physical device
requires Apple Developer signing.

```sh
# 1. Run the admin + API dev servers (repo root); the admin must be LAN-reachable.
pnpm dev                      # API :5554, admin :5555

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
