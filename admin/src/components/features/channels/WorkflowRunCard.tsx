import { useNavigate } from 'react-router-dom'
import { z } from 'zod'

import { useRetryWorkflowRun } from '../../../facades/workflows/hooks'
import { useToasts } from '../../../providers/ToastProvider'

/**
 * W21 — the workflow run card. The worker stamps a start/finish/fail notice
 * message with
 * `metadata.workflowRun = { workflowRunId, installationId, status }` — the
 * same pattern as budget-stop notices (`metadata.runStop`). The failed card
 * offers Retry (a full re-run, which exists today) and a link to the run —
 * never Resume, which is Stage 2's partial-resume API and does not exist yet.
 */

const WorkflowRunCardSchema = z.object({
  installationId: z.string().uuid(),
  status: z.enum(['completed', 'failed']),
  workflowRunId: z.string().uuid(),
})

const readWorkflowRunCard = (
  metadata: Record<string, unknown> | undefined,
): z.infer<typeof WorkflowRunCardSchema> | null => {
  const parsed = WorkflowRunCardSchema.safeParse(metadata?.workflowRun)
  return parsed.success ? parsed.data : null
}

export const WorkflowRunCard = ({
  metadata,
}: {
  metadata: Record<string, unknown> | undefined
}) => {
  const card = readWorkflowRunCard(metadata)
  const navigate = useNavigate()
  const retryRun = useRetryWorkflowRun()
  const { pushToast } = useToasts()

  if (!card) {
    return null
  }

  const openRun = (event: { stopPropagation: () => void }) => {
    event.stopPropagation()
    const params = new URLSearchParams({
      installation: card.installationId,
      run: card.workflowRunId,
    })
    navigate(`/workflows?${params.toString()}`)
  }

  return (
    <div className="mt-2 flex items-center gap-2" data-testid="workflow-run-card">
      {card.status === 'failed' ? (
        <button
          className={[
            'inline-flex h-8 items-center justify-center rounded-md px-3',
            'text-xs font-semibold',
            'bg-[var(--accent)] text-[var(--on-accent)]',
            'disabled:cursor-not-allowed disabled:opacity-50',
          ].join(' ')}
          data-testid="workflow-run-retry"
          disabled={retryRun.isPending}
          onClick={(event) => {
            event.stopPropagation()
            retryRun.mutate(
              { workflowRunId: card.workflowRunId },
              {
                onError: (error) =>
                  pushToast({ body: error.message, title: 'Could not retry the run' }),
                onSuccess: () =>
                  pushToast({ body: 'The workflow starts over from the top.', title: 'Run retried' }),
              },
            )
          }}
          type="button"
        >
          {retryRun.isPending ? 'Retrying…' : 'Retry'}
        </button>
      ) : null}
      <button
        className="inline-flex h-8 items-center justify-center rounded-md border border-[color:var(--sep)] px-3 text-xs font-semibold text-[color:var(--tx2)]"
        data-testid="workflow-run-open"
        onClick={openRun}
        type="button"
      >
        View run
      </button>
    </div>
  )
}
