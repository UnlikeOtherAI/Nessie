import { z } from 'zod'
import { useContinueRun } from '../../../facades/runs/hooks'
import { useToasts } from '../../../providers/ToastProvider'

/**
 * Continue affordance under a run's stop notice.
 *
 * The worker stamps the notice message with
 * `metadata.runStop = { runId, stopReason, checkpointId?, continuable }` when a
 * run stops at a policy ceiling with durable working state saved
 * (docs/plans/2026-08-05-run-budgets-context-and-research-routing.md §6). The
 * button is an affordance, not a requirement — replying in the thread resumes
 * the same checkpoint through the ordinary run path.
 */
const RunStopSchema = z.object({
  checkpointId: z.string().min(1).optional(),
  continuable: z.boolean(),
  runId: z.string().min(1),
  stopReason: z.string().min(1),
})

const readRunStop = (
  metadata: Record<string, unknown> | undefined,
): z.infer<typeof RunStopSchema> | null => {
  const parsed = RunStopSchema.safeParse(metadata?.runStop)
  if (!parsed.success) return null
  // Nothing to resume from without an unconsumed checkpoint id.
  if (!parsed.data.continuable || !parsed.data.checkpointId) return null
  return parsed.data
}

export const RunStopContinue = ({
  metadata,
}: {
  metadata: Record<string, unknown> | undefined
}) => {
  const runStop = readRunStop(metadata)
  const continueRun = useContinueRun()
  const { pushToast } = useToasts()

  if (!runStop) {
    return null
  }

  // Every refusal is authored by the API (already continued, agent busy,
  // handoff-managed); the toast repeats its message verbatim.
  const onContinue = () => {
    continueRun.mutate(runStop.runId, {
      onError: (error) => {
        pushToast({ body: error.message, title: 'Could not continue the run' })
      },
      onSuccess: () => {
        pushToast({ body: 'The agent picks up where it stopped.', title: 'Run continued' })
      },
    })
  }

  return (
    <div className="mt-2">
      <button
        className={[
          'inline-flex h-8 items-center justify-center rounded-md px-3',
          'text-xs font-semibold',
          'bg-[var(--accent)] text-[var(--on-accent)]',
          'disabled:cursor-not-allowed disabled:opacity-50',
        ].join(' ')}
        data-testid="run-stop-continue"
        disabled={continueRun.isPending}
        onClick={(event) => {
          event.stopPropagation()
          onContinue()
        }}
        type="button"
      >
        {continueRun.isPending ? 'Continuing…' : 'Continue'}
      </button>
    </div>
  )
}
