// Connected-mail cache keys. The rules every keys.ts answers to — a family
// root that prefixes its members, and no key spelled as a literal at a call
// site — are documented in src/lib/query-keys.ts and enforced by
// test/query-key-invariants.test.ts.

// A type-only import, erased at compile time — no runtime cycle with hooks.ts,
// which imports these keys back.
import type { MailAddress } from './hooks'

export const connectedMailKeys = {
  all: ['connected-mail'] as const,
  accounts: () => ['connected-mail', 'accounts'] as const,
  conversation: ({ accountId, source }: MailAddress, threadId: string | undefined) =>
    ['connected-mail', 'conversation', source, accountId, threadId] as const,
  sendAction: (address: MailAddress | null, actionId: string | undefined) =>
    ['connected-mail', 'send-action', address?.source, address?.accountId, actionId] as const,
  threads: (
    { accountId, source }: MailAddress,
    input: { cursor?: string; pageSize: number; query: string; unreadOnly: boolean },
  ) => ['connected-mail', 'threads', source, accountId, input] as const,
}
