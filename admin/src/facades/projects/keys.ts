// Project cache keys. The rules every keys.ts answers to — a family root
// that prefixes its members, and no key spelled as a literal at a call site —
// are documented in src/lib/query-keys.ts and enforced by
// test/query-key-invariants.test.ts.

export const projectKeys = {
  all: ['projects'] as const,
  // Nested so the family rule holds. The cost is that create/rename/delete
  // project and add/remove member, which already invalidate `projects`, now
  // also refetch a mounted board — one cheap `GET /api/projects/:id/boards`
  // read. The payload is the boards with their columns and carries no project
  // name, so this is about reachability, not about a rename showing through.
  boards: (projectId: string) => ['projects', projectId, 'boards'] as const,
  // Nested under the board so deleting a board reaches its watcher list too.
  boardWatchers: (projectId: string, boardId: string) =>
    ['projects', projectId, 'boards', boardId, 'watchers'] as const,
  // Nested for the same reason as `boards`: a definition change alters what
  // every card of the project renders.
  fields: (projectId: string) => ['projects', projectId, 'fields'] as const,
  // Nested for the same reason: attaching or removing a source changes what
  // the project's boards show.
  sources: (projectId: string) => ['projects', projectId, 'sources'] as const,
  // One attached source, with its mapping. Nested under the project's source
  // list so attaching or removing one reaches the detail too.
  source: (projectId: string, sourceId?: string) =>
    ['projects', projectId, 'sources', sourceId ?? 'none'] as const,
  // Deliberately NOT nested (see the header). Insights is a velocity/burndown
  // report built from one query per completed iteration plus a task-event scan,
  // and nothing that invalidates `projects` — rename, delete, membership, board
  // style — can change it. Nesting would re-run the report for no new data.
  insights: (projectId: string) => ['project-insights', projectId] as const,
  // Nested so the project mutations that already refresh `projects` reach the
  // membership list too.
  members: (projectId: string | null) => ['projects', projectId, 'members'] as const,
}
