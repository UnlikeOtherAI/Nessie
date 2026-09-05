import { useNavigate } from 'react-router-dom'
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
import { useIsOwner } from '../../shared/OwnerGate'
import {
  formatRelativeTime,
  getInstallationTone,
} from '../workflows/presentation'

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
          pushToast({ body: error.message, title: 'Could not start the run' }),
        onSuccess: () =>
          pushToast({ body: `${name} is running.`, title: 'Run started' }),
      },
    )
  }

  const togglePause = () => {
    const nextStatus = status === 'paused' ? 'active' : 'paused'
    updateInstallation.mutate(
      { installationId, status: nextStatus },
      {
        onError: (error) =>
          pushToast({ body: error.message, title: 'Could not update the automation' }),
        onSuccess: () =>
          pushToast({
            body: nextStatus === 'paused' ? `${name} is paused.` : `${name} is active again.`,
            title: nextStatus === 'paused' ? 'Automation paused' : 'Automation resumed',
          }),
      },
    )
  }

  return (
    <div className="admin-card flex items-center gap-3 p-3" data-testid="channel-automation-row">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold text-[var(--tx)]">{name}</span>
          <Pill tone={getInstallationTone(status)}>{status}</Pill>
        </div>
        <div className="mt-1 text-xs text-[color:var(--tx3)]">
          {lastRun
            ? `Last run ${lastRun.status} ${formatRelativeTime(lastRun.createdAt) ?? ''}`
            : 'Never run'}
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
          Run now
        </button>
        {canPause ? (
          <button
            className="rounded-md border border-[color:var(--sep)] px-3 py-1.5 text-xs font-semibold text-[color:var(--tx2)] disabled:opacity-50"
            data-testid="channel-automation-pause"
            disabled={updateInstallation.isPending}
            onClick={togglePause}
            type="button"
          >
            {status === 'paused' ? 'Resume' : 'Pause'}
          </button>
        ) : null}
        <button
          className="rounded-md px-2 py-1.5 text-xs font-semibold text-[color:var(--tx3)] hover:text-[var(--tx)]"
          onClick={() =>
            navigate(`/workflows?installation=${encodeURIComponent(installationId)}`)
          }
          type="button"
        >
          Open
        </button>
      </div>
      <span className="hidden" data-testid="channel-automation-channel">{channelId}</span>
    </div>
  )
}

export const ChannelAutomationsPanel = ({ channelId }: { channelId: string }) => {
  const { me } = useAuthSession()
  const isOwner = useIsOwner()
  const isWorkflowAdmin = isOwner || (me?.user.roleIds.includes('admin') ?? false)
  const { data: installations = [], isLoading } = useWorkflowInstallations(true, channelId)
  const { data: templates = [] } = useWorkflowTemplates()
  const templateNameById = new Map(templates.map((template) => [template.id, template.name]))

  if (isLoading) {
    return <div className="p-5 text-sm text-[color:var(--tx3)]">Loading automations…</div>
  }

  if (installations.length === 0) {
    return (
      <div className="p-5">
        <div className="rounded-xl border border-dashed border-[color:var(--sep)] bg-[var(--scrim-weak)] p-8 text-center">
          <div className="text-sm font-semibold text-[var(--tx)]">No automations on this channel</div>
          <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-[color:var(--tx3)]">
            Workflow installations bound to this channel show up here, with their last run and
            a run-now button for channel members.
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
          name={templateNameById.get(installation.workflowTemplateId) ?? 'Workflow'}
          status={installation.status}
          canPause={isWorkflowAdmin}
        />
      ))}
    </div>
  )
}
