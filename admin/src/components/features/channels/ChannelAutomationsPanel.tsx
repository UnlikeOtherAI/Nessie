import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  useStartWorkflowRun,
  useUpdateWorkflowInstallation,
  useWorkflowInstallationRuns,
  useWorkflowInstallations,
  useWorkflowTemplates,
} from '../../../facades/workflows/hooks'
import { useAuthSession } from '../../../providers/AuthSessionProvider'
import { useToasts } from '../../../providers/ToastProvider'
import { Pill } from '../../primitives/Pill'
import { useIsOwner } from '../../../facades/auth/hooks'
import {
  getInstallationTone,
} from '../workflows/presentation'
import { formatRelativeTime } from '../../../i18n/formatters'

/**
 * W20 — the channel Automations tab: the doorway from the place a person is
 * standing when "what runs here?" comes up. Lists the installations bound to
 * this channel with last-run status, run-now, and pause. The W19 matrix is
 * enforced server-side; the buttons simply hide for roles the API would
 * refuse (run-now for entitled channel members, pause for org admin/owner).
 */

const InstallationAutomationRow = ({
  installationId,
  channelId,
  name,
  status,
  canPause,
}: {
  installationId: string
  channelId: string
  name: string
  status: 'active' | 'disabled' | 'draft' | 'paused'
  canPause: boolean
}) => {
  const { t, i18n } = useTranslation('channels')
  const navigate = useNavigate()
  const { pushToast } = useToasts()
  const startRun = useStartWorkflowRun()
  const updateInstallation = useUpdateWorkflowInstallation()
  const { data: runs = [] } = useWorkflowInstallationRuns(installationId)
  const lastRun = runs[0]

  const runNow = () => {
    startRun.mutate(
      { installationId },
      {
        onError: (error) =>
          pushToast({ body: error.message, title: t('child.automation.startFailed') }),
        onSuccess: () =>
          pushToast({ body: t('child.automation.startedBody', { name }), title: t('child.automation.startedTitle') }),
      },
    )
  }

  const togglePause = () => {
    const nextStatus = status === 'paused' ? 'active' : 'paused'
    updateInstallation.mutate(
      { installationId, status: nextStatus },
      {
        onError: (error) =>
          pushToast({ body: error.message, title: t('child.automation.updateFailed') }),
        onSuccess: () =>
          pushToast({
            body: t(nextStatus === 'paused' ? 'child.automation.pausedBody' : 'child.automation.resumedBody', { name }),
            title: t(nextStatus === 'paused' ? 'child.automation.pausedTitle' : 'child.automation.resumedTitle'),
          }),
      },
    )
  }

  return (
    <div className="admin-card flex items-center gap-3 p-3" data-testid="channel-automation-row">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold text-[var(--tx)]">{name}</span>
          <Pill tone={getInstallationTone(status)}>{t(`child.automation.status.${status}`)}</Pill>
        </div>
        <div className="mt-1 text-xs text-[color:var(--tx3)]">
          {lastRun
            ? t('child.automation.lastRun', {
              status: t(`child.automation.runStatus.${lastRun.status}`),
              time: formatRelativeTime(lastRun.createdAt, i18n.language),
            })
            : t('child.automation.neverRun')}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button
          className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-[var(--on-accent)] disabled:opacity-50"
          data-testid="channel-automation-run-now"
          disabled={startRun.isPending || status !== 'active'}
          onClick={runNow}
          type="button"
        >
          {t('child.automation.runNow')}
        </button>
        {canPause ? (
          <button
            className="rounded-md border border-[color:var(--sep)] px-3 py-1.5 text-xs font-semibold text-[color:var(--tx2)] disabled:opacity-50"
            data-testid="channel-automation-pause"
            disabled={updateInstallation.isPending}
            onClick={togglePause}
            type="button"
          >
            {t(status === 'paused' ? 'child.automation.resume' : 'child.automation.pause')}
          </button>
        ) : null}
        <button
          className="rounded-md px-2 py-1.5 text-xs font-semibold text-[color:var(--tx3)] hover:text-[var(--tx)]"
          onClick={() =>
            navigate(`/workflows?installation=${encodeURIComponent(installationId)}`)
          }
          type="button"
        >
          {t('child.automation.open')}
        </button>
      </div>
      <span className="hidden" data-testid="channel-automation-channel">{channelId}</span>
    </div>
  )
}

export const ChannelAutomationsPanel = ({ channelId }: { channelId: string }) => {
  const { t } = useTranslation('channels')
  const { me } = useAuthSession()
  const isOwner = useIsOwner()
  const isWorkflowAdmin = isOwner || (me?.user.roleIds.includes('admin') ?? false)
  const { data: installations = [], isLoading } = useWorkflowInstallations(true, channelId)
  const { data: templates = [] } = useWorkflowTemplates()
  const templateNameById = new Map(templates.map((template) => [template.id, template.name]))

  if (isLoading) {
    return <div className="p-5 text-sm text-[color:var(--tx3)]">{t('child.automation.loading')}</div>
  }

  if (installations.length === 0) {
    return (
      <div className="p-5">
        <div className="rounded-xl border border-dashed border-[color:var(--sep)] bg-[var(--scrim-weak)] p-8 text-center">
          <div className="text-sm font-semibold text-[var(--tx)]">{t('child.automation.emptyTitle')}</div>
          <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-[color:var(--tx3)]">
            {t('child.automation.emptyDescription')}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="grid gap-3 p-5" data-testid="channel-automations-panel">
      {installations.map((installation) => (
        <InstallationAutomationRow
          key={installation.id}
          installationId={installation.id}
          channelId={channelId}
          name={templateNameById.get(installation.workflowTemplateId) ?? t('child.automation.workflow')}
          status={installation.status}
          canPause={isWorkflowAdmin}
        />
      ))}
    </div>
  )
}
