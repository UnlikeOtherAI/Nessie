import { faTrash } from '@fortawesome/free-solid-svg-icons'
import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { TriggerDetail } from '../components/features/triggers/TriggerDetail'
import { TriggerEditorDialog } from '../components/features/triggers/TriggerEditorDialog'
import { useTriggerRegistry } from '../components/features/triggers/useTriggersPageState'
import {
  getTriggerHealthMessage,
  getTriggerTone,
  getTriggerTypeLabel,
} from '../components/features/triggers/trigger-presentation'
import { ConfirmDialog } from '../components/shared/ConfirmDialog'
import { OwnerGate } from '../components/shared/OwnerGate'
import { QueryState } from '../components/shared/QueryState'
import { ScreenHeader } from '../components/shared/ScreenHeader'
import type { PageHeaderAction } from '../components/shared/ResponsivePageHeader'
import { Notice } from '../components/primitives/Notice'
import { Pill } from '../components/primitives/Pill'
import { useIsOwner } from '../facades/auth/hooks'
import {
  useDeleteTrigger,
  useFireTrigger,
  usePauseTrigger,
  useReauthorizeTrigger,
  useResumeTrigger,
  useTriggers,
} from '../facades/triggers/hooks'

/**
 * One trigger: what it is, what it has delivered, and everything a person can
 * do to it.
 *
 * Reached by opening a row in the Triggers table. The controls live in the
 * screen's one header rather than in a second action row inside the body —
 * "Run now" is the primary, and Delete sits in the overflow so it cannot be
 * hit on the way to it.
 */
export const TriggerDetailPage = () => {
  const navigate = useNavigate()
  const { triggerId } = useParams<{ triggerId?: string }>()
  const isOwner = useIsOwner()
  const triggersQuery = useTriggers(isOwner)
  const trigger = (triggersQuery.data ?? []).find((candidate) => candidate.id === triggerId)
  const { agents, channels, registry, workflowInstallations, workflowTemplates } =
    useTriggerRegistry()

  const pauseTrigger = usePauseTrigger()
  const resumeTrigger = useResumeTrigger()
  const reauthorizeTrigger = useReauthorizeTrigger()
  const fireTrigger = useFireTrigger()
  const deleteTrigger = useDeleteTrigger()
  const [editorOpen, setEditorOpen] = useState(false)
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  // Reset transient state when the screen swaps to another trigger.
  useEffect(() => {
    setConfirmDeleteOpen(false)
    setActionError(null)
  }, [triggerId])

  const backToList = () => void navigate('/agents/triggers')

  if (!trigger) {
    // The header is rendered here too: loading, failure and not-found are
    // states of this screen, and a phone with no header has no Back at all.
    return (
      <div className="flex h-full min-h-0 flex-col">
        <ScreenHeader backLabel="Back to Triggers" onBack={backToList} title="Trigger" />
        <OwnerGate>
          <QueryState
            className="flex flex-1 items-center justify-center"
            emptyLabel="This trigger could not be found. It may have been deleted."
            errorLabel="Triggers could not be loaded."
            isEmpty
            loadingLabel="Loading trigger…"
            query={triggersQuery}
          >
            {() => null}
          </QueryState>
        </OwnerGate>
      </div>
    )
  }

  // Only while the schedule is actually stopped: a stale reason left over from
  // a repaired failure would otherwise keep claiming it is broken.
  const healthMessage =
    trigger.status === 'needs_reauthorization' || trigger.status === 'error'
      ? getTriggerHealthMessage(trigger)
      : null
  // The server refuses a plain repair when the schedule belongs to somebody
  // else or was created in another team, and names which. Offering takeover
  // only then keeps the ordinary path one click and the attribution-moving
  // path deliberate.
  const needsTakeOver =
    actionError !== null
    && /belongs to somebody else|active team differs/.test(actionError)

  const reauthorize = (takeOver = false) => {
    setActionError(null)
    reauthorizeTrigger.mutate(
      { triggerId: trigger.id, ...(takeOver ? { takeOver: true } : {}) },
      {
        onError: (error) =>
          setActionError(
            error instanceof Error ? error.message : 'Failed to reauthorize this schedule.',
          ),
      },
    )
  }

  const fire = () => {
    setActionError(null)
    fireTrigger.mutate(
      {
        triggerId: trigger.id,
        prompt: `Run trigger ${trigger.name ?? trigger.type}.`,
        payload: { triggerId: trigger.id, triggerType: trigger.type },
      },
      {
        onError: (error) =>
          setActionError(error instanceof Error ? error.message : 'Failed to fire trigger.'),
      },
    )
  }

  const remove = () => {
    setActionError(null)
    deleteTrigger.mutate(trigger.id, {
      onSuccess: () => backToList(),
      onError: (error) => {
        setConfirmDeleteOpen(false)
        const message = error instanceof Error ? error.message : 'Failed to delete trigger.'
        setActionError(
          message.includes('TRIGGER_DELETE_BLOCKED') || message.includes('409')
            ? 'This trigger has delivery history and cannot be deleted. Pause it instead.'
            : message,
        )
      },
    })
  }

  const resume = () => {
    setActionError(null)
    resumeTrigger.mutate(trigger.id, {
      onError: (error) =>
        setActionError(error instanceof Error ? error.message : 'Failed to resume this schedule.'),
    })
  }

  const actions: PageHeaderAction[] = [
    {
      icon: faTrash,
      id: 'delete-trigger',
      label: deleteTrigger.isPending ? 'Deleting…' : 'Delete trigger',
      onSelect: () => setConfirmDeleteOpen(true),
      priority: 10,
    },
    {
      id: 'edit-trigger',
      label: 'Edit',
      onSelect: () => setEditorOpen(true),
      priority: 40,
    },
    ...(trigger.status === 'paused' || trigger.status === 'error'
      ? [{
        id: 'resume-trigger',
        label: 'Resume',
        onSelect: resume,
        priority: 60,
      } satisfies PageHeaderAction]
      : trigger.status === 'active'
        ? [{
        id: 'pause-trigger',
        label: 'Pause',
        onSelect: () => pauseTrigger.mutate(trigger.id),
        priority: 60,
        } satisfies PageHeaderAction]
        : []),
    ...(trigger.status === 'needs_reauthorization'
      ? [{
        id: 'reauthorize-trigger',
        label: reauthorizeTrigger.isPending ? 'Reauthorizing…' : 'Reauthorize',
        onSelect: () => reauthorize(),
        priority: 80,
      } satisfies PageHeaderAction]
      : []),
    ...(trigger.status === 'active' ? [{
      id: 'fire-trigger',
      label: fireTrigger.isPending ? 'Firing…' : 'Run now',
      onSelect: fire,
      primary: true,
      priority: 100,
    } satisfies PageHeaderAction] : []),
  ]

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScreenHeader
        actions={actions}
        backLabel="Back to Triggers"
        eyebrow="Triggers"
        onBack={backToList}
        subtitle={
          <div className="flex flex-wrap items-center gap-2">
            <Pill height="control" tone={getTriggerTone(trigger.status)} uppercase={false}>
              {trigger.status}
            </Pill>
            <p className="text-sm text-[color:var(--tx3)]">{getTriggerTypeLabel(trigger)}</p>
          </div>
        }
        title={trigger.name ?? trigger.type}
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-[var(--page-gutter)] py-4">
        <OwnerGate>
          <div className="grid gap-4">
            {healthMessage ? (
              <div
                className="max-w-3xl rounded-lg border border-[var(--danger-border)] bg-[var(--danger-soft)] px-3 py-2.5"
                role="status"
              >
                <div className="text-sm font-medium text-[color:var(--danger-text)]">
                  This schedule has stopped
                </div>
                <p className="mt-1 text-sm text-[color:var(--tx2)]">{healthMessage}</p>
                {needsTakeOver ? (
                  <button
                    className="admin-button admin-button-secondary mt-2"
                    disabled={reauthorizeTrigger.isPending}
                    onClick={() => reauthorize(true)}
                    type="button"
                  >
                    Take over and reauthorize
                  </button>
                ) : null}
              </div>
            ) : null}

            {fireTrigger.isSuccess && !fireTrigger.isPending ? (
              <Notice className="max-w-3xl" radius="lg" size="sm" tone="success">
                Trigger fired — the run appears under recent deliveries below.
              </Notice>
            ) : null}
            {actionError ? (
              <Notice className="max-w-3xl" radius="lg" size="sm" tone="danger">
                {actionError}
              </Notice>
            ) : null}

            <TriggerDetail registry={registry} trigger={trigger} />
          </div>
        </OwnerGate>
      </div>

      <TriggerEditorDialog
        agents={agents}
        channels={channels}
        onClose={() => setEditorOpen(false)}
        onSaved={() => setEditorOpen(false)}
        open={editorOpen}
        trigger={trigger}
        workflowInstallations={workflowInstallations}
        workflowTemplates={workflowTemplates}
      />

      <ConfirmDialog
        body="Deleting a trigger cannot be undone. It refuses when the trigger has delivery history — pause it instead."
        confirmLabel="Delete trigger"
        destructive
        onCancel={() => setConfirmDeleteOpen(false)}
        onConfirm={remove}
        open={confirmDeleteOpen}
        pending={deleteTrigger.isPending}
        title="Delete this trigger?"
      />
    </div>
  )
}
