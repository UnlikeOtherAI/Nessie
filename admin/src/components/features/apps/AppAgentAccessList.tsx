import { useMemo, useState } from 'react'
import type { AppDetailRecord } from '@nessie/schemas'
import { Link } from 'react-router-dom'

import {
  AppAgentAccessWriteError,
  useAppAgentAccessSource,
  useSetAppAgentAccess,
} from '../../../facades/apps/agent-access-hooks'
import { mcpInstanceToolsPath } from '../../../facades/mcp-instance-tool-filter'
import { Pill } from '../../primitives/Pill'
import { Switch } from '../../primitives/Switch'
import { getAgentGlyph } from '../../shared/AgentAvatar'
import { EmptyState } from '../../shared/EmptyState'
import { QueryState } from '../../shared/QueryState'
import {
  agentAccessConsequence,
  agentAccessEmptyState,
  agentAccessHeadline,
  agentAccessToggleLabel,
  agentAccessWriteFailure,
  appAccessNotice,
  beginAgentAccessWrite,
  buildAgentAccessList,
  projectAppAccessTools,
  resolveAgentAccessRow,
  resolveAppAccessControl,
  type AgentAccessRow,
  type AppAccessControl,
  type PendingAgentAccess,
} from './agent-access-view'

/**
 * Which agents may call this app — and, for an owner, the switch that decides
 * it.
 *
 * The switch writes `Agent.toolPolicy` through the existing per-agent policy
 * route, because that plus the connection's install scope is the *only* thing
 * the worker consults when it assembles a run's toolset. Every decision behind
 * the rows — what "allowed" means across an app's many capabilities, what
 * partial state reads as, which rows a switch may honestly move and how the
 * rest are disclosed — lives in `agent-access-view.ts`, so it is arguable and
 * testable without React.
 */

type AppAgentAccessListProps = {
  app: AppDetailRecord
}

const rowShell = [
  'flex items-center gap-3 rounded-[var(--radius-md)]',
  'border border-[color:var(--sep)] bg-[color:var(--panel-soft)] px-4 py-3',
].join(' ')

/**
 * `caption` is a slot, not a fixed field: today it is the role on a read-only
 * row and the consequence summary on a managed one, and it is where a future
 * "12 of 42 capabilities" per-capability view lands without moving the layout.
 */
const AgentIdentity = ({ caption, row }: { caption: string | null; row: AgentAccessRow }) => (
  <>
    {/* The access record carries no avatar, so the row uses the shared role
        glyph rather than inventing avatar fields. */}
    <span
      aria-hidden="true"
      className={[
        'flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md',
        'border border-[color:var(--accent)] bg-[color:var(--accent-soft)] text-sm',
      ].join(' ')}
    >
      {getAgentGlyph({ role: row.role ?? '' })}
    </span>
    <span className="min-w-0 flex-1">
      <span className="flex items-center gap-2">
        <span className="truncate text-sm font-medium text-[color:var(--tx)]">{row.name}</span>
        {row.isPersonalAssistant ? (
          <Pill tone="accent">Assistant</Pill>
        ) : null}
      </span>
      {caption ? (
        <span className="block truncate text-xs text-[color:var(--tx3)]">{caption}</span>
      ) : null}
    </span>
  </>
)

const ObservedAgentRow = ({ row }: { row: AgentAccessRow }) => (
  <li>
    <Link
      className={[
        rowShell,
        'transition-colors duration-[var(--duration-fast)]',
        'hover:border-[color:var(--border-strong)] hover:bg-[color:var(--overlay-weak)]',
      ].join(' ')}
      to={`/agents/${row.agentId}`}
    >
      <AgentIdentity caption={row.role} row={row} />
    </Link>
  </li>
)

type ManagedAgentRowProps = {
  appName: string
  row: AgentAccessRow
  toolRegistryEntryIds: readonly string[]
}

const ManagedAgentRow = ({ appName, row, toolRegistryEntryIds }: ManagedAgentRowProps) => {
  const setAccess = useSetAppAgentAccess()
  const [pending, setPending] = useState<PendingAgentAccess | null>(null)
  const [error, setError] = useState<string | null>(null)
  const view = resolveAgentAccessRow(row, pending)
  const checked = view.state !== 'none'

  const toggle = (enabled: boolean) => {
    if (setAccess.isPending) return
    setError(null)
    setPending(beginAgentAccessWrite(row, enabled))
    setAccess.mutate(
      { agentId: row.agentId, enabled, toolRegistryEntryIds },
      {
        onError: (caught) => {
          setPending(null)
          setError(
            agentAccessWriteFailure({
              landed: caught instanceof AppAgentAccessWriteError ? caught.landed : 0,
              reason: caught.message,
              total: toolRegistryEntryIds.length,
            }),
          )
        },
      },
    )
  }

  return (
    <li className={`${rowShell} flex-wrap`}>
      <Link
        className="flex min-w-0 flex-1 items-center gap-3"
        to={`/agents/${row.agentId}`}
      >
        <AgentIdentity caption={view.summary} row={view} />
      </Link>
      <span className={`flex-shrink-0 ${setAccess.isPending ? 'opacity-50' : ''}`}>
        <Switch
          checked={checked}
          label={agentAccessToggleLabel(view, appName)}
          onChange={toggle}
        />
      </span>
      {/* The switch says what was asked for; this line says what is actually
          true — a grant the connection's scope does not reach, or a fan-out
          that stopped part way. Hiding either would be the checkbox lying. */}
      {error ? (
        <p className="w-full text-xs text-[color:var(--danger-text)]" role="alert">
          {error}
        </p>
      ) : view.note ? (
        <p className="w-full text-xs text-[color:var(--warning-text)]">{view.note}</p>
      ) : null}
    </li>
  )
}

const ControlNotice = ({ control }: { control: AppAccessControl }) => {
  const notice = appAccessNotice(control, mcpInstanceToolsPath)
  if (!notice) return null
  return (
    <p
      className={[
        'rounded-[var(--radius-md)] border border-[color:var(--line)]',
        'bg-[color:var(--overlay-weak)] px-4 py-3 text-xs leading-5 text-[color:var(--tx2)]',
      ].join(' ')}
    >
      {notice.body}
      {notice.href && notice.hrefLabel ? (
        <>
          {' '}
          <Link className="text-[color:var(--accent)] underline" to={notice.href}>
            {notice.hrefLabel}
          </Link>
        </>
      ) : null}
    </p>
  )
}

export const AppAgentAccessList = ({ app }: AppAgentAccessListProps) => {
  const source = useAppAgentAccessSource()
  const connectionIds = useMemo(
    () => app.connections.map((connection) => connection.id),
    [app.connections],
  )

  const control = useMemo(
    () =>
      resolveAppAccessControl({
        canManage: source.canManage,
        connectionIds,
        projection: source.tools ? projectAppAccessTools(source.tools, connectionIds) : null,
      }),
    [connectionIds, source.canManage, source.tools],
  )

  const list = useMemo(
    () =>
      buildAgentAccessList({
        agentsWithAccess: app.agentsWithAccess,
        control,
        targets: source.targets,
      }),
    [app.agentsWithAccess, control, source.targets],
  )

  const empty = agentAccessEmptyState(app, list)
  const toolRegistryEntryIds = useMemo(
    () =>
      control.kind === 'manageable'
        ? control.tools.map((tool) => tool.registryEntryId)
        : [],
    [control],
  )

  return (
    <div className="grid gap-3" data-testid="app-agent-access">
      <ControlNotice control={control} />
      <QueryState
        className="py-2"
        errorLabel="Agent access could not be loaded."
        loadingLabel="Checking agent access…"
        query={source}
      >
        {() => (
          <>
            {empty ? (
              empty.placement === 'sole' ? (
                <EmptyState>
                  <div className="font-medium text-[color:var(--tx2)]">{empty.message.title}</div>
                  <p className="mt-1">{empty.message.body}</p>
                </EmptyState>
              ) : (
                <p className="text-xs leading-5 text-[color:var(--tx3)]">{empty.message.body}</p>
              )
            ) : null}
            {list.rows.length > 0 ? (
              <>
                <p className="text-xs text-[color:var(--tx3)]">{agentAccessHeadline(list)}</p>
                <ul className="grid gap-2">
                  {list.rows.map((row) =>
                    list.mode === 'managed' ? (
                      <ManagedAgentRow
                        appName={app.displayName}
                        key={row.agentId}
                        row={row}
                        toolRegistryEntryIds={toolRegistryEntryIds}
                      />
                    ) : (
                      <ObservedAgentRow key={row.agentId} row={row} />
                    ),
                  )}
                </ul>
              </>
            ) : null}
            <p className="text-xs leading-5 text-[color:var(--tx3)]">
              {agentAccessConsequence(list)}
            </p>
          </>
        )}
      </QueryState>
    </div>
  )
}
