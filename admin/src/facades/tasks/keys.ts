// Task cache keys. The rules every keys.ts answers to — a family root
// that prefixes its members, and no key spelled as a literal at a call site —
// are documented in src/lib/query-keys.ts and enforced by
// test/query-key-invariants.test.ts.

export const taskKeys = {
  all: ['tasks'] as const,
  // Deliberately NOT nested (see the header). `optimisticPatch` in the tasks
  // facade sweeps every cache entry under `['tasks']` as `TaskRecord[]` and
  // writes a patched array back; the assignee list is `AssignableUser[]`, so
  // nesting it would hand that sweep a foreign shape and cancel its fetch on
  // every drag.
  assignees: ['task-assignees'] as const,
  documents: (taskId?: string) => ['task-pages', taskId ?? 'none'] as const,
  // Aggregate and per-project boards share the family root, so one invalidate
  // or optimistic write reaches every board at once.
  forProject: (projectId?: string) => ['tasks', projectId ?? 'all'] as const,
  // One board's placed task list. Nested under the project's own key so a
  // move, an archive or a realtime nudge reaches every board of that project
  // with one invalidate, rather than needing the board ids to hand.
  forBoard: (projectId?: string, boardId?: string) =>
    ['tasks', projectId ?? 'all', 'board', boardId ?? 'none'] as const,
}
