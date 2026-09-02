import tsPlugin from '@typescript-eslint/eslint-plugin'
import tsParser from '@typescript-eslint/parser'

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
    // lives in lib/mobile-shell.ts + ShellEnvironmentProvider. Pages must never
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
      'admin/src/lib/mobile-shell.ts',
      'admin/src/layouts/admin-shell/ResizableSidebar.tsx',
      'admin/src/pages/channels/useReplyThread.ts',
      // Popover/overlay placement geometry (D11): they clamp coordinates to the
      // window, they do not classify the device. The list shrinks as call sites
      // adopt the one placePopover helper (docs/navigation/overview.md §7) — the account,
      // workspace, create and reaction menus and the wikilink suggestion list
      // came off it that way in step 8.
      'admin/src/components/overlays/placePopover.ts',
      'admin/src/layouts/admin-shell/GroupDmSidebarLabel.tsx',
      'admin/src/components/features/knowledge/wikilink/WikilinkCreateConfirm.tsx',
      'admin/src/components/features/knowledge/notes/PageNotesLayer.tsx',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '../hooks/useMediaQuery',
              message:
                'useMediaQuery is retired (plan §B): use useViewport() bands or the semantic shell hooks in lib/mobile-shell.ts.',
            },
            {
              name: '../../hooks/useMediaQuery',
              message:
                'useMediaQuery is retired (plan §B): use useViewport() bands or the semantic shell hooks in lib/mobile-shell.ts.',
            },
            {
              name: '../../../hooks/useMediaQuery',
              message:
                'useMediaQuery is retired (plan §B): use useViewport() bands or the semantic shell hooks in lib/mobile-shell.ts.',
            },
            {
              name: '../../../../hooks/useMediaQuery',
              message:
                'useMediaQuery is retired (plan §B): use useViewport() bands or the semantic shell hooks in lib/mobile-shell.ts.',
            },
          ],
          patterns: [
            {
              group: ['**/hooks/useMediaQuery'],
              message:
                'useMediaQuery is retired (plan §B): use useViewport() bands or the semantic shell hooks in lib/mobile-shell.ts.',
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
]
