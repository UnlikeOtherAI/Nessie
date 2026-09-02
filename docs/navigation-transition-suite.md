# Navigation — the transition suite

The browser suite that pins the navigation motion. It is chapter §11 of
[`navigation.md`](navigation.md), moved here so that file stays under the
markdown structure gate’s line cap; the rule it serves is stated there.


The JSDOM harness cannot see an animation and cannot see a layout, so the
motion itself is pinned in a real browser:
`admin/e2e/navigation/` (run it with
`pnpm --filter @nessie/admin test:e2e:navigation`).

What it does, per run:

- starts the real API on 5454 and the real admin on 5455 against
  `DATABASE_URL` — a server already listening on either port is used as it
  stands, so it costs nothing next to a running `pnpm dev`;
- signs in through the product's own doors — the one-time owner bootstrap on
  a fresh database, `GET /api/auth/dev-login` on a database that already has
  an owner — and seeds one organisation with its project and two channels
  through `POST /api/channels`;
- drives Chromium (`playwright-core`, no `@playwright/test`) at 390×844,
  768×1024 and 1280×800.

What a case asserts. It **freezes the real animation** rather than timing it:
a `requestAnimationFrame` watcher pauses every animation that appears on a
`[data-phone-navigation-layer]`, then `currentTime` is seeked to 0 %, 50 %
and 100 % and each frame is measured with `getBoundingClientRect()`. There is
no sleep anywhere in the measurement. `document.getAnimations()` is the seam
on purpose: it sees a CSS keyframe animation and a Web Animations one alike,
so the suite survived the step-2 rewrite unchanged. Every frame also asserts
`scrollLeft === 0` on `.phone-navigation-viewport` and on every
`.phone-navigation-screen` — that is §2's bounce, measured.

| case | viewport | what it pins |
| --- | --- | --- |
| `phone-push` | 390×844 | tapping a channel row: the conversation travels 100 % → 0, the list 0 → -28 % |
| `phone-back` | 390×844 | header Back: the conversation travels 0 → 100 %, the list -28 % → 0 |
| `phone-edge-swipe` | 390×844 | a touchscreen swipe from x=8 to x=300 commits Back; the settle runs from exactly the released displacement to the ends |
| `phone-tab-switch` | 390×844 | Messages → Files moves nothing: no layer animates, the screen's rect is unchanged |
| `tablet-select` | 768×1024 | selecting a channel in the split stack is an in-place swap: one layer, nothing animates, the columns keep their geometry |
| `desktop-select` | 1280×800 | the same at desktop width |
| `tablet-split-push` / `desktop-split-push` | 768×1024 / 1280×800 | Agents → the designer pushes inside the detail column: the designer travels 100 % → 0 of the column, the list 0 → -28 %, the pinned sidebar never moves |
| `phone-cold-start` | 390×844 | a cold link to a conversation seeds the channel list beneath it; header Back slides the conversation away over that list (0 → 100 %, -28 % → 0) |
| `phone-intent-strip` | 390×844 | `#trigger-<id>` and `?messageId=` are consumed and stripped with a replace: the address settles on the screen, the linkable `?tab=` stays, and browser Back lands on the stripped address |

Each transition case navigates once per saved frame, deliberately: the stack
closes its own transition on a fallback timer shortly after the animation's
nominal end, so one run cannot hold a frozen frame for three screenshots —
while all three fractions are measured inside one synchronous `evaluate`,
far inside that window. Frames land in `e2e/screenshots/navigation/<case>/`
(`00-start`, `01-midway`, `02-settled`) for the eyeball rule in `AGENTS.md`.

Where it runs:

- **CI** — the `navigation-e2e` job in `.github/workflows/ci.yml`: Postgres 16
  + pgvector, `prisma migrate deploy`, a built admin bundle
  (`NAV_E2E_ADMIN_MODE=preview`), `pnpm exec playwright-core install
  --with-deps chromium`, and the frames uploaded as the
  `navigation-transition-frames` artifact.
- **Locally** — `DATABASE_URL=… pnpm --filter @nessie/admin test:e2e:navigation`.
  Useful switches: `--case=phone-push` / `--viewport=phone` to narrow,
  `CHROMIUM_PATH` to name a browser binary, `NAV_E2E_ADMIN_MODE=preview` to
  serve `admin/dist` instead of the dev server, `NAV_E2E_SERVER_LOGS=1` to see
  the servers' output, `NAV_E2E_KEEP_SERVERS=1` to leave them up.
  With no reachable database the suite prints why and exits 0 — everything it
  asserts needs a running product, and a red run that only means "no Postgres
  here" teaches people to ignore it.
- **On device** — iPhone and iPad checks stay manual; the plan lists them per
  step.

**What it caught first.** `phone-back` was red on its first run: the route
pop painted only the returning list, because `advancePhoneNavigationStack`'s
same-depth branch truncated every entry above `currentIndex` on the first
re-render of the destination (its data settling is enough), and after a Back
the outgoing screen *is* that entry. The stack now refreshes a same-route
re-render in place and releases the entries above only for a sibling swap;
`admin/test/phone-navigation-stack.test.ts` replays the route mid-Back to
pin it. The JSDOM stack test had passed because it never replayed a route —
the browser suite is what sees it.
