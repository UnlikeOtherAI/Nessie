import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyError } from '../error-classification.js'
import { createConsumedSourceSink } from './disclosure-basis.js'
import {
  assertGlobalAgentRunPlacement,
  GlobalAgentPlacementError,
} from './global-agent-placement.js'
import type { RunContext } from './types.js'

const id = (suffix: string): string => `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`

const designerContext = (): RunContext => ({
  agent: {
    agentKind: 'shared',
    effort: 'medium',
    executionMode: 'inference',
    id: id('1'),
    model: null,
    name: 'Agent Designer',
    ownerUserId: null,
    parentAgentId: null,
    provider: null,
    systemPrompt: null,
    systemSlug: 'agent-designer',
    visibility: 'team',
  },
  boundAgentIds: [],
  channel: {
    dmKey: `gagent:agent-designer:${id('4')}:${id('2')}`,
    id: id('3'),
    organizationId: id('4'),
    projectId: id('5'),
    systemChannelType: 'system_agent',
    teamId: id('6'),
  },
  consumedSources: createConsumedSourceSink(),
  run: {
    createdAt: new Date('2026-09-02T00:00:00.000Z'),
    id: id('7'),
    replyPlacement: null,
    threadId: id('8'),
    trigger: null,
  },
  task: { id: id('9') },
})

test('a global agent may run in its own per-user home DM', () => {
  assert.doesNotThrow(() => assertGlobalAgentRunPlacement(designerContext()))
})

test('an ordinary agent is untouched by the assertion', () => {
  const context = designerContext()
  context.agent.systemSlug = null
  context.channel.dmKey = null
  context.channel.systemChannelType = null

  assert.doesNotThrow(() => assertGlobalAgentRunPlacement(context))
})

test('a global agent in an ordinary channel fails with a classified placement error', () => {
  const context = designerContext()
  context.channel.dmKey = null
  context.channel.systemChannelType = null

  assert.throws(
    () => assertGlobalAgentRunPlacement(context),
    (error: unknown) =>
      error instanceof GlobalAgentPlacementError
      && classifyError(error) === 'global_agent_placement',
  )
})

test('a global agent may not run in another organisation home, or another blueprint home', () => {
  const foreignOrg = designerContext()
  foreignOrg.channel.dmKey = `gagent:agent-designer:${id('a')}:${id('2')}`
  assert.throws(() => assertGlobalAgentRunPlacement(foreignOrg), GlobalAgentPlacementError)

  const foreignSlug = designerContext()
  foreignSlug.channel.dmKey = `gagent:librarian:${id('4')}:${id('2')}`
  assert.throws(() => assertGlobalAgentRunPlacement(foreignSlug), GlobalAgentPlacementError)
})

test('a trigger thread is not an allowed surface for a global agent', () => {
  // Unlike the private-agent rule: v1 blueprints declare
  // `allowsSelfTriggers: false`, so a trigger thread here is only ever a
  // leftover row and must not reach inference.
  const context = designerContext()
  context.channel.dmKey = null
  context.channel.systemChannelType = null
  context.run.trigger = { agentId: context.agent.id, targetThreadId: context.run.threadId }

  assert.throws(() => assertGlobalAgentRunPlacement(context), GlobalAgentPlacementError)
})

test('a slug this deployment no longer defines fails closed', () => {
  const context = designerContext()
  context.agent.systemSlug = 'withdrawn-blueprint'
  context.channel.dmKey = `gagent:withdrawn-blueprint:${id('4')}:${id('2')}`

  assert.throws(() => assertGlobalAgentRunPlacement(context), GlobalAgentPlacementError)
})
