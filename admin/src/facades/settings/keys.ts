// Scoped-setting cache keys. The rules every keys.ts answers to — a family
// root that prefixes its members, and no key spelled as a literal at a call
// site — are documented in src/lib/query-keys.ts and enforced by
// test/query-key-invariants.test.ts.

// A type-only import, erased at compile time — no runtime cycle with hooks.ts,
// which imports these keys back.
import type { SettingScope } from './hooks'

export const scopedSettingKeys = {
  all: ['scoped-settings'] as const,
  list: (scope: SettingScope, teamId: string | null, keys: readonly string[]) =>
    ['scoped-settings', scope, teamId ?? 'none', [...keys].sort().join(',')] as const,
}
