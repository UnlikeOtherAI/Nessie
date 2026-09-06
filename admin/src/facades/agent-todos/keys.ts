// Agent to-do cache keys. The rules every keys.ts answers to — a family root
// that prefixes its members, and no key spelled as a literal at a call site —
// are documented in src/lib/query-keys.ts and enforced by
// test/query-key-invariants.test.ts.

import { agentKeys } from '../agents/keys'

// To-dos are an agent sub-resource. Keeping them beneath the agents root means
// an agent update still refreshes every mounted per-agent view, while the
// to-do facade can invalidate the precise collection after a checklist write.
export const agentTodoKeys = {
  all: agentKeys.all,
  card: (todoId?: string) => ['agents', 'todos', todoId] as const,
  instances: (agentId?: string) => ['agents', agentId, 'todos'] as const,
  templates: (agentId?: string, includeArchived = false) =>
    ['agents', agentId, 'todo-templates', includeArchived] as const,
}
