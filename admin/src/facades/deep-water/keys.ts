// DeepWater research cache keys. The rules every keys.ts answers to — a family
// root that prefixes its members, and no key spelled as a literal at a call
// site — are documented in src/lib/query-keys.ts and enforced by
// test/query-key-invariants.test.ts.

/**
 * Every research read is viewer-scoped on the server: the same run id answers
 * one person with a brief, another with a 404. So the viewer's organisation,
 * team and user are part of cache identity, as they are for the integration
 * reads, and a run's keys start with its id so one realtime event
 * (`integration.run.updated`) can invalidate that run for every scope at once.
 */
export type DeepWaterViewerScope = {
  organizationId: string
  teamId: string
  userId: string
}

const scopeParts = (scope: DeepWaterViewerScope) =>
  [scope.organizationId, scope.teamId, scope.userId] as const

const root = ['deep-water-research'] as const

export const deepWaterKeys = {
  all: root,
  /** Every page of every viewer's Knowledge › Research list. */
  lists: [...root, 'list'] as const,
  list: (scope: DeepWaterViewerScope) => [...root, 'list', ...scopeParts(scope)] as const,
  /** Everything read about one run: its view, its brief and its stored report. */
  run: (runId: string) => [...root, 'run', runId] as const,
  view: (runId: string, scope: DeepWaterViewerScope) =>
    [...root, 'run', runId, 'view', ...scopeParts(scope)] as const,
  brief: (runId: string, scope: DeepWaterViewerScope) =>
    [...root, 'run', runId, 'brief', ...scopeParts(scope)] as const,
}
