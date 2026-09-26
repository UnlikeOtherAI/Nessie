import { z } from 'zod'
import { useTranslation } from 'react-i18next'
import { useRestartRun } from '../../../facades/runs/hooks'
import { useToasts } from '../../../providers/ToastProvider'

const RunRestartSchema = z.object({
  restartable: z.literal(true),
  runId: z.string().min(1),
})

export const readRunRestart = (
  metadata: Record<string, unknown> | undefined,
): z.infer<typeof RunRestartSchema> | null => {
  const parsed = RunRestartSchema.safeParse(metadata?.runRestart)
  return parsed.success ? parsed.data : null
}

/** The one recovery action for a failed local-device run, in its conversation. */
export const RunRestart = ({
  metadata,
}: {
  metadata: Record<string, unknown> | undefined
}) => {
  const { t } = useTranslation('channels')
  const runRestart = readRunRestart(metadata)
  const restartRun = useRestartRun()
  const { pushToast } = useToasts()

  if (!runRestart) return null

  return (
    <div className="mt-2">
      <button
        className={[
          'inline-flex h-8 items-center justify-center rounded-md px-3',
          'text-xs font-semibold',
          'bg-[var(--accent)] text-[var(--on-accent)]',
          'disabled:cursor-not-allowed disabled:opacity-50',
        ].join(' ')}
        data-testid="run-restart"
        disabled={restartRun.isPending}
        onClick={(event) => {
          event.stopPropagation()
          restartRun.mutate(runRestart.runId, {
            onError: (error) => {
              pushToast({ body: error.message, title: t('run.restartError') })
            },
            onSuccess: () => {
              pushToast({ body: t('run.restartedBody'), title: t('run.restartedTitle') })
            },
          })
        }}
        type="button"
      >
        {restartRun.isPending ? t('run.restarting') : t('run.restart')}
      </button>
    </div>
  )
}
