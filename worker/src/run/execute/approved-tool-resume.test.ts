import assert from 'node:assert/strict'
import test from 'node:test'

import { GMAIL_DRAFT_SEND_TOOL_ID, MAILBOX_SEND_TOOL_ID } from '@nessie/runtime'
import {
  parseOrganizationId,
  parseProjectId,
  parseTeamId,
  type AuthorizedActionContext,
} from '@nessie/schemas'
import type { PrismaClient } from '@prisma/client'

import { loadFrozenApprovedToolCall } from './approved-tool-resume.js'
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
    prisma: {
      approvalRequest: {
        findFirst: async ({ where }: { where: Record<string, unknown> }) =>
          Object.entries(where).every(([key, value]) => approval[key as keyof typeof approval] === value)
            ? approval
            : null,
      },
      run: {
        findUnique: async () => ({ continuationOfRunId: input.continuationOfRunId ?? ids.parentRun }),
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
