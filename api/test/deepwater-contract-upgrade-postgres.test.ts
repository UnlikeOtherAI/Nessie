import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import {
  DEEP_WATER_BRIEF_TOOL_NAMES,
  DEEP_WATER_LAUNCHER_TOOL_NAMES,
  DeepWaterActiveRunRevocationError,
  fingerprintMcpToolDescriptor,
  isCurrentAllowedMcpToolGrant,
  mcpToolDescriptorAnnotationsFromMetadata,
  readDeepWaterTeamConnector,
} from '@nessie/mcp-manage'
import { deepWaterBundleMarkerKey } from '@nessie/runtime'

import {
  LedgerDeepWaterActiveRunsError,
  ensureDeepWaterTeamInstance,
} from '../src/services/deepwater-activation.js'
import {
  DEEP_WATER_AGENT_ACCESS_ERROR_CODES,
  DeepWaterAgentAccessError,
  loadDeepWaterPolicyKeys,
  setDeepWaterAgentAccess,
} from '../src/services/deepwater-agent-access.js'
import {
  briefDescriptors,
  launcherTeam,
  legacyRun,
  ownerContext,
  policyOf,
  projectContract,
  registryIds,
  team,
  withSeed,
} from './deepwater-team-postgres-fixture.js'

/**
 * A team's DeepWater connector moves between Ledger tool contracts in place
 * (Water plan amendments N9, operator decision 3): shared tools keep their
 * registry ids, dropped tools leave only once no launcher run could still
 * dispatch them, and every bundle holder is granted the new bundle. A
 * connector on another contract than the manifest's reports
 * `contractOutdated` instead of being read as missing grants.
 *
 * The manifest projects the brief contract, so a team still on the launcher
 * contract is outdated until its owner's next enable
 * (`ensureDeepWaterTeamInstance`) moves it. The suites below also drive
 * `projectDeepWaterTeamContract` — the step that enable runs with the
 * manifest's descriptors — directly.
 */

withSeed('a team still on the launcher contract is outdated, and opens no brief, until it is upgraded', async (s) => {
  await launcherTeam(s)
  const access = await loadDeepWaterPolicyKeys(s.prisma, team(s))
  assert.equal(access.contractOutdated, true)
  assert.equal(access.configured, false)
  // Its launcher access is still what it was: every launcher tool is granted.
  const launcherAccess = await loadDeepWaterPolicyKeys(s.prisma, { ...team(s), contractToolNames: DEEP_WATER_LAUNCHER_TOOL_NAMES })
  assert.equal(launcherAccess.policyKeys.length, DEEP_WATER_LAUNCHER_TOOL_NAMES.length + 1)
  // Both brief creators refuse on this read, under the team lock.
  assert.deepEqual(await readDeepWaterTeamConnector(s.prisma, team(s)), {
    state: 'contract_outdated',
    instanceId: s.instanceId,
  })
})

withSeed('an upgrade that would strand an open launcher run is refused and changes nothing', async (s) => {
  const before = await launcherTeam(s)
  // An unattempted handoff, then a recoverable one that holds a Ledger ticket.
  const unattempted = await legacyRun(s, { status: 'queued' })
  await assert.rejects(projectContract(s, briefDescriptors), (error: unknown) =>
    error instanceof DeepWaterActiveRunRevocationError && error.run.id === unattempted.id)
  await s.prisma.productIntegrationRun.update({
    where: { id: unattempted.id },
    data: { status: 'running', externalRunId: `rs_${randomUUID()}` },
  })
  await assert.rejects(projectContract(s, briefDescriptors), DeepWaterActiveRunRevocationError)
  assert.deepEqual(await registryIds(s), before)
  const instance = await s.prisma.mcpServerInstance.findUniqueOrThrow({ where: { id: s.instanceId } })
  assert.deepEqual(
    (instance.discoveredTools as Array<{ name: string }>).map((tool) => tool.name).sort(),
    [...DEEP_WATER_LAUNCHER_TOOL_NAMES].sort(),
  )
})

withSeed('once the launcher run ends the upgrade keeps shared ids and re-grants every bundle holder', async (s) => {
  const before = await launcherTeam(s)
  const run = await legacyRun(s, { status: 'running', externalRunId: `rs_${randomUUID()}` })
  await assert.rejects(projectContract(s, briefDescriptors), DeepWaterActiveRunRevocationError)
  await s.prisma.productIntegrationRun.update({ where: { id: run.id }, data: { status: 'completed' } })

  assert.equal(await projectContract(s, briefDescriptors), 'upgraded')
  const after = await registryIds(s)
  assert.deepEqual([...after.keys()].sort(), [...DEEP_WATER_BRIEF_TOOL_NAMES].sort())
  for (const shared of ['research_status', 'research_report', 'research_list', 'research_cancel']) {
    assert.equal(after.get(shared), before.get(shared), `${shared} keeps its registry id`)
  }
  assert.equal(after.has('research_start'), false)

  // The Personal Assistant held the bundle marker, so it holds the new bundle,
  // each grant pinned to the descriptor the worker will authorize.
  const briefAccess = await loadDeepWaterPolicyKeys(s.prisma, { ...team(s), contractToolNames: DEEP_WATER_BRIEF_TOOL_NAMES })
  assert.equal(briefAccess.configured, true)
  const policy = await policyOf(s, s.personalAssistantId)
  assert.ok(briefAccess.policyKeys.every((key) => policy[key] === true))
  assert.equal(policy[deepWaterBundleMarkerKey(s.teamId)], true)
  const entries = await s.prisma.toolRegistryEntry.findMany({ where: { mcpInstanceId: s.instanceId } })
  const grants = await s.prisma.toolGrant.findMany({ where: { agentId: s.personalAssistantId, roleId: null } })
  for (const entry of entries) {
    const grant = grants.find((row) => row.toolId === entry.id)
    assert.ok(grant, `${entry.toolId} is granted`)
    assert.equal(isCurrentAllowedMcpToolGrant(grant, fingerprintMcpToolDescriptor({
      annotations: mcpToolDescriptorAnnotationsFromMetadata(entry.metadata),
      description: entry.description,
      inputSchema: entry.inputSchema,
      name: (entry.transportConfig as { toolName: string }).toolName,
      outputSchema: entry.outputSchema,
    })), true, `${entry.toolId} grant matches its descriptor`)
  }
  // An agent that never held the bundle is not given it.
  const sharedPolicy = await policyOf(s, s.sharedAgentId)
  assert.ok(briefAccess.policyKeys.every((key) => sharedPolicy[key] !== true))
  assert.deepEqual(await readDeepWaterTeamConnector(s.prisma, team(s)), { state: 'ready', instanceId: s.instanceId })
})

withSeed('a connector on another contract than the manifest\'s reports contractOutdated, not missing grants', async (s) => {
  await launcherTeam(s)

  const access = await loadDeepWaterPolicyKeys(s.prisma, team(s))
  assert.equal(access.contractOutdated, true)
  assert.equal(access.configured, false)
  await assert.rejects(
    setDeepWaterAgentAccess(s.prisma, { ...team(s), agentId: s.sharedAgentId, enabled: true }),
    (error: unknown) => error instanceof DeepWaterAgentAccessError
      && error.code === DEEP_WATER_AGENT_ACCESS_ERROR_CODES.CONTRACT_OUTDATED,
  )
  assert.equal((await readDeepWaterTeamConnector(s.prisma, team(s))).state, 'contract_outdated')
  // Revocation stays possible on an outdated contract.
  await setDeepWaterAgentAccess(s.prisma, { ...team(s), agentId: s.personalAssistantId, enabled: false })
  assert.notEqual((await policyOf(s, s.personalAssistantId))[deepWaterBundleMarkerKey(s.teamId)], true)
})

withSeed('enabling DeepWater again moves the team onto the manifest\'s contract, guarded the same way', async (s) => {
  await launcherTeam(s)
  const run = await legacyRun(s, { status: 'needs_setup' })

  await assert.rejects(
    ensureDeepWaterTeamInstance(s.prisma, ownerContext(s), team(s)),
    (error: unknown) => error instanceof LedgerDeepWaterActiveRunsError
      && error.code === 'LEDGER_DEEPWATER_ACTIVE_RUNS'
      && error.run.id === run.id
      && !error.message.includes('Legacy launcher research'),
  )
  await s.prisma.productIntegrationRun.update({ where: { id: run.id }, data: { status: 'failed' } })
  await ensureDeepWaterTeamInstance(s.prisma, ownerContext(s), team(s))

  const access = await loadDeepWaterPolicyKeys(s.prisma, team(s))
  assert.equal(access.contractOutdated, false)
  assert.equal(access.configured, true)
  const policy = await policyOf(s, s.personalAssistantId)
  assert.ok(access.policyKeys.every((key) => policy[key] === true), 'the bundle holder follows the contract')
  assert.deepEqual(
    [...(await registryIds(s)).keys()].sort(),
    [...DEEP_WATER_BRIEF_TOOL_NAMES].sort(),
    'the team now projects the brief contract',
  )
  assert.deepEqual(await readDeepWaterTeamConnector(s.prisma, team(s)), { state: 'ready', instanceId: s.instanceId })
})
