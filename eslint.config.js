import tsPlugin from '@typescript-eslint/eslint-plugin'
import tsParser from '@typescript-eslint/parser'
import reactHooksPlugin from 'eslint-plugin-react-hooks'

// Shared with the navigation-gate blocks below (docs/navigation/overview.md §4.18):
// ESLint flat config replaces a rule's whole value — including every
// selector — when two matching config objects both set 'no-restricted-syntax'
// for the same file (last one wins, arrays are never concatenated). The
// navigation gates below add their own admin/src-scoped 'no-restricted-syntax'
// blocks, so every block that can match an admin/src/**/*.ts file must repeat
// this pair rather than silently dropping it for that file.
const FORWARDED_HEADER_RESTRICTED_SYNTAX = [
  {
    selector: "Literal[value='x-forwarded-proto']",
    message:
      "Read request.protocol via resolvePublicOrigin (api/src/lib/public-origin.ts) — "
      + "raw 'x-forwarded-proto' bypasses Fastify's trusted-proxy scoping.",
  },
  {
    selector: "Literal[value='x-forwarded-host']",
    message:
      "Read request.hostname via resolvePublicOrigin (api/src/lib/public-origin.ts) — "
      + "raw 'x-forwarded-host' bypasses Fastify's trusted-proxy scoping.",
  },
]

// The egress block's syntax half, hoisted for the same reason as the pair
// above: the horizontal-scaling block at the bottom of this file also sets
// 'no-restricted-syntax' for api/src and worker/src, and flat config replaces
// a rule's whole value rather than merging it. Whichever block matches last
// owns every selector for those two trees, so both must carry these.
const EGRESS_RESTRICTED_SYNTAX = [
  {
    selector: "MemberExpression[object.name='globalThis'][property.name='fetch']",
    message:
      'globalThis.fetch bypasses the pinned egress boundary — use safeFetch/pinnedFetch (@nessie/runtime).',
  },
  {
    selector: "MemberExpression[object.name='window'][property.name='fetch']",
    message:
      'window.fetch bypasses the pinned egress boundary — use safeFetch/pinnedFetch (@nessie/runtime).',
  },
  {
    selector: "TSTypeQuery[exprName.name='fetch']",
    message:
      "'typeof fetch' makes the ambient fetch part of this module's contract — take a PinnedFetch/"
      + 'FetchLike type from the transport module instead (criteria in eslint.config.js).',
  },
]

// Horizontal-scaling invariant 1 (docs/standards/horizontal-scaling.md): no
// module-scope mutable state in the API or the worker. A second instance
// cannot see it, so anything written there is either lost work or an
// authority only one replica holds — the bootstrap token minted per process
// (audit 1.2), the per-replica rate-limit Map that makes the effective limit
// `max × N` (audit 1.3), and the cloud-browser CDP pool that strands a
// suspended run on the worker that opened it (audit 8.1) are all this shape.
//
// The selectors are deliberately narrow, because module-scope `new Set([...])`
// is far more often a frozen constant table (allowed MIME types, tool-name
// lists) than a store. A mutable store is created empty and filled at runtime,
// so only the zero-argument constructor is banned; `new Set([...])` and
// `new Map([[k, v]])` are constant tables and stay legal, and so is an empty
// one annotated `ReadonlySet`/`ReadonlyMap` (the type makes it unfillable
// through that binding — `NO_IDENTITY_TOOLS` in worker/src/run/delegated-
// identity.ts is the case that earned the exemption). `let` at module scope is
// banned outright: a memo, a cached client or a "did we already do this" flag
// is per process by definition.
//
// Known gap, stated so nobody reads a green lint as a proof: the selectors
// anchor on `Program`, so per-process state held in a closure inside a
// once-per-process factory is invisible to them. `bootstrapTokenState` in
// api/src/lib/server-context.ts (audit 1.2) and the `buckets` Map inside
// api/src/lib/rate-limit.ts (audit 1.3) were both exactly that shape and
// neither tripped this rule; both now live in Postgres. The one still standing
// is the TTL'd revoked-session `Map` inside createAuthSessionRevocationChecker
// (api/src/services/auth-session-registry.ts) — a bounded read-through cache
// that is deliberately never an authority. Widening to every function-scoped
// `let` would flag the whole tree; the standards file is the rule, this block
// is only the ratchet.
const MODULE_MUTABLE_STATE_MESSAGE =
  'Module-scope mutable state is per replica: a second instance cannot see it, and a restart loses it. '
  + 'Put the state in Postgres (a claimed row, a conditional UPDATE, rate_limit_buckets), or make it a '
  + 'read-through bounded cache with a TTL that is never an authority. '
  + 'See docs/standards/horizontal-scaling.md.'
const NOT_READONLY_COLLECTION =
  ':not([id.typeAnnotation.typeAnnotation.typeName.name=/^Readonly(Map|Set|WeakMap)$/])'
const NEW_EMPTY_COLLECTION =
  ' > NewExpression[callee.name=/^(Map|Set|WeakMap)$/][arguments.length=0]'
const MODULE_MUTABLE_STATE_SYNTAX = [
  {
    selector: 'Program > VariableDeclaration[kind="let"]',
    message: `Module-scope 'let' is per-process state. ${MODULE_MUTABLE_STATE_MESSAGE}`,
  },
  {
    selector: 'Program > ExportNamedDeclaration > VariableDeclaration[kind="let"]',
    message: `An exported module-scope 'let' is per-process state. ${MODULE_MUTABLE_STATE_MESSAGE}`,
  },
  {
    selector: 'Program > VariableDeclaration > '
      + `VariableDeclarator${NOT_READONLY_COLLECTION}${NEW_EMPTY_COLLECTION}`,
    message: `An empty module-scope Map/Set/WeakMap is a per-process store. ${MODULE_MUTABLE_STATE_MESSAGE}`,
  },
  {
    selector: 'Program > ExportNamedDeclaration > VariableDeclaration > '
      + `VariableDeclarator${NOT_READONLY_COLLECTION}${NEW_EMPTY_COLLECTION}`,
    message: `An exported empty Map/Set/WeakMap is a per-process store. ${MODULE_MUTABLE_STATE_MESSAGE}`,
  },
]

// Navigation stack containers are overflow: clip, never hidden — a
// scrollIntoView() run while a screen is `useLayoutEffect`-mounted off to the
// side (parked for a push) scrolls the clipped container itself, and the
// transform animation then runs on a stale offset (docs/navigation/overview.md §2, the
// "bounce"). `useEffect` (post-paint) is fine; only the layout-effect timing
// is the defect. Nested so a scrollIntoView() buried in a helper the effect
// calls is still caught.
const SCROLL_INTO_VIEW_IN_LAYOUT_EFFECT_SYNTAX = {
  selector: "CallExpression[callee.name='useLayoutEffect'] "
    + "CallExpression[callee.property.name='scrollIntoView']",
  message:
    "scrollIntoView() inside useLayoutEffect can run while the screen is parked "
    + "off-screen mid-push and scroll the clipped stack container itself — see "
    + 'docs/navigation/overview.md §2. Move the call to useEffect, or drop the layout timing.',
}

// React hook correctness gate (AGENTS.md → "Linting"): the plugin
// ships a `configs.flat['recommended-latest']` preset, but that preset also
// turns on the react-compiler diagnostics (set-state-in-effect,
// immutability, …) which are a separate, much larger conversation. Only the
// two hook-correctness rules are registered here, and both at 'error' —
// admin's lint script is `--max-warnings 0`, so 'warn' would fail the build
// anyway and would only hide the severity from a reader of this file.
// Rules set: 'react-hooks/*' only, so this block cannot clobber the
// admin-scoped 'no-restricted-syntax' gates below (see the note on
// FORWARDED_HEADER_RESTRICTED_SYNTAX above).
const REACT_HOOKS_RULES = {
  'react-hooks/rules-of-hooks': 'error',
  'react-hooks/exhaustive-deps': 'error',
}

export default [
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/node_modules/**',
      'macos/**',
      'remote/**',
    ],
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      'max-len': ['error', { code: 120, ignoreStrings: true, ignoreTemplateLiterals: true }],
    },
  },
  {
    // The navigation transition suite is plain ESM JavaScript (it drives
    // playwright-core directly, with no build step), so the TypeScript block
    // above does not reach it. Give it the same length and dead-code rules
    // the rest of the repo is held to — `pnpm --filter @nessie/admin lint`
    // covers `e2e` for exactly this reason.
    files: ['admin/e2e/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    rules: {
      'max-len': ['error', { code: 120, ignoreStrings: true, ignoreTemplateLiterals: true }],
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Public-origin admission rule (docs/plans/2026-08-13-security-boundary-hardening.md,
    // Workstream 5 / Phase 0 item 5): every server-minted absolute URL (OAuth
    // callback, dynamic client registration redirect) must derive its origin
    // via api/src/lib/public-origin.ts — the configured api.publicUrl, or
    // Fastify's trust-proxy-scoped request.protocol/request.hostname in local
    // mode only. Raw reads of 'x-forwarded-proto' / 'x-forwarded-host' are
    // forbidden outside that module and the trust-proxy plumbing
    // (api/src/lib/rate-limit.ts, api/src/index.ts); everything else must go
    // through resolvePublicOrigin.
    files: ['**/*.ts'],
    ignores: [
      'api/src/lib/public-origin.ts',
      'api/src/lib/rate-limit.ts',
      'api/src/index.ts',
    ],
    rules: {
      'no-restricted-syntax': ['error', ...FORWARDED_HEADER_RESTRICTED_SYNTAX],
    },
  },
  {
    // Viewport classification admission rule
    // (docs/plans/2026-08-13-responsive-coherence.md §B/§D, Phase 6): viewport
    // bands derive only from the useViewport store (the @theme static tokens in
    // styles.css are the sole numeric source), and shell-vs-viewport composition
    // lives in navigation/mobile-shell.ts + ShellEnvironmentProvider. Pages must never
    // re-classify the viewport from raw window reads. The allowlisted modules
    // below are either the classification owners themselves (useViewport,
    // mobile-shell), ThemeProvider's prefers-color-scheme listener, or
    // GEOMETRY-NOT-CLASSIFICATION admissions: modules that measure positions
    // (popover clamping, drag clamping, ARIA value ranges) rather than deciding
    // a device/layout class. Any new admission must argue geometry, not
    // classification, in a comment at the use site.
    files: ['admin/src/**/*.ts', 'admin/src/**/*.tsx'],
    ignores: [
      'admin/src/hooks/useViewport.ts',
      'admin/src/providers/ThemeProvider.tsx',
      'admin/src/navigation/mobile-shell.ts',
      'admin/src/layouts/admin-shell/ResizableSidebar.tsx',
      // The same drag geometry, lifted out of useReplyThread so the reply
      // panel and the agent-screen panel cannot disagree about clamping.
      'admin/src/hooks/useSidePanelGeometry.ts',
      // Popover/overlay placement geometry (D11): they clamp coordinates to the
      // window, they do not classify the device. The list shrinks as call sites
      // adopt the one placePopover helper (docs/navigation/overview.md §7) — the account,
      // team, create and reaction menus and the wikilink suggestion list
      // came off it that way in step 8; the wikilink create confirm and the
      // page-notes layer came off it with D11's clipping-ancestor placement
      // (admin/src/lib/popover-placement.ts + popover-placement-hook.ts).
      'admin/src/components/overlays/placePopover.ts',
      'admin/src/lib/popover-placement-hook.ts',
      'admin/src/layouts/admin-shell/GroupDmSidebarLabel.tsx',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          // A `patterns` group entry already matches `../hooks/useMediaQuery`
          // at every relative depth (F15) — the four depth-spelled `paths`
          // entries this used to carry were exact duplicates of it.
          patterns: [
            {
              group: ['**/hooks/useMediaQuery'],
              message:
                'useMediaQuery is retired (plan §B): use useViewport() bands or the semantic shell hooks in navigation/mobile-shell.ts.',
            },
          ],
        },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'window',
          property: 'innerWidth',
          message:
            'Viewport classification belongs to the useViewport store; popover/drag geometry needs an explicit allowlist admission (geometry-not-classification rule in eslint.config.js).',
        },
        {
          object: 'window',
          property: 'matchMedia',
          message:
            'Viewport classification belongs to the useViewport store; capability/preference queries are owned by useViewport or ThemeProvider.',
        },
      ],
    },
  },
  {
    // Navigation motion gate (docs/navigation/overview.md §11 "Gates", plan §4.18, step
    // 15): scrollIntoView() inside useLayoutEffect, everywhere in admin/src
    // except pages/** and layouts/** — those two trees get the more specific
    // block below (screen roots), which repeats this selector for the reason
    // explained on FORWARDED_HEADER_RESTRICTED_SYNTAX above. No allowlist:
    // nothing in admin/src does this today (admin/test/navigation-gates.test.ts
    // has the source-regex half of this pin for the CSS/JS side).
    files: ['admin/src/**/*.ts', 'admin/src/**/*.tsx'],
    ignores: ['admin/src/pages/**', 'admin/src/layouts/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...FORWARDED_HEADER_RESTRICTED_SYNTAX,
        SCROLL_INTO_VIEW_IN_LAYOUT_EFFECT_SYNTAX,
      ],
    },
  },
  {
    // Screen-root focus gate (docs/navigation/overview.md §11 "Gates", plan §4.18, step
    // 15): a screen root (admin/src/pages/**, admin/src/layouts/** — the shell
    // chrome and every page a route can land on) must not steal focus on
    // mount in a way that scrolls the clipped stack container (§2's bounce):
    // no bare `autoFocus` JSX attribute, and no `.focus()` call that omits
    // `{ preventScroll: true }`. Allowlist shrinks to empty as the parallel
    // conversion lands; a file leaves the list the moment its last real
    // offense converts.
    files: [
      'admin/src/pages/**/*.ts',
      'admin/src/pages/**/*.tsx',
      'admin/src/layouts/**/*.ts',
      'admin/src/layouts/**/*.tsx',
    ],
    ignores: [
      'admin/src/pages/SearchPage.tsx',
      'admin/src/pages/ChannelConversationComposePage.tsx',
      'admin/src/layouts/admin-shell/NativeSearchOverlay.tsx',
      'admin/src/layouts/admin-shell/TopBarSearch.tsx',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...FORWARDED_HEADER_RESTRICTED_SYNTAX,
        SCROLL_INTO_VIEW_IN_LAYOUT_EFFECT_SYNTAX,
        {
          selector: "JSXAttribute[name.name='autoFocus']",
          message:
            'autoFocus on a screen root steals focus on mount and can scroll the '
            + 'clipped stack container — see docs/navigation/overview.md §2/§11.',
        },
        {
          selector: "CallExpression[callee.property.name='focus'][arguments.length=0]",
          message:
            'A screen-root .focus() call needs { preventScroll: true } — a plain '
            + '.focus() can scroll the clipped stack container. See docs/navigation/overview.md §2/§11.',
        },
        {
          selector: "CallExpression[callee.property.name='focus'] > "
            + "ObjectExpression.arguments:not(:has(Property[key.name='preventScroll']))",
          message:
            'A screen-root .focus({...}) call needs preventScroll: true in its options '
            + '— see docs/navigation/overview.md §2/§11.',
        },
      ],
    },
  },
  {
    // navigate()/useNavigate() admission rule (docs/navigation/overview.md §11 "Gates",
    // plan §4.18) — OFF. The controller API this rule will hold call sites to
    // (PhoneNavigationProvider's `push`) does not exist yet; enabled in step
    // 13 once controller.push exists. Left declared, not deleted, so the
    // shape (files, ignores, the two selectors) is ready to flip to 'error'
    // in that step rather than being reinvented then.
    files: ['admin/src/**/*.ts', 'admin/src/**/*.tsx'],
    ignores: ['admin/src/navigation/**'],
    rules: {
      'no-restricted-syntax': [
        'off',
        {
          selector: "CallExpression[callee.name='navigate']",
          message:
            'navigate() belongs to admin/src/navigation/** — use the controller '
            + '(push/back/redirect) once it exists. See docs/navigation/overview.md §4.2.',
        },
        {
          selector: "ImportSpecifier[imported.name='useNavigate']",
          message:
            'useNavigate() belongs to admin/src/navigation/** — use the controller '
            + '(push/back/redirect) once it exists. See docs/navigation/overview.md §4.2.',
        },
      ],
    },
  },
  {
    // Error-shape reading ratchet (F4): one local `errorMessage` helper after
    // another hand-rolled `error instanceof Error ? error.message : fallback`,
    // throwing away the `ApiClientError.details` field errors a validation
    // failure carries. `facades/forms/form-errors.ts` exports `formErrorMessage` for
    // exactly this — import it instead of re-declaring the same helper.
    // Same files/ignores as the navigate() admission block above, so this
    // does not reintroduce FORWARDED_HEADER_RESTRICTED_SYNTAX or
    // SCROLL_INTO_VIEW_IN_LAYOUT_EFFECT_SYNTAX for files where the block
    // above already turns 'no-restricted-syntax' off — see the file-top
    // comment on FORWARDED_HEADER_RESTRICTED_SYNTAX for why that matters.
    files: ['admin/src/**/*.ts', 'admin/src/**/*.tsx'],
    ignores: ['admin/src/navigation/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "VariableDeclarator[id.name='errorMessage'] > ArrowFunctionExpression",
          message:
            "A local 'errorMessage' helper duplicates facades/forms/form-errors.ts — import "
            + 'formErrorMessage(error, fallback) instead of hand-rolling error.message reading.',
        },
      ],
    },
  },
  {
    // Egress fetch boundary gate (docs/plans/2026-08-13-security-boundary-hardening.md,
    // Workstream 3d): the *transport* boundary is the branded `SecureTransport`
    // built inside packages/runtime (safeFetch/pinnedFetch, redirect-policy.ts)
    // — per CB-06, this lint block is NOT the boundary; it is the ratchet that
    // keeps today's tree green so the boundary cannot be silently bypassed by a
    // new call site. It bans, across every production source tree:
    //   - `no-restricted-globals: fetch` — scope-analysed, so it catches calls
    //     AND passing the global as a value (`fetchImpl = fetch`, `fetchImpl: fetch`,
    //     `createConnector({ fetch })`), while shadowed parameters and object
    //     properties stay legal.
    //   - `globalThis.fetch` / `window.fetch` member expressions.
    //   - `typeof fetch` type queries (they make the ambient fetch part of a
    //     module's contract and invite the value to leak in through them).
    //   - `import ... from 'node:http' | 'node:https'` — the raw request
    //     modules; hosting a server never belongs in these trees (api serves
    //     via Fastify; only test fixtures do).
    // Test files are NOT allowlisted individually: they are excluded from the
    // rule entirely (test globs below — mocks and loopback fixtures there talk
    // to themselves, never to a caller-supplied address).
    //
    // Allowlist admission criteria — an entry must be one of:
    //   (a) the transport implementation itself (the pinned dispatcher), or
    //   (b) a fetch against a fixed, non-caller-influenced host
    //       (api.github.com, slack.com/api, a push provider, an inference
    //       vendor base URL, our own API), or
    //   (c) a dependency-injection seam whose production default is global
    //       fetch and whose migration to SecureTransport is Workstream 3's
    //       remaining call-site batch.
    // Everything else is a defect: migrate the caller onto safeFetch. Each
    // entry's justification is the inline comment beside it in the ignores
    // list below; the list documents today's reality and only shrinks from
    // here. An allowlisted file is exempt as a whole, so an entry that has
    // shrunk to zero real offenses must leave the list in the same change
    // that removes its last offense — otherwise it silently licenses new ones.
    files: [
      'api/src/**/*.ts',
      'worker/src/**/*.ts',
      'packages/*/src/**/*.ts',
      'executor/src/**/*.ts',
      'cli/src/**/*.ts',
      'gateway/src/**/*.ts',
    ],
    ignores: [
      '**/*.test.ts',
      '**/*.spec.ts',
      '**/test/**',
      '**/tests/**',
      '**/test-*.ts',
      '**/__fixtures__/**',
      '**/fixtures/**',
      // Allowlist — justification per entry (admission criteria in the block
      // comment above; parenthetical tags map to criteria (a)/(b)/(c)):
      'packages/runtime/src/url-safety.ts', // (a) the pinned dispatcher itself — its default fetchImpl IS the platform fetch it wraps and pins.
      'packages/push/src/webpush.ts', // (b)+(c) push-provider delivery default; endpoints are provider URLs, redirect already refused ('manual').
      'packages/push/src/fcm.ts', // (b)+(c) FCM send/token defaults; token_uri migration to the pinned seam is the remaining W3 batch.
      'packages/comms-providers/src/index.ts', // (b) wires global fetch into the Google connector, which dials only fixed Google endpoints.
      'packages/comms-slack/src/connector.ts', // (b) `deps.fetchImpl ?? fetch` — the client dials only https://slack.com/api/*.
      'packages/comms-slack/src/types.ts', // (c) `FetchLike = typeof fetch` DI-seam type for the Slack client.
      'packages/team-admin/src/ledger-agent-model-catalog.ts', // (b)+(c) catalog fetch default targets the fixed Ledger endpoint.
      'api/src/services/github.ts', // (b) fixed api.github.com host, path built from a validated owner/repo.
      'api/src/services/uoa-billing-client.ts', // (c) `fetchImpl?: PinnedFetch` type position; values are already pinned.
      'api/src/services/uoa-avatar.ts', // (c) `fetchImpl?: PinnedFetch` type position; the dial itself goes through safeFetch.
      'api/src/realtime/hub.ts', // (c) `import type { ServerResponse } from 'node:http'` — Fastify reply internals, not a request client.
      'executor/src/api-client.ts', // (b) executor daemon → our own configured API base URL only.
      'executor/src/egress-gateway.ts', // (a) the egress boundary itself: it HOSTS the allow/deny proxy with node:http.
      'executor/src/firecracker/api.ts', // (a) host-local Firecracker control over a fixed Unix socket; it cannot dial an IP endpoint.
      'cli/src/local.ts', // (b) localhost health polling against a dev server the CLI itself launched.
      'packages/mock-llm/src/server.ts', // (a) test-harness HTTP server (mock inference endpoint), never a client.
      'packages/runtime/src/web-search.ts', // (c) `fetchImpl?: typeof fetch` DI seam; the handler pins at dial.
      'packages/runtime/src/uoa-delegated-identity.ts', // (c) `fetchImpl?: typeof fetch` DI seam; production passes the pinned transport.
      'packages/runtime/src/ledger-identity.ts', // (c) `fetchImpl?: typeof fetch` DI seam; fixed Ledger host in production.
      'packages/runtime/src/deepsignal-mcp-identity.ts', // (c) `fetchImpl?: typeof fetch` DI seam awaiting the W3 migration batch.
      'packages/runtime/src/inference/connectors/openai.ts', // (b)+(c) vendor baseUrl; pinned-transport migration is W3's remaining batch.
      'packages/runtime/src/inference/connectors/codex.ts', // (b)+(c) vendor baseUrl; pinned-transport migration is W3's remaining batch.
      'packages/runtime/src/inference/connectors/kimi.ts', // (b)+(c) vendor baseUrl; pinned-transport migration is W3's remaining batch.
      'packages/client-core/src/pkce.ts', // (b) desktop/mobile shell → our own API's authorize-url endpoint.
      'packages/client-core/src/auth-session.ts', // (b) desktop/mobile shell session calls → our own configured API base URL.
      'packages/client-core/src/api-client.ts', // (b) desktop/mobile shell → our own configured API base URL.
      'packages/mcp-manage/src/mcp-security.ts', // (a) defines pinnedMcpFetch (`typeof fetch` shape wrapping safeFetch) — transport implementation.
      'packages/mcp-manage/src/mcp-oauth-secret-store.ts', // (c) `fetchImpl: typeof fetch` DI parameter types; callers pass the pinned fetch.
      'packages/mcp-manage/src/oauth-discovery.ts', // (c) `fetchImpl?: typeof fetch` DI seam; production passes pinnedMcpFetch.
      'packages/mcp-manage/src/discovery.ts', // (c) `fetchImpl?: typeof fetch` DI seam; production passes pinnedMcpFetch.
      'packages/mcp-manage/src/library.ts', // (c) `fetchImpl?: typeof fetch` DI seam; production passes the pinned registry fetch.
      'packages/mcp-manage/src/registry/registry-client.ts', // (a)+(c) defines pinnedRegistryFetch (`typeof fetch` shape wrapping safeFetch) plus its DI seam.
      'packages/mcp-manage/src/registry/repository-icons.ts', // (c) IconFetch DI seam (`fetch?: IconFetch`, param named `fetch`); the production default is safeRepositoryFetch.
      'worker/src/run/tool-dispatch.ts', // (c) `httpFetchImpl?: typeof fetch` type position; the dispatch path injects the pinned transport.
      'worker/src/run/tool-http.ts', // (c) `fetchImpl?: typeof fetch` DI seam; callers inject the pinned transport.
      'worker/src/run/builtin-handlers/http-fetch.ts', // (c) `fetchImpl?: typeof fetch` DI seam on the http_fetch handler; pinned at the seam.
      'worker/src/run/browser-cloud/download.ts', // (b) fetch inside a Runtime.evaluate string runs in the REMOTE browser against its own origin, not in this process.
      'packages/mcp-client/src/types.ts', // (c) `fetchImpl?: typeof globalThis.fetch` SDK-transport DI seam; the default is safeMcpFetch.
      'packages/mcp-client/src/transport/safe-fetch.ts', // (a) defines safeMcpFetch (`typeof globalThis.fetch` shape wrapping safeFetch) — transport implementation.
    ],
    rules: {
      'no-restricted-globals': [
        'error',
        {
          name: 'fetch',
          message:
            'Global fetch bypasses the pinned egress boundary (safeFetch/pinnedFetch in @nessie/runtime). '
            + 'Use the branded transport, or argue an allowlist admission (criteria in eslint.config.js).',
        },
      ],
      'no-restricted-syntax': [
        'error',
        ...FORWARDED_HEADER_RESTRICTED_SYNTAX,
        ...EGRESS_RESTRICTED_SYNTAX,
      ],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'node:http',
              message:
                "Raw node:http in production trees bypasses the egress boundary (and servers don't belong here — "
                + 'api serves via Fastify). Allowlisted entries are servers/gateways only; see eslint.config.js.',
            },
            {
              name: 'node:https',
              message:
                'Raw node:https requests bypass the pinned egress boundary — use safeFetch/pinnedFetch (@nessie/runtime).',
            },
          ],
        },
      ],
    },
  },
  {
    // Every React tree in the repo: admin's app and its node:test suite, plus
    // the shared sign-in surface. packages/client-core is deliberately absent —
    // it is framework-free (no hook, no JSX) and registering the plugin there
    // would claim a React dependency it does not have.
    files: [
      'admin/src/**/*.ts',
      'admin/src/**/*.tsx',
      'admin/test/**/*.ts',
      'admin/test/**/*.tsx',
      'packages/sign-in-surface/src/**/*.ts',
      'packages/sign-in-surface/src/**/*.tsx',
    ],
    plugins: {
      'react-hooks': reactHooksPlugin,
    },
    rules: REACT_HOOKS_RULES,
  },
  {
    // Horizontal-scaling ratchet (docs/standards/horizontal-scaling.md
    // invariant 1; docs/plans/2026-09-05-horizontal-scaling-statelessness/
    // overview.md Phase 0.2). Same shape as the egress block above: this lint
    // is NOT the boundary — Postgres is, and the standards file is the rule —
    // it is the ratchet that keeps today's tree from growing a new per-process
    // authority while Phases 1–5 remove the ones that exist.
    //
    // It repeats the forwarded-header and egress selectors because it is the
    // last block matching api/src and worker/src, and flat config would
    // otherwise drop them for those two trees (see the comment on
    // EGRESS_RESTRICTED_SYNTAX).
    //
    // Allowlist admission criteria — an entry must be one of:
    //   (a) an audited item with a numbered fix in the horizontal-scaling
    //       plan, named here with its finding number, or
    //   (b) process-local state that is genuinely correct per process: a
    //       resource whose lifetime IS this process (a pool, a listener, a
    //       socket), or a lazily-built immutable table that any replica would
    //       rebuild identically.
    // Nothing else is admissible. **The list only shrinks.** A file leaves it
    // in the change that removes its last offense; adding a file needs a
    // finding number or a (b) justification in the comment beside it.
    files: ['api/src/**/*.ts', 'worker/src/**/*.ts'],
    ignores: [
      '**/*.test.ts',
      '**/*.spec.ts',
      '**/test/**',
      '**/tests/**',
      '**/test-*.ts',
      '**/__fixtures__/**',
      '**/fixtures/**',
      // --- (a) audited defects, each with the finding that owns its fix ---
      'worker/src/run/external-conversation-store.ts', // 5.11 — per-process thread locks; covered by the run-slot advisory lock above them.
      'worker/src/run/execute/tool-registry.ts', // 5.12 — per-process memo of seeded builtin-tool organisations; waste only.
      'api/src/services/uoa-roster-subjects.ts', // 3.1 — 30 s roster-subject cache gating the avatar relay; documented trade-off.
      'api/src/services/knowledge-query-embedding.ts', // 4.4 — 15 min / 500-entry query-embedding cache; a cold replica recomputes.
      // --- (b) genuinely per process: a process-lifetime resource, or a
      //         lazily-built table any replica would rebuild identically ---
      'api/src/index.ts', // `sharedModelClient` — one ModelClient per process; its lifetime IS the process.
      'api/src/routes/auth-core.ts', // `cachedBrandIcon` — the brand PNG baked into the image, read once.
      'api/src/routes/agent-email-inbound.ts', // bounded read-through cache of Amazon's immutable SNS PEMs (audit: verified safe).
      'api/src/services/automatic-membership/signin.ts', // memoised `loadConfig()` rollout flag; config is immutable per process.
      'api/src/services/uoa-directory-cache.ts', // read-through LRU of UOA-verified directories; UOA stays the authority.
      'worker/src/control/knowledge-extract.ts', // `loggedSkips` — log-once dedupe; the worst N-instance outcome is N warnings.
      'worker/src/run/browser-cloud/release-hook.ts', // in-process wiring seam for the release chokepoint, set once at startup.
      'worker/src/run/browser-cloud/session-pool.ts', // 8.1 fixed in Phase 2.7 — now a read-through socket cache; the sealed capability on the session row is the authority, and a miss re-attaches from it.
      'worker/src/run/browser-cloud/tab-capture.ts', // single-flight guard for tab captures over THIS process's socket (the pool above); a replica has its own socket and its own guard, the rows in agent_browser_tabs are the authority, and a restart loses only a best-effort capture.
      'worker/src/run/pa-tools/agent-email-context.ts', // memoised mail deployment config/transport; derived from immutable config.
      'worker/src/run/pa-tools/dashboard-context.ts', // memoised dashboard tool services (the FileService chokepoint), one per process.
      'worker/src/run/pa-tools/people.ts', // short-TTL roster cache per (org, UOA org, UOA team); UOA stays the authority.
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...FORWARDED_HEADER_RESTRICTED_SYNTAX,
        ...EGRESS_RESTRICTED_SYNTAX,
        ...MODULE_MUTABLE_STATE_SYNTAX,
      ],
    },
  },
  {
    // The three worker DI seams the egress block allowlists for `typeof fetch`
    // sit inside the tree the block above re-imposes those selectors on, so
    // their egress exemption is restored here while the module-state ratchet
    // keeps applying to them. Keep this list identical to the worker entries
    // in the egress allowlist that carry a `typeof fetch`; if one of them ever
    // needs a module-state exemption too, it belongs on the list above
    // instead.
    files: [
      'worker/src/run/tool-dispatch.ts',
      'worker/src/run/tool-http.ts',
      'worker/src/run/builtin-handlers/http-fetch.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...FORWARDED_HEADER_RESTRICTED_SYNTAX,
        ...MODULE_MUTABLE_STATE_SYNTAX,
      ],
    },
  },
]
