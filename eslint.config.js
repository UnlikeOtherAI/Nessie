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
    files: [
      'src/**/*.ts',
      'api/src/**/*.ts',
      'admin/src/**/*.{ts,tsx}',
      'web/src/**/*.{ts,tsx}',
      'worker/src/**/*.ts',
      'cli/src/**/*.ts',
      'packages/*/src/**/*.ts',
    ],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      'no-unused-vars': 'off',
      'no-restricted-imports': [
        'error',
        {
          patterns: ['src/*', '../src/*', '../../src/*', '../../../src/*', '../../../../src/*'],
        },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'max-len': ['error', { code: 120 }],
    },
  },
]
