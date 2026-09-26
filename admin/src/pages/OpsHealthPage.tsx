import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Pill, type PillTone } from '../components/primitives/Pill'
import { SectionLabel } from '../components/primitives/SectionLabel'
import { QueryState } from '../components/shared/QueryState'
import { ScreenHeader } from '../components/shared/ScreenHeader'
import type { PageHeaderAction } from '../components/shared/ResponsivePageHeader'
import { SuperAdminGate, useIsSuperAdmin } from '../components/shared/SuperAdminGate'
import { StatGrid, StatTile } from '../components/shared/StatTile'
import { opsHealthKeys } from '../lib/query-keys'
import { useApiClient } from '../providers/ApiClientProvider'

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
  // Optional on purpose. A blue-green swap serves both builds at once, so a
  // page loaded against a new replica can be refetched from an old one that
  // has never heard of this block; reading it unguarded would blank the screen
  // for the minutes the swap takes.
  rateLimit?: {
    deploymentWide: {
      available: boolean
      buckets: Array<{
        bucket: string
        limit: number
        windowMs: number
        identities: number
        hits: number
        maxCount: number
        limitedIdentities: number
        windowStartedAt: string
      }>
    }
    thisInstance: {
      bootedAt: string
      checks: number
      limited: number
      storeErrors: number
      limitedByBucket: Record<string, number>
    }
  }
}

const WORKER_TONE: Record<WorkerHealthStatus, PillTone> = {
  up: 'success',
  stale: 'warning',
  down: 'danger',
}

export const OpsHealthPage = () => {
  const { t, i18n } = useTranslation('operations')
  const locale = i18n.resolvedLanguage ?? 'en-GB'
  const formatDate = (value: string) => new Date(value).toLocaleString(locale)
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  // Instance administration: this page reads deployment-wide worker, queue and
  // dead-job state that has no tenant column, so it is gated on the named
  // instance-wide role rather than on being an owner of some organisation.
  const isSuperAdmin = useIsSuperAdmin()

  const query = useQuery<OpsHealth>({
    queryKey: opsHealthKeys.all,
    queryFn: () => apiClient.get('/api/ops/health'),
    enabled: isSuperAdmin,
    refetchInterval: 10_000,
  })
  const { data } = query

  const refresh = useMutation({
    mutationFn: async () => queryClient.invalidateQueries({ queryKey: opsHealthKeys.all }),
  })

  const worker = data?.worker
  const heartbeat = worker?.heartbeatAgeSeconds
  const headerActions: PageHeaderAction[] = [
    {
      disabled: refresh.isPending,
      id: 'refresh',
      label: t('health.refresh'),
      onSelect: () => refresh.mutate(),
      priority: 100,
    },
  ]

  return (
    <section className="flex h-full min-h-0 flex-col">
      {/* The header is always rendered: a refusal is a state of this screen,
          not a screen of its own, so Back never disappears with it
          (docs/navigation/deep-links-and-headers.md §9). */}
      <ScreenHeader actions={headerActions} title={t('health.title')} />
      <SuperAdminGate>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <p className="mb-4 text-xs text-[color:var(--tx3)]">
            {t('health.description')}
          </p>

          <QueryState
            errorLabel={t('health.loadFailed')}
            loadingLabel={t('health.loading')}
            query={query}
          >
            {() => (
              <>
                <SectionLabel>{t('health.worker')}</SectionLabel>
                <StatGrid className="mt-2 sm:grid-cols-3">
                  <StatTile
                    label={t('health.status')}
                    value={
                      <Pill className="w-fit" tone={worker ? WORKER_TONE[worker.status] : 'muted'}>
                        {worker?.status ? t(`health.workerStatus.${worker.status}`) : '—'}
                      </Pill>
                    }
                  />
                  <StatTile label={t('health.activeRunners')} value={worker?.activeRunners ?? 0} />
                  <StatTile label={t('health.lastHeartbeat')} value={heartbeat == null ? '—' : t('health.seconds', { count: heartbeat })} />
                </StatGrid>

                <SectionLabel className="mt-5">{t('health.queue')}</SectionLabel>
                <StatGrid className="mt-2 sm:grid-cols-4">
                  <StatTile label={t('health.pending')} value={data?.queue.pending ?? 0} />
                  <StatTile label={t('health.processing')} value={data?.queue.processing ?? 0} />
                  <StatTile label={t('health.done')} value={data?.queue.done ?? 0} />
                  <StatTile
                    label={t('health.dead')}
                    tone={(data?.queue.dead ?? 0) > 0 ? 'danger' : 'default'}
                    value={data?.queue.dead ?? 0}
                  />
                </StatGrid>

                <SectionLabel className="mt-5">
                  {t('health.deadJobs', { count: data?.deadJobs.length ?? 0 })}
                </SectionLabel>
                <div className="mt-2 grid gap-2">
                  {(data?.deadJobs ?? []).map((job) => (
                    <div key={job.id} className="admin-card p-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-sm font-semibold text-[color:var(--tx)]">{job.topic}</span>
                        <span className="text-xs text-[color:var(--tx3)]">
                          {t('health.attempt', { attempt: job.attempt, max: job.maxAttempts })} · {formatDate(job.enqueuedAt)}
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
                    <div className="py-6 text-center text-[color:var(--tx3)]">{t('health.noDeadJobs')}</div>
                  )}
                </div>

                <SectionLabel className="mt-5">
                  {t('health.deadMessages', { count: data?.deadLetters.count ?? 0 })}
                </SectionLabel>
                <div className="mt-2 grid gap-2">
                  {(data?.deadLetters.recent ?? []).map((message) => (
                    <div key={message.id} className="admin-card flex items-center justify-between p-3">
                      <span className="text-sm text-[color:var(--tx)]">{message.subject ?? t('health.noSubject')}</span>
                      <span className="text-xs text-[color:var(--tx3)]">
                        {t('health.attempts', { count: message.attempts })} · {formatDate(message.createdAt)}
                      </span>
                    </div>
                  ))}
                  {data && data.deadLetters.recent.length === 0 && (
                    <div className="py-6 text-center text-[color:var(--tx3)]">{t('health.noDeadMessages')}</div>
                  )}
                </div>

                {/* Two limiter blocks, never merged into one grid: the first is
                    read from the shared counter rows and is true for every
                    replica, the second is this API process's own tally. A
                    reader who cannot tell them apart reads a fleet number as
                    one instance's share of it, or the reverse. */}
                <SectionLabel className="mt-5">{t('health.rateLimitDeployment')}</SectionLabel>
                <p className="mt-1 text-xs text-[color:var(--tx3)]">
                  {t('health.rateLimitDeploymentDescription')}
                </p>
                {data?.rateLimit && !data.rateLimit.deploymentWide.available && (
                  <div className="admin-card mt-2 p-3 text-sm text-[color:var(--tx2)]">
                    {t('health.rateLimitUnavailable')}
                  </div>
                )}
                {data?.rateLimit?.deploymentWide.available && (
                  <div className="mt-2 grid gap-2">
                    {data.rateLimit.deploymentWide.buckets.map((entry) => (
                      <div key={entry.bucket} className="admin-card flex items-center justify-between gap-2 p-3">
                        <span className="font-mono text-sm text-[color:var(--tx)]">{entry.bucket}</span>
                        <span className="flex items-center gap-2 text-xs text-[color:var(--tx3)]">
                          {t('health.limiterWindow', { identities: entry.identities,
                            busiest: entry.maxCount, limit: entry.limit })}
                          {entry.limitedIdentities > 0 && (
                            <Pill tone="danger">{t('health.lockedOut', { count: entry.limitedIdentities })}</Pill>
                          )}
                        </span>
                      </div>
                    ))}
                    {data.rateLimit.deploymentWide.buckets.length === 0 && (
                      <div className="py-6 text-center text-[color:var(--tx3)]">
                        {t('health.noLimiter')}
                      </div>
                    )}
                  </div>
                )}

                <SectionLabel className="mt-5">{t('health.rateLimitInstance')}</SectionLabel>
                <p className="mt-1 text-xs text-[color:var(--tx3)]">
                  {t('health.rateLimitInstanceDescription')}
                </p>
                <StatGrid className="mt-2 sm:grid-cols-3">
                  <StatTile label={t('health.checks')} value={data?.rateLimit?.thisInstance.checks ?? 0} />
                  <StatTile label={t('health.limited')} value={data?.rateLimit?.thisInstance.limited ?? 0} />
                  <StatTile
                    label={t('health.storeErrors')}
                    tone={(data?.rateLimit?.thisInstance.storeErrors ?? 0) > 0 ? 'danger' : 'default'}
                    value={data?.rateLimit?.thisInstance.storeErrors ?? 0}
                  />
                </StatGrid>
              </>
            )}
          </QueryState>
        </div>
      </SuperAdminGate>
    </section>
  )
}
