import type { McpServerLifecycleState } from '@nessie/schemas'
import { StatusPill } from '../../primitives/StatusPill'
import type { McpServerInstanceRecord } from '../../../facades/mcp-instances/hooks'

/**
 * Installed-server list used in the App Store right column. Renders lifecycle
 * state (pending_setup / active / paused / error) using the shared
 * `StatusPill` primitive so it's consistent with channel/agent rows.
 */

type InstanceListProps = {
  instances: McpServerInstanceRecord[]
  onCredentials: (instance: McpServerInstanceRecord) => void
  onSelect: (instance: McpServerInstanceRecord) => void
  onTest: (instance: McpServerInstanceRecord) => void
  selectedId?: string
  testingId?: string
}

const LIFECYCLE_TONE = {
  pending_setup: 'warning',
  active: 'success',
  paused: 'muted',
  error: 'danger',
} as const satisfies Record<
  McpServerLifecycleState,
  'warning' | 'success' | 'muted' | 'danger'
>

const formatHealthAt = (value: string | null) => {
  if (!value) return 'never'
  try {
    return new Date(value).toLocaleString()
  } catch {
    return value
  }
}

export const InstanceList = ({
  instances,
  onCredentials,
  onSelect,
  onTest,
  selectedId,
  testingId,
}: InstanceListProps) => {
  if (instances.length === 0) {
    return (
      <div className="py-8 text-center text-sm text-[color:var(--tx3)]">
        Nothing installed yet. Pick a catalog entry and click "Install".
      </div>
    )
  }

  return (
    <div className="grid gap-3">
      {instances.map((instance) => (
        <div
          className={[
            'rounded-xl border p-3 transition',
            instance.id === selectedId
              ? 'border-emerald-400/60 bg-emerald-400/10'
              : 'border-[color:var(--sep)] bg-black/10',
          ].join(' ')}
          key={instance.id}
        >
          <button
            className="flex w-full items-start justify-between gap-3 text-left"
            onClick={() => onSelect(instance)}
            type="button"
          >
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold text-white">
                {instance.scopeType} · {instance.scopeId.slice(0, 8)}…
              </div>
              <div className="mt-1 text-xs text-[color:var(--tx3)]">
                Health checked: {formatHealthAt(instance.healthLastCheckedAt)}
                {' · '}
                Failures: {instance.healthFailureCount}
              </div>
            </div>
            <StatusPill tone={LIFECYCLE_TONE[instance.lifecycleState]}>
              {instance.lifecycleState}
            </StatusPill>
          </button>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              className={[
                'admin-button rounded-md border border-[color:var(--sep)]',
                'px-3 py-1 text-xs text-[color:var(--tx2)] hover:bg-white/5',
                'disabled:cursor-not-allowed disabled:opacity-40',
              ].join(' ')}
              disabled={testingId === instance.id}
              onClick={() => onTest(instance)}
              type="button"
            >
              {testingId === instance.id ? 'Probing…' : 'Test & discover'}
            </button>
            <button
              className={[
                'admin-button rounded-md border border-[color:var(--sep)]',
                'px-3 py-1 text-xs text-[color:var(--tx2)] hover:bg-white/5',
              ].join(' ')}
              onClick={() => onCredentials(instance)}
              type="button"
            >
              Credentials
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
