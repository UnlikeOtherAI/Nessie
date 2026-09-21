import { useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { PreparedExecutorAccessChangeResponse } from '@nessie/schemas'
import { usePrepareExecutorAccessChange } from '../../../facades/executors/hooks'
import { useExecutorAgentCandidates } from '../../../facades/executors/manage'
import { usePagedListReset } from '../../../facades/pagination/usePagedList'
import { useDebouncedValue } from '../../../hooks/useDebouncedValue'
import { AgentAvatar } from '../../shared/AgentAvatar'
import { AgentVisibilityPill } from '../../shared/AgentVisibilityPill'
import { Dialog } from '../../shared/Dialog'
import { FormError } from '../../shared/FormActions'
import { Input } from '../../shared/FormControls'
import { PaginationFooter } from '../../shared/PaginationFooter'
import { QueryState } from '../../shared/QueryState'
import { Row, RowList } from '../../shared/RowList'

type ExecutorAddAgentDialogProps = {
  executorId: string
  onClose: () => void
  onPrepared: (prepared: PreparedExecutorAccessChangeResponse) => void
  token: string | null
}

/** Mounted only while open; selection prepares a review and never activates access itself. */
export const ExecutorAddAgentDialog = ({ executorId, onClose, onPrepared, token }: ExecutorAddAgentDialogProps) => {
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [, setSearchParams] = useSearchParams()
  const searchRef = useRef<HTMLInputElement | null>(null)
  const candidates = useExecutorAgentCandidates(executorId, useDebouncedValue(query, 200))
  const resetPage = usePagedListReset('executor-add-')
  const prepare = usePrepareExecutorAccessChange()

  const close = () => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current)
      for (const key of [...next.keys()]) if (key.startsWith('executor-add-')) next.delete(key)
      return next
    }, { replace: true })
    onClose()
  }

  const add = async (agentId: string) => {
    setError(null)
    try {
      const prepared = await prepare.mutateAsync({
        executorId, change: { kind: 'agent_executor_access', agentId, state: 'allowed' },
      })
      close()
      onPrepared(prepared)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'This agent could not be added. Try again.')
    }
  }

  return (
    <Dialog
      description="Choose an agent. You will review its access before adding it."
      dismissDisabled={prepare.isPending}
      initialFocusRef={searchRef}
      onClose={close}
      open
      size="lg"
      title="Add agent"
    >
      <div className="grid gap-3">
        <Input
          aria-label="Search agents to add"
          maxLength={200}
          onChange={(event) => { resetPage(); setQuery(event.target.value) }}
          placeholder="Search agents"
          ref={searchRef}
          type="search"
          value={query}
        />
        <FormError>{error}</FormError>
        <QueryState
          emptyLabel={query.trim() ? 'No agents match your search.' : 'No other agents can be added to this machine.'}
          errorLabel="Agents could not be loaded."
          isEmpty={candidates.items.length === 0}
          loadingLabel="Loading agents…"
          query={candidates.query}
        >
          {() => (
            <RowList label="Agents available to add">
              {candidates.items.map((agent) => (
                <Row
                  key={agent.agentId}
                  leading={<AgentAvatar agentId={agent.agentId} size="sm" token={token} />}
                  title={agent.name}
                  subtitle={<AgentVisibilityPill visibility={agent.visibility} />}
                  trailing={(
                    <button
                      aria-label={`Add ${agent.name}`}
                      className="admin-button admin-button-secondary admin-button-compact"
                      disabled={prepare.isPending}
                      onClick={() => void add(agent.agentId)}
                      type="button"
                    >
                      Add
                    </button>
                  )}
                />
              ))}
            </RowList>
          )}
        </QueryState>
        {candidates.query.isSuccess ? <PaginationFooter {...candidates} compact /> : null}
      </div>
    </Dialog>
  )
}
