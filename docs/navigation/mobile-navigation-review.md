# Mobile navigation review — 2026-09-26

## Decision

Use the public `createGesture` API from `@ionic/core` 9.0.5 for the shared
phone stack's edge Back. Keep Nessie's surface registry, retained screens,
route controller, Back resolver and Web Animations motion driver as the single
navigation framework. Both the iOS and Android WebViews run this code; Android
hardware Back continues through the same resolver and paired screen motion.

This adopts a maintained gesture engine, not Ionic's complete router or visual
component system. It does not turn the WebView into a native view-controller
stack. The existing header bridge remains the iPhone shell's responsibility.

The owning surface is `PhoneNavigationViewport`; its doorways are route links,
page Back controls, nested stages, edge Back and Android hardware Back. There
is no separate navigation path for channels, reply threads or projects.

## Alternatives and licensing

| Candidate | Evidence and license | Fit for this application |
| --- | --- | --- |
| Ionic Core | [Public standalone gesture API](https://ionicframework.com/docs/utilities/gestures); [9.0.5 MIT license](https://github.com/ionic-team/ionic-framework/blob/v9.0.5/core/LICENSE). A long-established cross-platform project with a substantial public ecosystem. | Adopt its frame-coalesced recognition and pointer lifecycle without adding another router. |
| Ionic React router | [Retained pages and transitions](https://ionicframework.com/docs/react/navigation); [9.0.5 package contract](https://github.com/ionic-team/ionic-framework/blob/v9.0.5/packages/react-router/package.json). MIT. | Its declared React Router peer range is `>=6.4.0 <7`; Nessie uses 7.14. It also takes ownership of outlets and page lifecycles. Not a supported drop-in replacement. |
| Stackflow | [Mobile stack and swipe-back design](https://stackflow.so/docs/get-started/introduction); [MIT license](https://github.com/daangn/stackflow/blob/main/LICENSE). | Purpose-built for React WebViews; a credible full-stack alternative. Adoption would require replacing the retained activity/history integration and translating every route and state-driven stage, with a smaller ecosystem than Ionic. |
| React Navigation native stack | [Native iOS and Android implementation](https://reactnavigation.org/docs/native-stack-navigator/); [MIT license](https://github.com/react-navigation/react-navigation/blob/main/packages/native-stack/LICENSE). | Strong option for a future native-screen architecture. The current product renders its screens inside one WebView; wrapping that one view in a navigator cannot animate the individual web screens. Each screen would need a native boundary, with shared state and deep links redesigned. |

Nessie's license is FSL-1.1-ALv2. Ionic's MIT permission covers commercial use,
modification and distribution, subject to retaining its copyright and permission
notice. Ionic remains MIT; adding it does not relicense Nessie's own code.
The complete installed notice ships as `admin/public/licenses/ionic.txt` and is
copied into the served bundle by Vite. No copyleft dependency was selected.

## Findings addressed

- The old touch handler set React state on every movement, reconciling retained
  navigation layers on the gesture's critical path. Ionic schedules movement
  once per frame and the motion driver updates only the two layer transforms
  and underlay scrim. The phone stack no longer uses the hand-written recognizer
  or velocity estimator; the sheet primitive still uses its existing helpers.
- The settle cancelled its animation before React committed Back. That could
  expose the old inline drag pose while the router update was pending. The
  final animated pose now survives until the route/stage actually commits,
  including an asynchronous browser history traversal.
- A cancelled swipe announced a full parent-to-detail transition to the iPhone
  bar even though that bar had stayed on the detail. Cancellation now leaves
  the header alone.
- The browser's overscroll Back could traverse history before the app's
  release completed, causing a second full pop. The single layout disables
  horizontal overscroll navigation at the document boundary. This is the
  [browser's supported control](https://developer.chrome.com/blog/overscroll-behavior);
  vertical scrolling and Android's system Back remain available.
- A current layer dropped its transform at rest. Fixed descendants, including
  the reply panel, could therefore change containing block between resting
  and moving states. The resting layer keeps an identity transform.
- The transition guard previously started only on release. It now also covers
  the held drag, deferring data-driven redirects. Leaving a layer retires its
  gesture, and Back is captured when the gesture is claimed.
- Touch cancellation settles back through the motion driver instead of
  snapping immediately. Backgrounding cancels unfinished gesture work.

## Acceptance

Exercise real route pushes and Back, committed/cancelled/reversed swipes,
thread-to-channel and channel-to-menu, project-to-list, cold links, nested
stages, reduced motion, an interruption while dragging, and Android's native
Back bridge. Inspect movement and the settled frame, including fixed panels,
not just the final pathname. Browser shell emulation verifies the shared app
and bridge contract; it is not a physical-device frame-rate measurement.

The navigation suite includes `phone-gesture-ios`, `phone-gesture-android`
and `phone-gesture-webkit`. Install the additional renderer with
`pnpm exec playwright-core install webkit`, then run
`pnpm --filter @nessie/admin test:e2e:navigation` with `DATABASE_URL` set.
The WebKit case uses DOM touch events because Playwright's WebKit protocol
does not expose touch dragging; Chromium cases use real CDP touchscreen input.
