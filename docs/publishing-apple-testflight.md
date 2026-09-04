# Publishing iOS and macOS TestFlight Builds

This is the release procedure for Nessie's Apple TestFlight builds. It covers
the actual mobile app and the current Tauri desktop product, not the legacy
`macos/` SwiftUI project.

> **Direct device delivery is different from TestFlight publishing.** When the
> request is to put the latest Nessie build on a physical phone or tablet,
> follow the [default direct-device delivery policy](running-the-apps/overview.md#default-physical-device-delivery): build the self-contained `device` IPA,
> install and launch it on each named device, and verify it there. Do not use an
> Expo development client unless Metro was explicitly requested. Apple calls
> the direct-install provisioning method Ad Hoc; it is still the normal
> standalone app and does not depend on the developer Mac or local network.

The Apple team identifier and bundle identifier are public release metadata,
not credentials:

| Platform | Product | Bundle identifier | Version source |
| --- | --- | --- | --- |
| iOS | `mobile/` Expo app | `com.km.nessie` | `mobile/app.json` (`version`, `ios.buildNumber`) |
| macOS | `desktop/` Store override | `com.km.nessie` | `desktop/src-tauri/tauri.appstore.conf.json` (`version`, `bundle.macOS.bundleVersion`) |

The Apple team is `59S95D279D`. Apple signing certificates, provisioning
profiles, API keys, and their private keys stay in the operator's Apple account
or Keychain; never commit them. This guide intentionally contains no such
material.

## What ships to TestFlight

`desktop/src-tauri/tauri.conf.json` is the direct-distribution desktop product:
its bundle identifier is `com.unlikeotherai.nessie.desktop`, it can bundle the
local executor runtime, and it uses a Developer ID signature. Do not upload
that configuration to App Store Connect.

The TestFlight build is the separate `tauri.appstore.conf.json` override. It is
an App Sandbox build of the same hosted Nessie product, with desktop SSO and
notifications but without the local executor runtime. The executor's
Developer-ID and file-access design is not App Sandbox-compatible yet.

## Before every release

1. Start from a clean, current `main` checkout and choose the exact versions.
   A build number must be new for its platform/version in App Store Connect.
   Increment it before building; re-uploading an existing number is rejected.
2. Update the release configuration:

   - iOS: change `expo.version` and increase `expo.ios.buildNumber` in
     `mobile/app.json`.
   - macOS: change `version` and increase `bundle.macOS.bundleVersion` in
     `desktop/src-tauri/tauri.appstore.conf.json`.

3. Run the release checks from the repository root:

   ```sh
   pnpm install --frozen-lockfile
   pnpm lint
   pnpm exec turbo run lint typecheck test --filter=@nessie/mobile --filter=@nessie/desktop --force
   pnpm --dir mobile exec expo install --check
   pnpm --dir mobile exec expo config --type introspect --json
   ```

   Resolve unexpected Expo dependency or schema failures before publishing. The
   resolved iOS config must show `com.km.nessie`, team `59S95D279D`, the planned
   version/build number, and production as the WebView target.

   The team intentionally pins React and its types to the one hoisted
   version shared by the admin and native bundles. Those two packages are listed
   in `mobile/package.json` under `expo.install.exclude`; every other Expo SDK
   dependency remains version-checked normally.

4. Commit the version changes and all related release configuration before the
   upload. The uploaded artifact is traceable only if its source version is in
   Git. The production EAS profile deliberately does not auto-increment: the
   number printed by preflight is the number compiled into the binary.

## iOS

### One-time EAS setup

EAS is optional: Xcode can archive and upload iOS locally. If EAS is used,
link the existing Expo project once, then commit the non-secret configuration:

```sh
cd mobile
pnpm dlx eas-cli@latest login
pnpm dlx eas-cli@latest init
```

This fills `expo.owner` and `extra.eas.projectId` in `mobile/app.json`. Replace
the three `submit.production.ios` placeholders in `mobile/eas.json` with the
App Store Connect Apple ID, app record ID, and Apple team ID. Those identifiers
are safe to commit, but EAS and Apple authentication tokens are not. Confirm
the profile describes `com.km.nessie` before the first production build. For
the Actions release, add an Expo personal access token as the `EXPO_TOKEN`
secret in the protected `app-store-production` environment. The iOS job refuses
to start EAS when that secret is absent.

### Build and upload with EAS

After the one-time setup, the recurring path is:

```sh
cd mobile
pnpm dlx eas-cli@latest build --platform ios --profile production
pnpm dlx eas-cli@latest submit --platform ios --latest --profile production
```

Use `--auto-submit` only after the submit profile has been completed and tested.
EAS must be authenticated as an account with access to the Nessie App Store
Connect record. Expo documents the [CI build flow](https://docs.expo.dev/build/building-on-ci/)
and [automatic submissions](https://docs.expo.dev/build/automate-submissions/).

### Internal development builds

`expo-dev-client` is intentionally installed in `mobile/` so the existing
`development` EAS profile can produce installable debug clients for physical
iPads and Android devices. These are not App Store or Play Store releases:
they open the Expo development menu and load JavaScript from Metro.

```sh
cd mobile
EXPO_NO_KEYCHAIN=1 pnpm dlx eas-cli@latest build --platform ios --profile development
EXPO_NO_KEYCHAIN=1 pnpm dlx eas-cli@latest build --platform android --profile development
```

An iOS development client requires the target iPad's UDID to be registered on
the Apple development provisioning profile. Android internal builds are APKs;
open the EAS download link on the tablet and allow that one install when
prompted. Start Metro on the development machine before opening either client:

```sh
pnpm --dir mobile start --dev-client
```

### Local Xcode alternative

Use this route when the Apple account is available in Xcode or when EAS has not
been linked yet:

```sh
cd mobile
pnpm exec expo prebuild --platform ios --clean
open ios/Nessie.xcworkspace
```

In Xcode, select team `59S95D279D`, choose a generic iOS device destination,
then use **Product → Archive**. In Organizer, select the archive and choose
**Distribute App → App Store Connect → Upload**. Validate it first when
possible. The archive must use an Apple Distribution signing identity, have
`aps-environment=production`, and retain
`ITSAppUsesNonExemptEncryption=false`.

## macOS

### One-time Apple setup

The Nessie App Store Connect record must have both iOS and macOS platforms. In
the Apple Developer portal, its App ID must be `com.km.nessie` on team
`59S95D279D`.

Install these two Mac App Store identities in the login Keychain. Xcode may
display their historical names as `3rd Party Mac Developer Application` and
`3rd Party Mac Developer Installer`:

```sh
security find-identity -v -p codesigning
```

Create a **Mac App Store Connect** provisioning profile for `com.km.nessie`.
The profile must report platform `OSX`, team `59S95D279D`, and application
identifier `59S95D279D.com.km.nessie`. A distribution profile may omit
`get-task-allow`; Nessie's preparation script treats that as the required
`false` value.

### Build the Store variant

Set the profile location and the exact application identity that
`security find-identity` printed, then build from the repository root:

```sh
export NESSIE_DESKTOP_APPSTORE_PROFILE=/absolute/path/to/Nessie.provisionprofile
export NESSIE_DESKTOP_SIGNING_TEAM_ID=59S95D279D
export APPLE_SIGNING_IDENTITY='3rd Party Mac Developer Application: <legal name> (59S95D279D)'

pnpm --dir desktop run tauri:build:appstore
```

The output is:

```text
desktop/src-tauri/target/release/bundle/macos/Nessie.app
```

Verify the exact artifact before uploading:

```sh
APP=desktop/src-tauri/target/release/bundle/macos/Nessie.app
codesign --verify --deep --strict "$APP"
codesign -dvv --entitlements :- "$APP"
plutil -p "$APP/Contents/Info.plist"
test ! -e "$APP/Contents/Resources/executor-runtime"
```

The signature must identify `com.km.nessie` and team `59S95D279D`. Its
entitlements must include App Sandbox and outbound-network access, and it must
not contain the executor runtime.

### Add symbols and stage an Xcode archive

Organizer is the primary upload route. Generate a matching dSYM so Apple can
symbolicate crash reports:

```sh
APP=desktop/src-tauri/target/release/bundle/macos/Nessie.app
DSYM="$APP.dSYM"
dsymutil "$APP/Contents/MacOS/nessie-desktop" -o "$DSYM"
dwarfdump --uuid "$APP/Contents/MacOS/nessie-desktop"
dwarfdump --uuid "$DSYM"
```

The two UUIDs must match. Stage the signed app and its dSYM in an archive that
Organizer can open:

```sh
APP=desktop/src-tauri/target/release/bundle/macos/Nessie.app
DSYM="$APP.dSYM"
ARCHIVE="$HOME/Library/Developer/Xcode/Archives/$(date +%F)/Nessie $(date +%F), $(date +%H.%M).xcarchive"
VERSION='0.1.2' # Match tauri.appstore.conf.json.
BUILD_NUMBER='2' # Match tauri.appstore.conf.json.
mkdir -p "$ARCHIVE/Products/Applications" "$ARCHIVE/dSYMs"
ditto "$APP" "$ARCHIVE/Products/Applications/Nessie.app"
ditto "$DSYM" "$ARCHIVE/dSYMs/Nessie.app.dSYM"
plutil -create xml1 "$ARCHIVE/Info.plist"
/usr/libexec/PlistBuddy \
  -c 'Add :ApplicationProperties dict' \
  -c 'Add :ApplicationProperties:ApplicationPath string Applications/Nessie.app' \
  -c 'Add :ApplicationProperties:Architectures array' \
  -c 'Add :ApplicationProperties:Architectures:0 string arm64' \
  -c 'Add :ApplicationProperties:CFBundleIdentifier string com.km.nessie' \
  -c "Add :ApplicationProperties:CFBundleShortVersionString string $VERSION" \
  -c "Add :ApplicationProperties:CFBundleVersion string $BUILD_NUMBER" \
  -c "Add :ApplicationProperties:SigningIdentity string $APPLE_SIGNING_IDENTITY" \
  -c 'Add :ApplicationProperties:Team string 59S95D279D' \
  -c 'Add :ArchiveVersion integer 2' \
  -c 'Add :Name string Nessie' \
  -c 'Add :SchemeName string Nessie' \
  "$ARCHIVE/Info.plist"
plutil -insert CreationDate -date "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$ARCHIVE/Info.plist"
```

Set `VERSION` and `BUILD_NUMBER` to the values in
`tauri.appstore.conf.json`. Do not re-sign the staged app: `ditto` preserves the
validated signature and embedded provisioning profile.

Open the archive with **Xcode → Window → Organizer → Archives → File → Open**.
It must display as a macOS App Archive for `com.km.nessie`. Select **Validate
App**, then **Distribute App → App Store Connect**. Do not select Direct
Distribution. Xcode uses the Mac Installer Distribution identity as part of the
Store upload flow.

## Finish in App Store Connect

For each platform, wait for the upload to leave **Processing**, then check the
following on **TestFlight → iOS** or **TestFlight → macOS**:

1. The exact version and build number is present and shows **Ready to Submit**.
2. The build is attached to the intended internal group. Use **Add Group** if
   the group is absent.
3. An internal tester can install it. External testing additionally requires
   the usual TestFlight beta review and completed test information.

The most recent verified release was iOS `0.1.1 (3)` and macOS `0.1.1 (1)`.
Those numbers are historical only; the next release must use higher build
numbers.

## GitHub Actions automation

`.github/workflows/publish-apple-testflight.yml` is a manually triggered
release workflow. It always runs the source preflight first. With **Publish**
left false, it performs only that safe validation. With **Publish** enabled, it
builds the selected platform and submits it to App Store Connect.

The macOS job builds a signed installer package and uploads it with `altool`.
Apple documents `altool` and Transporter as supported Mac App Store upload
tools in its [macOS packaging guide](https://developer.apple.com/documentation/xcode/packaging-mac-software-for-distribution).

The workflow only releases `main` and serializes Apple submissions, so two
builds cannot race for the same version. Protect the `app-store-production`
GitHub Actions environment with the release approvers before enabling
publishing.

### Configure the `app-store-production` environment

Add these environment **secrets**:

| Secret | Value |
| --- | --- |
| `EXPO_TOKEN` | Expo access token that can build and submit the linked Nessie iOS project |
| `MACOS_APP_CERTIFICATE_P12_BASE64` | Base64 of the Mac App Store application-signing `.p12`, including its private key |
| `MACOS_APP_CERTIFICATE_PASSWORD` | Password for that `.p12` |
| `MACOS_INSTALLER_CERTIFICATE_P12_BASE64` | Base64 of the Mac Installer Distribution `.p12`, including its private key |
| `MACOS_INSTALLER_CERTIFICATE_PASSWORD` | Password for that `.p12` |
| `MACOS_PROVISIONING_PROFILE_BASE64` | Base64 of the macOS `com.km.nessie` distribution profile |
| `APP_STORE_CONNECT_API_KEY_P8_BASE64` | Base64 of a least-privilege App Store Connect API key `.p8` |

Add these environment **variables**:

| Variable | Value |
| --- | --- |
| `MACOS_APPLICATION_SIGNING_IDENTITY` | Exact output from `security find-identity` for the Mac App Store application identity |
| `MACOS_INSTALLER_SIGNING_IDENTITY` | Exact output from `security find-identity` for the Mac Installer Distribution identity |
| `APP_STORE_CONNECT_API_KEY_ID` | App Store Connect API key identifier |
| `APP_STORE_CONNECT_API_ISSUER_ID` | App Store Connect API issuer identifier |

A `.cer` file alone cannot sign on Actions: export the identity and its private
key as a password-protected `.p12`. The hosted macOS runner creates a temporary
keychain, imports both identities and the provisioning profile, and is then
destroyed when the job finishes.

To create each Base64 secret on macOS:

```sh
base64 -i Nessie-distribution.p12 | pbcopy
base64 -i Nessie.provisionprofile | pbcopy
base64 -i AuthKey_ABCDEFGHIJ.p8 | pbcopy
```

After the one-time EAS setup described above, open **Actions → Publish Apple
TestFlight**, select `ios`, `macos`, or `both`, and set **Publish** to true.
Apple still processes the upload asynchronously; check the TestFlight platform
page and attach the intended internal group if it is not already present.

## Common failures

| Symptom | Fix |
| --- | --- |
| App Store Connect rejects a duplicate build | Increase only that platform's build number, commit it, rebuild, and upload again. |
| Mac build says the profile is invalid | Confirm its `OSX` platform, team, app identifier, expiration, and distribution `get-task-allow` state. Pass its absolute path in `NESSIE_DESKTOP_APPSTORE_PROFILE`. |
| Xcode validation reports a missing dSYM | Run `dsymutil`, compare UUIDs with `dwarfdump`, restage the archive, and validate again. |
| Mac build shows the wrong bundle identifier or executor controls | Rebuild with `tauri:build:appstore`; do not upload the normal Tauri configuration. |
| iOS EAS Prebuild cannot open `assets/icon.png` | Do not exclude `mobile/assets/*.png` in `.gitignore` or `.easignore`. EAS uses these files to generate the iOS app icons. |
| iOS EAS submit cannot find the project or App Store record | Complete the one-time `eas init` and `eas.json` submit configuration, then verify the Expo/Apple account access. |
| The iOS Actions job fails at `Require Expo access token` | Add an Expo personal access token as the protected environment's `EXPO_TOKEN` secret; do not use a local CLI session token. |
