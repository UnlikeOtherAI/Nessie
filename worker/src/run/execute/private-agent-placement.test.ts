import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyError } from '../error-classification.js'
import { createConsumedSourceSink } from './disclosure-basis.js'
import {
  assertPrivateAgentRunPlacement,
  PrivateAgentPlacementError,
} from './private-agent-placement.js'
import type { RunContext } from './types.js'

const id = (suffix: string): string => `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`

const privateContext = (): RunContext => ({
  agent: {
    agentKind: 'shared',
    effort: 'medium',
    executionMode: 'inference',
    id: id('1'),
    model: null,
    name: 'Private agent',
    ownerUserId: id('2'),
    parentAgentId: null,
    provider: null,
    systemPrompt: null,
    visibility: 'private',
  },
  channel: {
    dmKey: null,
    id: id('3'),
    organizationId: id('4'),
    projectId: id('5'),
    systemChannelType: null,
    teamId: id('6'),
  },
  consumedSources: createConsumedSourceSink(),
  run: {
    createdAt: new Date('2026-08-30T00:00:00.000Z'),
    id: id('7'),
    replyPlacement: null,
    threadId: id('8'),
    trigger: null,
  },
  task: { id: id('9') },
})

test('a private agent targeting a non-home channel fails with a classified placement error', () => {
  const context = privateContext()

  assert.throws(
    () => assertPrivateAgentRunPlacement(context),
    (error: unknown) =>
      error instanceof PrivateAgentPlacementError
      && classifyError(error) === 'private_agent_placement',
  )
})

test('a private agent may run in its exact owner home DM', () => {
  const context = privateContext()
  context.channel.dmKey = [
    'agent',
    context.channel.organizationId,
    context.agent.ownerUserId,
    context.agent.id,
  ].join(':')

  assert.doesNotThrow(() => assertPrivateAgentRunPlacement(context))
})

test('a private agent may run in a thread targeted by its own trigger', () => {
  const context = privateContext()
  context.run.trigger = {
    agentId: context.agent.id,
    targetThreadId: context.run.threadId,
  }

  assert.doesNotThrow(() => assertPrivateAgentRunPlacement(context))
})
