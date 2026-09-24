// Standing machine access cache keys (the rules are in src/lib/query-keys.ts).

export const standingPolicyKeys = {
  all: ['standing-policies'] as const,
  trigger: (triggerId?: string) => ['standing-policies', 'trigger', triggerId] as const,
  machines: (triggerId?: string) => ['standing-policies', 'trigger', triggerId, 'machines'] as const,
  executor: (executorId?: string) => ['standing-policies', 'executor', executorId] as const,
}
