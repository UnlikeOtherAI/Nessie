import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import type { Prisma } from '@prisma/client'
import { DeepWaterActiveRunRevocationError, guardDeepWaterPolicyRevocation } from '@nessie/mcp-manage'
import { emptyDeepWaterScopeState } from '@nessie/schemas'

import {
  LedgerDeepWaterActiveRunsError,
  removeDeepWaterTeamInstance,
} from '../src/services/deepwater-activation.js'
import {
  DEEP_WATER_AGENT_ACCESS_ERROR_CODES,
  DeepWaterAgentAccessError,
  setDeepWaterAgentAccess,
} from '../src/services/deepwater-agent-access.js'
import {
  briefTeam,
  legacyRun,
  team,
  withSeed,
  type Seed,
} from './deepwater-team-postgres-fixture.js'

/**
 * Research briefs hold a team's DeepWater connector and an agent's grant the
 * way launcher runs do, but only where they must (Water plan amendments N8.3,
 * N8.4): a disable waits for every open brief and research, a per-agent
 * revocation waits only for that agent's unlaunched briefs, and the
 * updater's org-wide revocation only for launcher runs.
 */

const briefRun = (
  s: Seed,
  data: Partial<Prisma.ProductIntegrationRunUncheckedCreateInput> & { originKind: 'person' | 'agent' },
) =>
  legacyRun(s, {
    uoaIdentity: { subject: 'uoa|owner', organizationId: 'uoa-org', teamId: 'uoa-team', tokenVersion: 1 },
    scopeJson: emptyDeepWaterScopeState(),
    originToolCallId: randomUUID(),
    ...data,
  })

const revoke = (s: Seed, agentId: string) =>
  setDeepWaterAgentAccess(s.prisma, { ...team(s), agentId, enabled: false })

const blockedBy = (runId: string) => (error: unknown) =>
  error instanceof DeepWaterAgentAccessError
  && error.code === DEEP_WATER_AGENT_ACCESS_ERROR_CODES.ACTIVE_RUNS
  && error.message.includes(runId)

withSeed('a disable waits for a brief being agreed and for a launched agent research', async (s) => {
  await briefTeam(s)
  const drafting = await briefRun(s, { originKind: 'person', status: 'drafting' })
  await assert.rejects(removeDeepWaterTeamInstance(s.prisma, team(s)), (error: unknown) =>
    error instanceof LedgerDeepWaterActiveRunsError
    && error.run.id === drafting.id
    && error.run.originKind === 'person'
    && error.run.requestedByUserId === s.userId
    // The 409 names the run for the app page's Cancel, and never its topic.
    && JSON.stringify(error.details) === JSON.stringify({
      id: drafting.id, status: 'drafting', originKind: 'person', requestedByUserId: s.userId,
    })
    && !error.message.includes('/channels/'))
  await s.prisma.productIntegrationRun.update({ where: { id: drafting.id }, data: { status: 'cancelled' } })

  const running = await briefRun(s, { originKind: 'agent', originAgentId: s.sharedAgentId, status: 'running' })
  await assert.rejects(removeDeepWaterTeamInstance(s.prisma, team(s)), (error: unknown) =>
    error instanceof LedgerDeepWaterActiveRunsError && error.run.id === running.id)
  await s.prisma.productIntegrationRun.update({ where: { id: running.id }, data: { status: 'completed' } })

  const removed = await removeDeepWaterTeamInstance(s.prisma, team(s))
  assert.equal(removed.instanceId, s.instanceId)
})

withSeed('revoking an agent waits only for its own briefs that are not launched', async (s) => {
  await briefTeam(s)
  await setDeepWaterAgentAccess(s.prisma, { ...team(s), agentId: s.sharedAgentId, enabled: true })

  // Another agent's brief, a person's brief and the agent's own launched research never block.
  await briefRun(s, { originKind: 'agent', originAgentId: s.personalAssistantId, status: 'drafting' })
  await briefRun(s, { originKind: 'person', status: 'drafting' })
  await briefRun(s, { originKind: 'agent', originAgentId: s.sharedAgentId, status: 'running' })
  await revoke(s, s.sharedAgentId)

  await setDeepWaterAgentAccess(s.prisma, { ...team(s), agentId: s.sharedAgentId, enabled: true })
  const own = await briefRun(s, { originKind: 'agent', originAgentId: s.sharedAgentId, status: 'drafting' })
  await assert.rejects(revoke(s, s.sharedAgentId), blockedBy(own.id))
  await s.prisma.productIntegrationRun.update({ where: { id: own.id }, data: { status: 'running' } })
  await revoke(s, s.sharedAgentId)
})

withSeed('an open launcher run blocks every revocation; briefs never block the legacy mode', async (s) => {
  await briefTeam(s)
  const legacyGuard = () => s.prisma.$transaction((tx) =>
    guardDeepWaterPolicyRevocation(tx, { organizationId: s.organizationId, mode: { kind: 'legacy' } }))

  await briefRun(s, { originKind: 'agent', originAgentId: s.sharedAgentId, status: 'queued' })
  await briefRun(s, { originKind: 'person', status: 'drafting' })
  await legacyGuard()

  const launcher = await legacyRun(s, { status: 'needs_setup' })
  await assert.rejects(legacyGuard(), (error: unknown) =>
    error instanceof DeepWaterActiveRunRevocationError && error.run.id === launcher.id)
  await assert.rejects(revoke(s, s.personalAssistantId), blockedBy(launcher.id))
})
