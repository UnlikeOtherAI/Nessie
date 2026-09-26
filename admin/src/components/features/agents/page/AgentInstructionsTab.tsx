import type { UseQueryResult } from '@tanstack/react-query'
import type { AgentDocumentsResponse } from '@nessie/schemas'
import { useAgentTodoTemplates } from '../../../../facades/agent-todos/hooks'
import type { AgentRecord } from '../../../../lib/api-client'
import { Notice } from '../../../primitives/Notice'
import { PageBody, Section } from '../../../shared/PageBody'
import { AgentDocumentsTab } from '../AgentDocumentsTab'
import { TodoTemplates } from '../todos/TodoTemplates'
import { AgentInstructionsField, AgentMannerFields } from './AgentConfigFields'
import type { AgentPageTab } from './agent-page-tabs'
import { BuiltInAgentNote } from './BuiltInAgentNote'
import type { AgentConfigForm } from './useAgentConfigForm'

type AgentInstructionsTabProps = {
  agent: AgentRecord
  builtIn: boolean
  canEdit: boolean
  /** Absent for a built-in agent, whose document read is closed. */
  documents?: UseQueryResult<AgentDocumentsResponse>
  form: AgentConfigForm
  onSelectTab: (tab: AgentPageTab) => void
}

const Checklists = ({
  agent,
  canEdit,
  onSelectTab,
}: Pick<AgentInstructionsTabProps, 'agent' | 'canEdit' | 'onSelectTab'>) => {
  const templates = useAgentTodoTemplates(agent.id, { enabled: agent.todosEnabled, includeArchived: true })
  if (!agent.todosEnabled) {
    return (
      <p className="text-sm text-[color:var(--tx2)]" data-testid="agent-todos-disabled">
        To-dos are off for this agent.{' '}
        {canEdit ? (
          <button
            className="text-[color:var(--lnk)] hover:underline"
            onClick={() => onSelectTab('settings')}
            type="button"
          >
            Turn them on in Settings
          </button>
        ) : null}
      </p>
    )
  }
  return <TodoTemplates agent={agent} query={templates} />
}

/**
 * Instructions: what the agent is told. Its `AGENTS.md` and its manner
 * (`personality.md`) are fields of the page's form, saved with Settings; its
 * other documents are the same Knowledge workspace the Finder opens; its
 * checklists are the reusable to-dos it can follow, including those that
 * repeat on a schedule.
 */
export const AgentInstructionsTab = ({
  agent,
  builtIn,
  canEdit,
  documents,
  form,
  onSelectTab,
}: AgentInstructionsTabProps) => {
  const space = documents?.data?.space
  // Documents can be narrower than the agent: a reader who cannot open the
  // agent's own space sees that, never its instructions by another road.
  if (!builtIn && space && !space.canRead) {
    return (
      <PageBody>
        <Notice tone="neutral">
          You can see this agent, but not its instructions or documents.
        </Notice>
      </PageBody>
    )
  }
  const readOnly = builtIn || !canEdit
  const core = documents?.data?.core

  return (
    <PageBody>
      {builtIn ? <BuiltInAgentNote /> : null}
      {core?.state === 'oversized' ? (
        <Notice tone="warning">
          {`These instructions come to about ${core.estimatedTokens} tokens, above the `
            + `${core.tokenBudget ?? 'allowed'} token limit. Shorten them before the agent can start or resume work.`}
        </Notice>
      ) : null}
      <Section
        description="Every run starts from these. Keep secrets out: anyone who can read its documents can read them."
        title="Instructions"
      >
        <AgentInstructionsField form={form} readOnly={readOnly} />
      </Section>
      <Section title="Manner">
        <AgentMannerFields form={form} readOnly={readOnly} />
      </Section>
      {builtIn ? null : (
        <Section
          description="Its whole document space, AGENTS.md and personality.md among them. A document can be shared more narrowly than the agent."
          title="Its documents"
        >
          <div className="h-[min(70dvh,640px)] min-h-[360px] overflow-hidden rounded-[var(--radius-md)] border border-[color:var(--sep)]">
            <AgentDocumentsTab agent={agent} />
          </div>
        </Section>
      )}
      {builtIn ? null : (
        <Section
          description="Reusable to-dos this agent can work through; one can repeat on a schedule."
          title="Checklists"
        >
          <Checklists agent={agent} canEdit={canEdit} onSelectTab={onSelectTab} />
        </Section>
      )}
    </PageBody>
  )
}
