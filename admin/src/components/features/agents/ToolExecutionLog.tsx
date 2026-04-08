import type { ToolCallEntry } from '@nessie/schemas'
import { EmptyState } from '../../shared/EmptyState'
import { StatusPill } from '../../primitives/StatusPill'

type ToolExecutionLogProps = {
  entries: ToolCallEntry[]
}

const getTone = (success: boolean | undefined) => {
  if (success === true) {
    return 'success'
  }

  if (success === false) {
    return 'danger'
  }

  return 'warning'
}

export const ToolExecutionLog = ({ entries }: ToolExecutionLogProps) => (
  <section className="grid gap-3">
    <div className="text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--muted)]">
      Tool execution log
    </div>
    {entries.length === 0 ? (
      <EmptyState>No tool calls recorded for this agent yet.</EmptyState>
    ) : (
      entries.map((entry) => (
        <article
          key={`${entry.runId}:${entry.toolName}:${entry.startedAt}`}
          className="rounded-[1.35rem] border border-[color:var(--line)] bg-white/75 p-4"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="font-mono text-sm">{entry.toolName}</div>
            <StatusPill tone={getTone(entry.success)}>
              {entry.success === undefined ? 'running' : entry.success ? 'success' : 'failed'}
            </StatusPill>
          </div>
          <div className="mt-2 text-xs uppercase tracking-[0.16em] text-[color:var(--muted)]">
            {entry.durationMs ? `${entry.durationMs} ms` : 'active'}
          </div>
          <div className="mt-3 text-sm leading-6 text-[color:var(--muted)]">
            {entry.outputPreview ?? entry.inputSummary}
          </div>
        </article>
      ))
    )}
  </section>
)
