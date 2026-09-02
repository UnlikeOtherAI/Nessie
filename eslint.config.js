import tsPlugin from '@typescript-eslint/eslint-plugin'
import tsParser from '@typescript-eslint/parser'

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
      'no-restricted-syntax': [
        'error',
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
      ],
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
      // adopt the one placePopover helper (docs/navigation.md §7) — the account,
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
]
