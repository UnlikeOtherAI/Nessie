# Running the Native Apps

This guide gives copy-paste paths for running Nessie's native desktop and mobile apps. The paths that work today do not require an Apple Developer account.

## Prerequisites

- Work from the Nessie repository root.
- Node.js, pnpm, and Rust are already installed locally.
- For iPhone with Expo Go, use an iPhone on the same Wi-Fi network as your Mac.
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

## iPhone Via Expo Go - Works Now

Install **Expo Go** from the App Store. It is free and does not require an Apple Developer account.

Terminal:

```sh
cd mobile
npx expo start
```

If the iPhone cannot reach the Metro server over LAN, use a tunnel:

```sh
cd mobile
npx expo start --tunnel
```

Scan the QR code with the iPhone Camera app or Expo Go.

On the app's login screen:

1. Set **API base URL** to `http://<YOUR-MAC-LAN-IP>:5554`.
2. Confirm the iPhone and Mac are on the same Wi-Fi network.
3. Tap **Dev login (localhost)**.

Use the LAN IP because production login is SSO-only and not configured for this local flow. Push notifications do not work in Expo Go.

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

The mobile and desktop apps are configured to compile and bundle, but they have not been run on a real device or simulator yet. Expect a rough edge or two on first launch.
