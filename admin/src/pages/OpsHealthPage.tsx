import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Pill, type PillTone } from '../components/primitives/Pill'
import { SectionLabel } from '../components/primitives/SectionLabel'
import { AdminPageHeader } from '../components/shared/AdminPageHeader'
import type { PageHeaderAction } from '../components/shared/ResponsivePageHeader'
import { opsHealthKeys } from '../lib/query-keys'
import { useApiClient } from '../providers/ApiClientProvider'
import { useAuthSession } from '../providers/AuthSessionProvider'

type WorkerHealthStatus = 'up' | 'stale' | 'down'

type OpsHealth = {
  worker: {
    status: WorkerHealthStatus
    activeRunners: number
    lastHeartbeatAt: string | null
    heartbeatAgeSeconds: number | null
  }
  queue: { pending: number; processing: number; done: number; dead: number }
  deadJobs: Array<{
    id: string
    topic: string
    attempt: number
    maxAttempts: number
    errorMessage: string | null
    enqueuedAt: string
  }>
  deadLetters: {
    count: number
    recent: Array<{ id: string; subject: string | null; attempts: number; createdAt: string }>
  }
}

const WORKER_TONE: Record<WorkerHealthStatus, PillTone> = {
  up: 'success',
  stale: 'warning',
  down: 'danger',
}

const Stat = ({ label, value, danger }: { label: string; value: number; danger?: boolean }) => (
  <div className="admin-card flex flex-col gap-1 p-3">
    <SectionLabel as="span">{label}</SectionLabel>
    <span
      className={[
        'text-2xl font-semibold',
        danger && value > 0 ? 'text-[color:var(--danger-text)]' : 'text-[color:var(--tx)]',
      ].join(' ')}
    >
      {value}
    </span>
  </div>
)

export const OpsHealthPage = () => {
  const { me } = useAuthSession()
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  // Instance administration: this page reads deployment-wide worker, queue and
  // dead-job state that has no tenant column, so it is gated on the named
  // instance-wide role rather than on being an owner of some organisation.
  const isSuperAdmin = me?.user.superAdmin ?? false

  const { data, isError, error } = useQuery<OpsHealth>({
    queryKey: opsHealthKeys.all,
    queryFn: () => apiClient.get('/api/ops/health'),
    enabled: isSuperAdmin,
    refetchInterval: 10_000,
  })

  const refresh = useMutation({
    mutationFn: async () => queryClient.invalidateQueries({ queryKey: opsHealthKeys.all }),
  })

  const worker = data?.worker
  const heartbeat = worker?.heartbeatAgeSeconds
  const headerActions: PageHeaderAction[] = [
    {
      disabled: refresh.isPending,
      id: 'refresh',
      label: 'Refresh',
      onSelect: () => refresh.mutate(),
      primary: true,
      priority: 100,
    },
  ]

  if (!isSuperAdmin) {
    return (
      <section className="flex h-full items-center justify-center text-[color:var(--tx3)]">
        Instance super-admin access required
      </section>
    )
  }

  return (
    <section className="flex h-full min-h-0 flex-col">
      <AdminPageHeader actions={headerActions} title="System Health" />

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <p className="mb-4 text-xs text-[color:var(--tx3)]">
          Worker and queue metrics are deployment-wide infrastructure; dead-letter
          messages are scoped to your organization.
        </p>
        {isError && (
          <div className="admin-card mb-4 p-4 text-sm text-[color:var(--danger-text)]">
            {(error as Error)?.message ?? 'Failed to load system health'}
          </div>
        )}

        <SectionLabel>Worker</SectionLabel>
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
          <div className="admin-card flex flex-col gap-1 p-3">
            <SectionLabel as="span">Status</SectionLabel>
            <Pill className="w-fit" tone={worker ? WORKER_TONE[worker.status] : 'muted'}>
              {worker?.status ?? '—'}
            </Pill>
          </div>
          <Stat label="Active runners" value={worker?.activeRunners ?? 0} />
          <div className="admin-card flex flex-col gap-1 p-3">
            <SectionLabel as="span">Last heartbeat</SectionLabel>
            <span className="text-2xl font-semibold text-[color:var(--tx)]">
              {heartbeat == null ? '—' : `${heartbeat}s`}
            </span>
          </div>
        </div>

        <SectionLabel className="mt-5">Queue</SectionLabel>
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Pending" value={data?.queue.pending ?? 0} />
          <Stat label="Processing" value={data?.queue.processing ?? 0} />
          <Stat label="Done" value={data?.queue.done ?? 0} />
          <Stat label="Dead" value={data?.queue.dead ?? 0} danger />
        </div>

        <SectionLabel className="mt-5">
          Dead-letter jobs ({data?.deadJobs.length ?? 0})
        </SectionLabel>
        <div className="mt-2 grid gap-2">
          {(data?.deadJobs ?? []).map((job) => (
            <div key={job.id} className="admin-card p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-sm font-semibold text-[color:var(--tx)]">{job.topic}</span>
                <span className="text-xs text-[color:var(--tx3)]">
                  attempt {job.attempt}/{job.maxAttempts} · {new Date(job.enqueuedAt).toLocaleString()}
                </span>
              </div>
              {job.errorMessage && (
                <pre className="mt-2 max-h-28 overflow-auto rounded bg-[color:var(--scrim)] p-2 text-[11px] text-[color:var(--tx2)]">
                  {job.errorMessage}
                </pre>
              )}
            </div>
          ))}
          {data && data.deadJobs.length === 0 && (
            <div className="py-6 text-center text-[color:var(--tx3)]">No dead-letter jobs</div>
          )}
        </div>

        <SectionLabel className="mt-5">
          Dead-letter messages ({data?.deadLetters.count ?? 0})
        </SectionLabel>
        <div className="mt-2 grid gap-2">
          {(data?.deadLetters.recent ?? []).map((message) => (
            <div key={message.id} className="admin-card flex items-center justify-between p-3">
              <span className="text-sm text-[color:var(--tx)]">{message.subject ?? '(no subject)'}</span>
              <span className="text-xs text-[color:var(--tx3)]">
                {message.attempts} attempts · {new Date(message.createdAt).toLocaleString()}
              </span>
            </div>
          ))}
          {data && data.deadLetters.recent.length === 0 && (
            <div className="py-6 text-center text-[color:var(--tx3)]">No dead-letter messages</div>
          )}
        </div>
      </div>
    </section>
  )
}
