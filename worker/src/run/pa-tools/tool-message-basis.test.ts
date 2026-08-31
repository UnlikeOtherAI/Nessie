import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { BuiltinToolRuntimeContext } from '../tool-types.js'
import { createConsumedSourceSink } from '../execute/disclosure-basis.js'
import { resolveToolPostBasis } from './tool-message-basis.js'

const contextWith = (
  targetBoundAgentIds: readonly string[],
  queriedChannelIds: string[],
): Pick<BuiltinToolRuntimeContext, 'channel' | 'consumedSources' | 'prisma'> => {
  const consumedSources = createConsumedSourceSink()
  consumedSources.add({ scopeId: 'agent-target', scopeType: 'agent' })
  return {
    channel: { id: 'run-channel', organizationId: 'org-1' as never },
    consumedSources,
    prisma: {
      agentBinding: {
        findMany: async (args: { where: { channelId: string } }) => {
          queriedChannelIds.push(args.where.channelId)
          return targetBoundAgentIds.map((agentId) => ({ agentId }))
        },
      },
      channel: {
        findUnique: async () => ({ projectId: 'project-target', teamId: 'team-target' }),
      },
    } as unknown as BuiltinToolRuntimeContext['prisma'],
  }
}

test('tool posting subtracts agents bound to its target channel, not the run channel', async () => {
  const queriedChannelIds: string[] = []
  const basis = await resolveToolPostBasis(
    contextWith(['agent-target'], queriedChannelIds),
    'target-channel',
  )

  assert.deepEqual(basis, [])
  assert.deepEqual(queriedChannelIds, ['target-channel'])
})

test('tool posting retains an agent scope when its target channel is unbound', async () => {
  const basis = await resolveToolPostBasis(contextWith([], []), 'target-channel')

  assert.deepEqual(basis, [{ scopeId: 'agent-target', scopeType: 'agent' }])
})
