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
]
