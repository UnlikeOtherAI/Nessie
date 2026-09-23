# Native verification — 2026-09-23

## Results

- iPhone 17 Pro, iOS 26.5: all 15 checks passed across the full suite and a
  focused rerun of the account test after fixing its accessibility selectors.
- iPad Pro 11-inch (M5), iPadOS 26.5: full suite, 15 passed, 0 failed or skipped.
- Mac Catalyst: Release build succeeded for both `arm64` and `x86_64`.
  The built bundle identifier is `com.unlikeotherai.deepwater`. The binary
  contains neither the test identity nor the `--ui-testing` launch switch.
- Strict SwiftLint and repository Markdown structure lint passed.
- A native Foundation `URLSession` probe of the live `/v1/auth/start` returned
  HTTP 200, the expected UOA authority and HTTPS callback, S256 PKCE and an
  isolated `dw_auth_pkce` cookie. No account credentials were used.

The nine unit tests cover the OAuth callback boundary, research request and
retry contracts, workspace invalidation, absent mutation capabilities,
full-report liveness, Markdown rendering structure, API envelopes and
multilingual assistant events. Six UI tests cover report/source reading,
creation with an accepted-but-timed-out request, empty/offline recovery,
account/credits/people/sign-out, project creation/selection and orientation.

Screenshots in [Screenshots](Screenshots/) come from the simulator UI tests.
They use explicitly labelled sample research and a fixture account. Native
split navigation, portrait iPhone layout, sheets, text fields, error recovery
and sign-in were visually inspected. Mac verification is compilation only;
no unsigned Mac application was installed or run.

## Reproduction and limits

Use the test commands in [README](README.md). The `DeepWater Native` workflow
runs iPhone and iPad tests and compiles Mac Catalyst on every app pull request.
Its result bundles preserve screenshots and failure diagnostics.

The HTTP fixtures intercept all requests and cannot access a live service.
Live OAuth completion, paid research, assistant inference, real membership
changes and real billing mutations were not performed. The website must
publish the prepared Apple domain association before a signed-app OAuth
completion check; the deployed association URL currently serves SPA HTML.

The iPad app allows multitasking in its manifest and uses adaptive native split
navigation. The simulator orientation test covers portrait and landscape;
manual operating-system window resizing and physical-device distribution
signing are separate release checks.
