import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AGENT_TODO_PROMPT_INSTANCE_LIMIT,
  AGENT_TODO_PROMPT_PROPOSAL_LIMIT,
  AGENT_TODO_PROMPT_TEMPLATE_LIMIT,
} from '@nessie/schemas'
import { loadAgentTodoPromptFacts } from '@nessie/workspace-admin'
import type { PrismaClient } from '@prisma/client'

import { buildAgentTodoFactsBlock } from './agent-todo-facts.js'

const numbered = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index + 1}`,
    name: `${prefix} ${index + 1}`,
  }))

const promptFactsPrisma = () => {
  const activeTemplates = numbered('active-template', AGENT_TODO_PROMPT_TEMPLATE_LIMIT + 2)
  const openInstances = Array.from(
    { length: AGENT_TODO_PROMPT_INSTANCE_LIMIT + 3 },
    (_, index) => ({
      id: `open-instance-${index + 1}`,
      steps: [
        { status: 'completed' },
        { status: index % 2 === 0 ? 'pending' : 'failed' },
      ],
      title: `Open instance ${index + 1}`,
    }),
  )
  return {
    agentTodo: {
      count: async () => openInstances.length,
      findMany: async (input: { take?: number }) => openInstances.slice(0, input.take),
    },
    agentTodoTemplate: {
      count: async () => activeTemplates.length,
      findMany: async (input: { take?: number }) => activeTemplates.slice(0, input.take),
    },
  } as unknown as PrismaClient
}

test('to-do facts use the pinned query caps and report every omitted durable fact', async () => {
  const facts = await loadAgentTodoPromptFacts(promptFactsPrisma(), {
    agentId: 'agent-1',
    organizationId: 'organization-1',
  })
  const block = buildAgentTodoFactsBlock(facts)

  assert.ok(block)
  assert.equal(facts.activeTemplates.length, AGENT_TODO_PROMPT_TEMPLATE_LIMIT)
  assert.equal(facts.openInstances.length, AGENT_TODO_PROMPT_INSTANCE_LIMIT)
  assert.deepEqual(facts.proposalDrafts, [])
  assert.match(block, /and 2 more active templates\./)
  assert.match(block, /and 3 more open instances\./)
  assert.match(block, /progress=1\/2/)

  const futureProposalBlock = buildAgentTodoFactsBlock({
    ...facts,
    proposalDraftCount: AGENT_TODO_PROMPT_PROPOSAL_LIMIT + 1,
    proposalDrafts: numbered('proposal-draft', AGENT_TODO_PROMPT_PROPOSAL_LIMIT).map(
      (template) => ({ ...template, status: 'rejected' as const }),
    ),
  })
  assert.match(futureProposalBlock ?? '', /and 1 more proposal drafts\./)
})

test('to-do facts are absent when no to-do tools resolved for the run', () => {
  assert.equal(buildAgentTodoFactsBlock(null), null)
})
