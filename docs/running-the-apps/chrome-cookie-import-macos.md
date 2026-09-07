# Chrome selected-site import on macOS

This document prepares the Chrome helper for review and local development. It
is not a published Chrome extension or a desktop installer. The helper copies
only a person's explicitly selected HTTPS site cookies into the private browser
of the named Nessie agent. It never reads a Chrome profile, Keychain,
passwords, history, Sync, or browser storage, and it removes the optional
Chrome permission after each attempt.

Chrome requires both the cookies API permission and matching host access; the
extension asks for those as optional runtime permissions after the person
chooses sites, following [Chrome's permission model](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions).
Its native bridge follows [Chrome's native messaging host rules](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging):
the installed manifest fixes the executable and allowed extension origin, and
Chrome communicates with that process over framed stdio.

A copied login can still fail when a service binds it to a device or uses a
separate identity host. Choose that identity host separately when Nessie asks,
or sign in manually in the private browser. Nessie never adds related sites on
the person's behalf.

## Development package

Development uses a separate Chrome extension identity and the local API only.
It cannot be promoted to production and must not reuse a Chrome Web Store key
or identifier.

1. Start the local API and desktop app, pair a development executor, and keep
   its desktop-created state directory owner-only. On the Mac desktop build,
   the paired-state root is normally
   `~/Library/Application Support/com.unlikeotherai.nessie.desktop/executors`.
   Use the root belonging to the development desktop profile if it differs.
2. Create a development-only extension key outside the repository. Keep the
   private key private; only the DER public key reaches the development
   extension manifest.

   ```sh
   key_dir="$HOME/Library/Application Support/Nessie/ChromeImportDevelopment"
   mkdir -p "$key_dir"
   openssl genrsa -out "$key_dir/extension-private.pem" 2048
   openssl rsa -in "$key_dir/extension-private.pem" -pubout -outform DER \
     | base64 > "$key_dir/extension-public.der.base64"
   chmod 700 "$key_dir"
   chmod 600 "$key_dir/extension-private.pem" "$key_dir/extension-public.der.base64"
   ```

3. Build the executor, then prepare an isolated development package. The
   command only creates files under the chosen output directory; it does not
   register a Chrome native host, change Chrome, install software, or call the
   API.

   ```sh
   pnpm --filter @nessie/executor build
   pnpm --filter @nessie/executor prepare:chrome-cookie-import -- \
     --mode development \
     --output "$HOME/Library/Application Support/Nessie/ChromeImportDevelopment/package" \
     --state-root "$HOME/Library/Application Support/com.unlikeotherai.nessie.desktop/executors" \
     --executor-node "$(realpath "$(command -v node)")" \
     --executor-entry "$PWD/executor/dist/index.js" \
     --extension-public-key "$HOME/Library/Application Support/Nessie/ChromeImportDevelopment/extension-public.der.base64"
   ```

4. Read `configuration.json` in the output directory. It names the derived
   development extension id, the unpacked extension directory, the ZIP, and
   the native-host manifest. Load **only** that unpacked `extension` directory
   through Chrome's developer extension page. The native-host manifest remains
   an artifact until a reviewed developer registration step installs it at
   Chrome's macOS native-messaging location:
   `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/works.nessie.executor.browser_import.json`.

The generated launcher fixes three inputs: the development Node runtime and
built executor entry, the owner-only executor state root, and the exact derived
Chrome extension origin. A Chrome page cannot replace any of them. The native
host scans only protected pairing directories and selects an offer only from the
paired executor that the API confirms. It never treats an online executor as
proof that the Chrome helper is registered or usable.

## Release package prerequisites

A release needs all of the following before an installer can register the
native host:

- a Chrome Web Store publisher account and the stable extension identifier
  assigned to Nessie's listing;
- a Developer ID signed macOS launcher that is part of the verified Nessie
  desktop release and dispatches only to the fixed paired-state root;
- `NESSIE_DESKTOP_SIGNING_TEAM_ID` for that Developer ID team; and
- an installer step that copies the generated native-host manifest to Chrome's
  native-messaging directory with the release extension id and launcher path.

With those inputs, the release pipeline prepares only the reviewable artifacts:

```sh
NESSIE_DESKTOP_SIGNING_TEAM_ID=<APPLE_TEAM_ID> \
pnpm --filter @nessie/executor prepare:chrome-cookie-import -- \
  --mode release \
  --output <absolute-release-artifact-directory> \
  --state-root "$HOME/Library/Application Support/com.unlikeotherai.nessie.desktop/executors" \
  --extension-id <chrome-web-store-extension-id> \
  --signed-launcher <absolute-developer-id-signed-launcher>
```

The command verifies the launcher with `codesign --verify --strict`, confirms a
`Developer ID Application` authority and the configured TeamIdentifier, then
writes the extension ZIP and native-host manifest. It never signs a launcher,
creates a Store listing, registers the manifest, or installs an app. A missing
publisher id or signing identity is a release blocker, not a reason to use an
unpacked development identity in production.

Chrome-helper readiness must remain **unverified** until a future desktop
capability check proves that the native manifest is installed, points to the
verified launcher, and can complete a harmless native-host handshake. A paired
executor being online is insufficient.

The synthetic native-to-API-to-Browserbase import has passed, including the
confirmed Browserbase release. It did not verify the operating-system Chrome
registration: the isolated-profile check could not install it, and the current
Mac lacks the required `Developer ID Application` identity. A stable Chrome Web
Store extension id and an installer-owned registration step are still release
prerequisites.

## Safari status

[Safari Web Extensions](https://developer.apple.com/documentation/safariservices/safari-web-extensions)
and [containing-app to extension messaging](https://developer.apple.com/documentation/safariservices/messaging-between-the-app-and-javascript-in-a-safari-web-extension)
make Safari a viable research path. Nessie has not implemented or verified its
cookie permission, native app transport, signing, or entitlements, so Safari is
unavailable for selected-site import. This is an implementation gap, not a
claim that Safari cannot support the feature.

## Windows follow-up

Windows needs a separate implementation. Its paired state belongs to the
Nessie Executor service under `%ProgramData%`, so an interactive Chrome native
host cannot read it. The Windows design must add an authenticated named-pipe
bridge from a per-user host launcher to the service, enforce the caller's SID
and bounded native-message framing, and have the service perform the protected
state-root dispatch and signed API transfer. It also needs an MSI-owned Chrome
manifest registration path and Windows signing validation.

This is expected to be a focused follow-up of roughly 8–12 files and
700–1,000 lines with service/pipe/installer tests plus Windows CI coverage. It
is intentionally not included in the macOS package, because forwarding Chrome
cookie payloads through an unauthenticated or broadly ACL'd IPC channel would
weaken the state isolation it is meant to preserve.
