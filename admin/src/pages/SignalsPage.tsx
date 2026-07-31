import { useCallback, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type { DeepSignalSignalRecord } from '../lib/api-client'
import type { ProductPageProps } from '../components/features/integrations/product-page-registry'
import { SignalDetailDrawer } from '../components/features/integrations/SignalDetailDrawer'
import { SignalRow } from '../components/features/integrations/SignalRow'
import { SignalsOverview } from '../components/features/integrations/SignalsOverview'
import {
  groupSignalsByKind,
  summarizeSignals,
  type SignalActionType,
} from '../components/features/integrations/signal-format'
import { useActOnSignal, useDeepSignalSignals } from '../facades/integrations/hooks'
import { MobileSectionHeader } from '../layouts/admin-shell/MobileSectionHeader'

// The DeepSignal Signals inbox (deep-integration research §3): a triaged
// Overview/Inbox rather than a settings list or notification feed. An overview
// header tallies what needs attention; active signals are grouped by kind (risks
// first) with inline act/snooze/mute; a "Show resolved" toggle reveals the full
// list; clicking a row opens a mission detail drawer. Fail-closed "Connect
// DeepSignal" when the connector isn't linked. Registered for route `/signals`.

const Frame = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div className="flex h-full flex-col">
    <MobileSectionHeader title={title} />
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl px-4 py-6 sm:px-6">{children}</div>
    </div>
  </div>
)

const CenteredState = ({
  title,
  body,
  action,
}: {
  title: string
  body: string
  action?: React.ReactNode
}) => (
  <div className="mx-auto max-w-md px-6 py-16 text-center">
    <h2 className="text-base font-semibold text-[var(--tx)]">{title}</h2>
    <p className="mt-2 text-sm leading-6 text-[var(--tx3)]">{body}</p>
    {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
  </div>
)

export const SignalsPage = ({ surface }: ProductPageProps) => {
  const [includeAll, setIncludeAll] = useState(false)
  const [openSignal, setOpenSignal] = useState<DeepSignalSignalRecord | null>(null)
  const signalsQuery = useDeepSignalSignals(includeAll ? 'all' : 'active')
  const actMutation = useActOnSignal()
  const title = surface.label

  const items = signalsQuery.data?.status === 'ok' ? signalsQuery.data.items : []
  const counts = useMemo(() => summarizeSignals(items), [items])
  const groups = useMemo(() => groupSignalsByKind(items), [items])

  // Keep the drawer in sync with refetched data so an acted-on signal reflects
  // its new status (or disappears from the active view) without a stale copy.
  const openSignalLive = openSignal
    ? (items.find((item) => item.id === openSignal.id) ?? openSignal)
    : null
  const actingId = actMutation.isPending ? actMutation.variables?.insightId : undefined

  // A stable close handler: `useModalA11y` re-runs its effect (rebuilding the
  // focus trap) whenever `onClose` changes identity, and this parent re-renders
  // mid-act as `isPending` toggles — a fresh closure each render would tear down
  // the trap and yank focus off the button the user just pressed.
  const closeSignal = useCallback(() => setOpenSignal(null), [])

  const act = (insightId: string, action: SignalActionType) => {
    actMutation.mutate(
      { action, insightId },
      {
        onSuccess: (response) => {
          if (response.status !== 'ok' || !response.item) return
          const updated = response.item
          // Reflect the acted-on signal's new status in the open drawer rather
          // than falling back to the stale "active" snapshot (which would show
          // its actions re-enabled and allow a duplicate act). If it no longer
          // belongs in the current filter, close the drawer instead.
          setOpenSignal((current) => {
            if (!current || current.id !== updated.id) return current
            const stillVisible = includeAll || updated.status === 'active'
            return stillVisible ? updated : null
          })
        },
      },
    )
  }

  if (signalsQuery.isLoading) {
    return (
      <Frame title={title}>
        <div className="py-16 text-center text-sm text-[var(--tx3)]">Loading signals…</div>
      </Frame>
    )
  }

  if (signalsQuery.isError || !signalsQuery.data) {
    return (
      <Frame title={title}>
        <CenteredState
          title="Couldn’t load your signals"
          body="Something went wrong reaching DeepSignal. Try again in a moment."
        />
      </Frame>
    )
  }

  if (signalsQuery.data.status === 'needs_setup') {
    return (
      <Frame title={title}>
        <CenteredState
          title="Connect DeepSignal to see your signals"
          body="Activate DeepSignal and sign in to start receiving the opportunities and risks that matter to you."
          action={
            <Link
              className="admin-button admin-button-primary admin-button-compact"
              to="/settings/integrations"
            >
              Open Integrations
            </Link>
          }
        />
      </Frame>
    )
  }

  return (
    <Frame title={title}>
      <SignalsOverview counts={counts} includeAll={includeAll} onToggleIncludeAll={setIncludeAll} />
      {groups.length === 0 ? (
        <CenteredState
          title={includeAll ? 'No signals yet' : 'You’re all caught up'}
          body={
            includeAll
              ? 'Nothing has surfaced yet — new signals will appear here as DeepSignal finds them.'
              : 'Nothing you need to worry about right now — new signals will appear here as they surface.'
          }
        />
      ) : (
        <div className="flex flex-col gap-5">
          {groups.map((group) => (
            <section key={group.kind}>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-[var(--tx3)]">
                {group.label}
                <span className="ml-1.5 font-normal text-[var(--tx3)]">{group.signals.length}</span>
              </h2>
              <div className="flex flex-col gap-2.5">
                {group.signals.map((signal) => (
                  <SignalRow
                    acting={actingId === signal.id}
                    key={signal.id}
                    onAct={(action) => act(signal.id, action)}
                    onOpen={setOpenSignal}
                    signal={signal}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
      {openSignalLive ? (
        <SignalDetailDrawer
          acting={actingId === openSignalLive.id}
          onAct={(action) => act(openSignalLive.id, action)}
          onClose={closeSignal}
          signal={openSignalLive}
        />
      ) : null}
    </Frame>
  )
}
