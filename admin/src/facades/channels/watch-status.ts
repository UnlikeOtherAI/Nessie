/**
 * The rolling status a recurring watch keeps on one message.
 *
 * The worker writes this alongside the model's own status text
 * (`worker/src/run/execute/watch-status.ts`); the feed renders the counter from
 * here rather than asking the model to write "ran 54 times" into its prose,
 * which it would get wrong and which would change on every edit.
 */
export type WatchStatusSummary = {
  lastRunAt: string
  runCount: number
}

export const readWatchStatusSummary = (
  metadata: unknown,
): WatchStatusSummary | null => {
  if (typeof metadata !== 'object' || metadata === null) return null
  const raw = (metadata as Record<string, unknown>)['watchStatus']
  if (typeof raw !== 'object' || raw === null) return null
  const value = raw as Record<string, unknown>
  const runCount = value['runCount']
  const lastRunAt = value['lastRunAt']
  if (typeof runCount !== 'number' || typeof lastRunAt !== 'string') return null
  return { lastRunAt, runCount }
}
