import { Link } from 'react-router-dom'
import type { ProductPageProps } from '../components/features/integrations/product-page-registry'
import { SignalCard } from '../components/features/integrations/SignalCard'
import { useActOnSignal, useDeepSignalSignals } from '../facades/integrations/hooks'
import { MobileSectionHeader } from '../layouts/admin-shell/MobileSectionHeader'

// The concrete DeepSignal Signals page (surface-registry plan §4). Registered
// into `product-page-registry` for route `/signals`, so Slice A's generic
// `ProductPageHost` renders it with no router/shell change. It shows the insight
// digest as cards with done/snooze actions, and a fail-closed "Connect
// DeepSignal" state when the connector isn't linked for the user.

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
  const signalsQuery = useDeepSignalSignals()
  const actMutation = useActOnSignal()
  const title = surface.label

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
            <Link className="admin-button admin-button-primary inline-flex text-xs" to="/integrations">
              Open Integrations
            </Link>
          }
        />
      </Frame>
    )
  }

  const signals = signalsQuery.data.items
  if (signals.length === 0) {
    return (
      <Frame title={title}>
        <CenteredState
          title="You’re all caught up"
          body="Nothing you need to worry about right now — new signals will appear here as they surface."
        />
      </Frame>
    )
  }

  const actingId = actMutation.isPending ? actMutation.variables?.insightId : undefined

  return (
    <Frame title={title}>
      <div className="mb-4">
        <h1 className="text-lg font-semibold text-[var(--tx)]">Signals</h1>
        <p className="mt-1 text-sm text-[var(--tx3)]">
          Opportunities and risks {surface.productName} surfaced for you.
        </p>
      </div>
      <div className="grid gap-3">
        {signals.map((signal) => (
          <SignalCard
            acting={actingId === signal.id}
            key={signal.id}
            onAct={(action) => actMutation.mutate({ action, insightId: signal.id })}
            signal={signal}
          />
        ))}
      </div>
    </Frame>
  )
}
