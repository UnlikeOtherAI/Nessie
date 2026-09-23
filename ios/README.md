# DeepWater for iPhone, iPad and Mac

Standalone SwiftUI client for DeepWater, housed in `ios/` in this repository.
It calls `https://api.deepwater.live` directly. It does not embed the Nessie
interface or a browser-based research interface.

## Design

Use system lists, forms, pickers, sheets, toolbars, share sheets and
`NavigationSplitView`. DeepWater's web accent is `#0071e3`; typography,
background materials, accessibility sizing and contrast follow the operating
system. The two-column library and report share one implementation that
collapses into a navigation stack on iPhone and narrow iPad windows.

- iPhone supports portrait only.
- iPad supports all orientations, Split View and window resizing.
- The iPad binary is eligible for Apple-silicon Macs.
- Mac Catalyst is also enabled for an independently built Mac application.
- Minimum OS: iOS/iPadOS 17.4, with the corresponding Mac Catalyst deployment
  target. No third-party Swift packages are needed.

## Build and test

Install Xcode, XcodeGen and SwiftLint. From `ios/`:

```sh
xcodegen generate --spec project.yml
open DeepWater.xcodeproj
```

Choose the `DeepWater` scheme and an iPhone or iPad simulator. The checked-in
project is generated from `project.yml`; regenerate it when sources or build
settings change. Every build runs strict SwiftLint before compilation.

```sh
xcodebuild -project DeepWater.xcodeproj -scheme DeepWater \
  -destination 'platform=iOS Simulator,id=SIMULATOR_UUID' \
  -derivedDataPath build -parallel-testing-enabled NO test

xcodebuild -project DeepWater.xcodeproj -scheme DeepWater \
  -destination 'generic/platform=macOS,variant=Mac Catalyst' \
  -derivedDataPath build/catalyst CODE_SIGNING_ALLOWED=NO build
```

The unsigned Catalyst command verifies compilation only. It is not a
distributable or installed Mac release. Set your Apple development team in
Xcode for device builds; distribution requires the usual signing and
provisioning. Keep simulator signing enabled so Keychain access can be tested.

## Sign-in and release prerequisite

Sign-in uses `ASWebAuthenticationSession`, UOA's hosted sign-in page and the
existing DeepWater `/v1/auth/start` and `/exchange` endpoints. The server owns
the PKCE verifier, held in an isolated in-memory cookie jar. The native app
adds a cryptographically random state and checks the exact HTTPS callback,
one state and one code before exchange. No client secret is in the app.

Apple requires the HTTPS callback domain to be associated with the signed app.
Publish `Hosting/apple-app-site-association` at
`https://admin.deepwater.live/.well-known/apple-app-site-association`, served
as JSON without redirects or the single-page-app HTML fallback. The prepared
file uses the Apple team already configured in this repository,
`59S95D279D`, and bundle ID `com.unlikeotherai.deepwater`. If the release team
differs, update both the app signing team and the association file.

Both `webcredentials` and `applinks` entitlements name that exact domain.
On 2026-09-23, the deployed association URL returned the admin HTML fallback;
live OAuth completion is therefore a release prerequisite, not a verified
result of simulator fixture tests. No production host was changed by this app
implementation. The UOA callback remains the existing
`https://admin.deepwater.live/auth/callback`.

Only Water's opaque rotating session handle persists, in the device-only
Keychain. Access tokens, identities, team names, membership and research
responses remain in memory. UOA remains the identity authority. API requests
never follow redirects. Refresh is coalesced; workspace changes invalidate
in-flight responses and rebuild the interface to drop the previous team's data.

## Screens and API contracts

The reference implementation is the sibling Water repository, particularly
`admin/src/api`, `api/src/routes/contracts.ts` and
`packages/uoa-client/src/workspace-directory.ts`. Additive response fields are
accepted by a flexible JSON envelope; research records validate their required
identity, query and status before rendering. Mutations require the service's
explicit run capabilities.

| Home / doorway | Server contract |
| --- | --- |
| Research list, search and filters | `GET /v1/admin/runs` |
| Projects toolbar, project selection and creation | `/v1/admin/projects` |
| Updates toolbar, recently finished research | `GET /v1/admin/runs` |
| New research toolbar, native setup form | `POST /v1/admin/research` |
| Refine question, assistant conversation | `/v1/admin/stream-ticket`, `/v1/admin/chat` |
| Selected research, report, sources and activity | `/v1/admin/runs/:id`, `/events`, `/v1/research/:id/sources` |
| Research actions, follow-up and report generation | Existing run mutation, extension, generate-summary and generate-full-report routes |
| Account, team switcher | `/v1/auth/workspaces`, `/v1/auth/workspace` |
| Account, people and invitations | `/v1/admin/workspace/members`, `/invitations` |
| Account, plan and credits | Existing billing statement, credits and hosted action routes |
| Account, API keys and webhook | `/v1/admin/keys`, `/profile`, `/settings` |

New research freezes its exact request and UUID idempotency key before network
dispatch. An uncertain response is retried with the same request and key.
Privacy is explicit; the app reads the server's privacy entitlement and never
quietly turns a private request public. The assistant proposes questions for
the person to accept; no keyword matching interprets user intent.

## Verification

`DeepWaterTests` covers callback validation, wire contracts, identity-bound
launch records, workspace invalidation, full-report refresh, Markdown structure,
missing capability refusals and multilingual assistant events.
`DeepWaterUITests` exercises native research reading, sources, creation,
uncertain-launch recovery, projects, empty/offline states, people, credits, sign-out and
orientation. Screenshots are retained as `.xcresult` attachments.

Debug-only `--ui-testing` installs `FixtureTransport`, which intercepts every
request and never falls through to a live service. Fixtures are compiled out
of Release. They verify client behavior, not paid inference, real account
access, deployed OAuth completion or a signed App Store release.
