import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import type {
  ExecutorAgentAccessRecord,
  ExecutorRecordResponse,
} from '@nessie/schemas'
import { useSetExecutorAgentAccess } from '../../../facades/executors/sharing'
import { useExecutorAgents } from '../../../facades/executors/manage'
import { useDebouncedValue } from '../../../hooks/useDebouncedValue'
import { AgentAvatar } from '../../shared/AgentAvatar'
import { AgentVisibilityPill } from '../../shared/AgentVisibilityPill'
import { DataTable, type DataTableColumn } from '../../shared/DataTable'
import { FormError } from '../../shared/FormActions'
import { ListToolbar } from '../../shared/ListToolbar'
import { PaginationFooter } from '../../shared/PaginationFooter'
import { QueryState } from '../../shared/QueryState'
import { ExecutorAddAgentDialog } from './ExecutorAddAgentDialog'
import { EXECUTOR_OPERATION_LABELS } from './executor-presentation'

type ExecutorAgentsPanelProps = {
  executorId: string
  scopeKind: ExecutorRecordResponse['scope']['kind']
  token: string | null
}

const AllowedCapabilities = ({ agent }: { agent: ExecutorAgentAccessRecord }) => (
  <p className="text-xs text-[color:var(--tx2)]">
    {agent.allowedOperationKeys.length
      ? agent.allowedOperationKeys.map((key) => EXECUTOR_OPERATION_LABELS[key]).join(', ')
      : 'No capabilities allowed yet'}
  </p>
)

/** The owning detail page mounts this manager-only roster after its access check. */
export const ExecutorAgentsPanel = ({ executorId, scopeKind, token }: ExecutorAgentsPanelProps) => {
  const [searchParams, setSearchParams] = useSearchParams()
  const query = searchParams.get('executor-agent-q') ?? ''
  const roster = useExecutorAgents(executorId, useDebouncedValue(query, 200))
  const prepare = useSetExecutorAgentAccess()
  const [addOpen, setAddOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const remove = async (agentId: string) => {
    setError(null)
    try {
      await prepare.mutateAsync({
        executorId, change: { agentId, state: 'denied' },
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'This agent could not be removed. Try again.')
    }
  }

  const columns: DataTableColumn<ExecutorAgentAccessRecord>[] = [
    {
      header: 'Agent', key: 'agent',
      render: (agent) => (
        <div className="flex items-start gap-3">
          <AgentAvatar agentId={agent.agentId} size="sm" token={token} />
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="break-words font-medium">{agent.name}</p>
              <AgentVisibilityPill visibility={agent.visibility} />
            </div>
            {scopeKind === 'private' && !agent.assigned ? (
              <p className="text-xs text-[color:var(--tx3)]">
                Not assigned to this machine
              </p>
            ) : null}
            <div className="sm:hidden"><AllowedCapabilities agent={agent} /></div>
          </div>
        </div>
      ),
    },
    {
      header: 'Allowed capabilities', key: 'capabilities', secondary: true,
      render: (agent) => <AllowedCapabilities agent={agent} />,
    },
    {
      align: 'right', header: 'Actions', key: 'actions', width: '6.5rem',
      render: (agent) => (
        <button
          aria-label={`Remove ${agent.name}`}
          className="admin-button admin-button-secondary admin-button-compact"
          disabled={prepare.isPending}
          onClick={() => void remove(agent.agentId)}
          type="button"
        >
          Remove
        </button>
      ),
    },
  ]

  return (
    <div className="grid gap-3">
      <ListToolbar search={{
        label: 'Search agents', value: query,
        onChange: (value) => setSearchParams((current) => {
          const next = new URLSearchParams(current)
          next.delete('executor-agent-cursor')
          next.delete('executor-agent-direction')
          next.delete('executor-agent-page')
          if (value) next.set('executor-agent-q', value)
          else next.delete('executor-agent-q')
          return next
        }, { replace: true }),
      }}>
        <button
          className="admin-button admin-button-primary admin-button-compact ml-auto"
          disabled={prepare.isPending}
          onClick={() => setAddOpen(true)}
          type="button"
        >
          Add agent
        </button>
      </ListToolbar>
      <FormError>{error}</FormError>
      <QueryState errorLabel="Agents could not be loaded." loadingLabel="Loading agents…" query={roster.query}>
        {() => (
          <>
            <DataTable
              columns={columns}
              empty={(
                <p className="py-6 text-sm text-[color:var(--tx2)]">
                  {query.trim() ? 'No agents match your search.' : 'No agents have access to this machine yet.'}
                </p>
              )}
              expandable={false}
              label="Executor agents"
              layout="fixed"
              rowKey={(agent) => agent.agentId}
              rows={roster.items}
            />
            <PaginationFooter {...roster} />
          </>
        )}
      </QueryState>
      {addOpen ? (
        <ExecutorAddAgentDialog
          executorId={executorId}
          onClose={() => setAddOpen(false)}
          token={token}
        />
      ) : null}
    </div>
  )
}
