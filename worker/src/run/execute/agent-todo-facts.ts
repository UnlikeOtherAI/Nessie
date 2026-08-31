// To-do prompt facts (agent todos plan §3).
//
// This block contains only bounded, durable database facts and resolved-tool
// state. It never reads message content or decides whether the user asked to
// execute a checklist; that meaning remains the model's judgment.

import {
  AGENT_TODO_PROMPT_INSTANCE_LIMIT,
  AGENT_TODO_PROMPT_PROPOSAL_LIMIT,
  AGENT_TODO_PROMPT_TEMPLATE_LIMIT,
} from '@nessie/schemas'
import type { AgentTodoPromptFacts } from '@nessie/workspace-admin'

const TODO_FACTS_HEADING = 'To-do facts:'
const ACTIVE_TEMPLATES_HEADING = 'Active templates:'
const OPEN_INSTANCES_HEADING = 'Open instances:'
const PROPOSAL_DRAFTS_HEADING = 'Proposal drafts:'

const moreLine = (count: number, limit: number, label: string): string =>
  count > limit ? `- and ${count - limit} more ${label}` : ''

const emptyLine = (label: string): string => `- No ${label}.`

/** Renders a bounded, structural to-do inventory only when both tools resolve. */
export const buildAgentTodoFactsBlock = (
  facts: AgentTodoPromptFacts | null,
): string | null => {
  if (!facts) return null

  const templates = facts.activeTemplates.map(
    (template) => `- name=${JSON.stringify(template.name)} | templateId=${template.id}`,
  )
  const instances = facts.openInstances.map(
    (todo) =>
      `- todoId=${todo.id} | title=${JSON.stringify(todo.title)} | progress=`
      + `${todo.completedStepCount}/${todo.stepCount}`,
  )
  const proposals = facts.proposalDrafts.map(
    (template) =>
      `- name=${JSON.stringify(template.name)} | templateId=${template.id} | status=`
      + template.status,
  )

  return [
    TODO_FACTS_HEADING,
    ACTIVE_TEMPLATES_HEADING,
    ...(templates.length > 0 ? templates : [emptyLine('active templates')]),
    moreLine(
      facts.activeTemplateCount,
      AGENT_TODO_PROMPT_TEMPLATE_LIMIT,
      'active templates.',
    ),
    OPEN_INSTANCES_HEADING,
    ...(instances.length > 0 ? instances : [emptyLine('open instances')]),
    moreLine(
      facts.openInstanceCount,
      AGENT_TODO_PROMPT_INSTANCE_LIMIT,
      'open instances.',
    ),
    PROPOSAL_DRAFTS_HEADING,
    ...(proposals.length > 0 ? proposals : [emptyLine('proposal drafts')]),
    moreLine(
      facts.proposalDraftCount,
      AGENT_TODO_PROMPT_PROPOSAL_LIMIT,
      'proposal drafts.',
    ),
  ].filter((line) => line.length > 0).join('\n')
}
