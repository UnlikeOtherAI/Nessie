import assert from 'node:assert/strict'
import test from 'node:test'

import {
  EMAIL_SEND_TOOL_ID,
  GMAIL_DRAFT_SEND_TOOL_ID,
  MAILBOX_SEND_TOOL_ID,
} from '@nessie/runtime'
import {
  parseOrganizationId,
  parseProjectId,
  parseTeamId,
  type AuthorizedActionContext,
} from '@nessie/schemas'
import type { PrismaClient } from '@prisma/client'

import {
  loadFrozenApprovedToolCall,
  resumeApprovedEmailContinuation,
} from './approved-tool-resume.js'
import { createConsumedSourceSink } from './disclosure-basis.js'
import { hashJsonValue } from '../tool-util.js'
import type { RunContext } from './types.js'

const ids = {
  agent: '11111111-1111-4111-8111-111111111111',
  channel: '22222222-2222-4222-8222-222222222222',
  organization: '33333333-3333-4333-8333-333333333333',
  parentRun: '44444444-4444-4444-8444-444444444444',
  project: '55555555-5555-4555-8555-555555555555',
  run: '66666666-6666-4666-8666-666666666666',
  task: '77777777-7777-4777-8777-777777777777',
  team: '88888888-8888-4888-8888-888888888888',
} as const

const frozenArgs = {
  connectionId: '99999999-9999-4999-8999-999999999999',
  subject: 'unique frozen subject',
  text: 'unique frozen body',
  to: ['unique-recipient@example.test'],
}

const hostedEmailArgs = {
  approvalProposal: {
    bcc: ['audit@example.test'],
    cc: [],
    conversationId: null,
    mailboxId: '99999999-9999-4999-8999-999999999999',
    subject: 'unique frozen hosted subject',
    to: ['unique-hosted-recipient@example.test'],
  },
  subject: 'unique frozen hosted subject',
  text: 'unique frozen hosted body',
  to: ['unique-hosted-recipient@example.test'],
}

const actorContext = (): AuthorizedActionContext => ({
  actionContext: { requestId: 'approved-tool-resume-test' },
  actor: { actorId: ids.agent, actorType: 'agent' },
  approval: { approvalId: 'approval-1', approvalProof: 'approved-proof' },
  tenant: {
    organizationId: parseOrganizationId(ids.organization),
    projectId: parseProjectId(ids.project),
    teamId: parseTeamId(ids.team),
  },
})

const context = (): RunContext => ({
  agent: {
    agentKind: 'shared', effort: 'medium', executionMode: 'inference', id: ids.agent,
    model: null, name: 'Approvals agent', parentAgentId: null, provider: null, systemPrompt: null,
  },
  boundAgentIds: [],
  channel: {
    id: ids.channel, organizationId: ids.organization, projectId: ids.project,
    systemChannelType: null, teamId: ids.team,
  },
  consumedSources: createConsumedSourceSink(),
  run: { createdAt: new Date(), id: ids.run, replyPlacement: null, threadId: ids.channel },
  task: { id: ids.task },
})

const fakePrisma = (input: {
  argsHashArgs?: Record<string, unknown>
  continuationOfRunId?: string | null
  proofConsumedAt?: Date | null
  resumeArgs?: Record<string, unknown>
  toolName?: string
}) => {
  const state = {
    connectorUsage: [] as Array<Record<string, unknown>>,
    toolCalls: [] as Array<Record<string, unknown>>,
  }
  const resumeArgs = input.resumeArgs ?? frozenArgs
  const toolName = input.toolName ?? MAILBOX_SEND_TOOL_ID
  const approval = {
    action: 'tool.invoke',
    argsHash: hashJsonValue(input.argsHashArgs ?? frozenArgs),
    continuationToken: 'approved-proof',
    id: 'approval-1',
    organizationId: ids.organization,
    proofConsumedAt: input.proofConsumedAt ?? null,
    resumeState: {
      actorContext: actorContext(),
      args: resumeArgs,
      interactive: true,
      messageId: 'message-1',
    },
    runId: ids.parentRun,
    status: 'approved',
    toolCallId: 'frozen-mailbox-call',
    toolName,
  }
  return {
    approval,
    connectorUsage: state.connectorUsage,
    toolCalls: state.toolCalls,
    prisma: {
      approvalRequest: {
        findFirst: async ({ where }: { where: Record<string, unknown> }) =>
          Object.entries(where).every(([key, value]) => approval[key as keyof typeof approval] === value)
            ? approval
            : null,
      },
      connectorUsageEvent: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          state.connectorUsage.push(data)
          return {}
        },
      },
      run: {
        findUnique: async () => ({ continuationOfRunId: input.continuationOfRunId ?? ids.parentRun }),
      },
      toolCall: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          state.toolCalls.push(data)
          return {}
        },
      },
    } as unknown as PrismaClient,
  }
}

test('resolves only the exact frozen mailbox action through its opaque approval handle', async () => {
  const state = fakePrisma({})
  const call = await loadFrozenApprovedToolCall(state.prisma, {
    actorContext: actorContext(),
    context: context(),
  })
  assert.deepEqual(call, {
    args: frozenArgs,
    toolCallId: 'frozen-mailbox-call',
    toolName: MAILBOX_SEND_TOOL_ID,
  })
})

test('rejects a modified, replayed, or cross-run approved-action handle', async () => {
  const modified = fakePrisma({ resumeArgs: { ...frozenArgs, text: 'modified after approval' } })
  assert.equal(await loadFrozenApprovedToolCall(modified.prisma, {
    actorContext: actorContext(), context: context(),
  }), null)

  const replayed = fakePrisma({ proofConsumedAt: new Date() })
  assert.equal(await loadFrozenApprovedToolCall(replayed.prisma, {
    actorContext: actorContext(), context: context(),
  }), null)

  const crossRun = fakePrisma({ continuationOfRunId: 'other-parent-run' })
  assert.equal(await loadFrozenApprovedToolCall(crossRun.prisma, {
    actorContext: actorContext(), context: context(),
  }), null)
})

test('strips the server-only Gmail approval fingerprint after sealing its exact args', async () => {
  const gmailArgs = {
    approvalFingerprint: 'f'.repeat(64),
    draftId: 'gmail-draft-1',
  }
  const state = fakePrisma({
    argsHashArgs: gmailArgs,
    resumeArgs: gmailArgs,
    toolName: GMAIL_DRAFT_SEND_TOOL_ID,
  })

  const call = await loadFrozenApprovedToolCall(state.prisma, {
    actorContext: actorContext(),
    context: context(),
  })

  assert.deepEqual(call, {
    args: { draftId: 'gmail-draft-1' },
    toolCallId: 'frozen-mailbox-call',
    toolName: GMAIL_DRAFT_SEND_TOOL_ID,
  })
})

test('dispatches the frozen mailbox action without any model callback', async () => {
  const state = fakePrisma({})
  const dispatched: Array<Record<string, unknown>> = []
  const result = await resumeApprovedEmailContinuation({
    actorContext: actorContext(),
    authorize: async (call) => ({
      args: call.args,
      decision: 'allow',
      toolActorContext: actorContext(),
    }),
    context: context(),
    dispatch: async (call) => {
      dispatched.push(call.args)
      return {
        connectorUsage: {
          calls: 1,
          connectorType: 'email',
          metadata: { text: 'unique frozen body' },
          target: 'unique-recipient@example.test',
        },
        inputSummary: 'ignored',
        output: 'ignored',
        success: true,
      }
    },
    invocationSink: [],
    prisma: state.prisma,
  })

  assert.deepEqual(dispatched, [frozenArgs])
  assert.equal(result?.finalText, 'The approved action was completed.')
  assert.equal(result?.toolCallsUsed, 1)
  assert.equal(state.toolCalls[0]?.['inputSummary'], 'Approved server-owned action')
  assert.doesNotMatch(JSON.stringify(state.toolCalls), /unique frozen|unique-recipient/)
  assert.equal(state.connectorUsage[0]?.['target'], null)
  assert.equal(state.connectorUsage[0]?.['metadata'], undefined)
})

test('dispatches a real tool.invoke hosted-mail approval from its sealed proposal without inference', async () => {
  const state = fakePrisma({
    argsHashArgs: hostedEmailArgs,
    resumeArgs: hostedEmailArgs,
    toolName: EMAIL_SEND_TOOL_ID,
  })
  const dispatched: Array<Record<string, unknown>> = []
  const result = await resumeApprovedEmailContinuation({
    actorContext: actorContext(),
    authorize: async (call) => ({
      args: call.args,
      decision: 'allow',
      toolActorContext: actorContext(),
    }),
    context: context(),
    dispatch: async (call) => {
      dispatched.push(call.args)
      return {
        inputSummary: 'ignored',
        output: 'ignored',
        success: true,
      }
    },
    invocationSink: [],
    prisma: state.prisma,
  })

  assert.deepEqual(dispatched, [hostedEmailArgs])
  assert.equal(result?.finalText, 'The approved action was completed.')
  assert.equal(result?.iterations, 0, 'a frozen approval never starts an inference turn')
  assert.doesNotMatch(JSON.stringify(state.toolCalls), /unique frozen hosted|unique-hosted-recipient/)
})

test('leaves a non-email approval continuation on the ordinary path', async () => {
  const state = fakePrisma({ toolName: 'kb_search' })
  const result = await resumeApprovedEmailContinuation({
    actorContext: actorContext(),
    authorize: async () => {
      throw new Error('non-email approval must not be intercepted')
    },
    context: context(),
    dispatch: async () => {
      throw new Error('non-email approval must not be dispatched')
    },
    invocationSink: [],
    prisma: state.prisma,
  })
  assert.equal(result, null)
})
