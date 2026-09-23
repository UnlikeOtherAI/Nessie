import { PrismaClient } from '@prisma/client'
import { deepWaterBriefTools, projectMcpToolDescriptors } from '@nessie/mcp-manage'

import type { DeepWaterRunBinderContext, DeepWaterSend } from '../../src/run/deepwater-run-binder-context.js'
import { createDeepWaterRunBinder, type DeepWaterRunBinder } from '../../src/run/deepwater-run-binder.js'
import { createConsumedSourceSink, type ConsumedSourceSink } from '../../src/run/execute/disclosure-basis.js'
import type { ToolDispatchResult } from '../../src/run/tool-dispatch.js'
import { seedWatchFixture, type WatchFixture } from './deep-water-watch-fixture.js'
import { assertGlobalQueuesQuiet, runDatabaseTest } from './support.js'

/**
 * The watch fixture's tenant, made ready for an agent's briefs: DeepWater on
 * for the team, its connector projecting the brief contract, and the shared
 * agent granted `research_scope_start` — plus a binder for that agent's run
 * and a scripted transport that records what reached Ledger.
 */

export type BinderFixture = WatchFixture & {
  sink: ConsumedSourceSink
  binder: DeepWaterRunBinder
  context: DeepWaterRunBinderContext
  /** Ledger calls the binder let through, and the answer each got. */
  sent: Array<{ toolCallId: string; args: Record<string, unknown> }>
  /** Answer the next calls with this structured result (or throw it). */
  answer: (structured: Record<string, unknown> | Error, success?: boolean) => void
  /** Runs before each answer, while the call is "at Ledger". */
  onSend: (hook: (() => Promise<void>) | null) => void
  send: DeepWaterSend
  /** A binder for the same run acting for someone else. */
  binderFor: (effectiveUserId: string) => DeepWaterRunBinder
}

export const withBinderFixture = (name: string, body: (fixture: BinderFixture) => Promise<void>): void => {
  runDatabaseTest(name, async (t) => {
    const probe = new PrismaClient()
    await assertGlobalQueuesQuiet(probe)
    await probe.$disconnect()
    const watch = await seedWatchFixture()
    t.after(() => watch.cleanup())
    const { prisma, ids } = watch

    await prisma.productTeamEnablement.create({
      data: { organizationId: ids.organization, teamId: ids.team, productSlug: 'deep-water', enabled: true },
    })
    await prisma.mcpServerInstance.update({
      where: { id: ids.connector },
      data: { discoveredTools: deepWaterBriefTools.map((tool) => ({ name: tool.name })) },
    })
    await prisma.$transaction((tx) => projectMcpToolDescriptors(tx, {
      organizationId: ids.organization,
      instance: { id: ids.connector, scopeType: 'team', scopeId: ids.team },
      descriptors: deepWaterBriefTools.map((tool) => ({
        name: tool.name, title: tool.label, description: tool.description, inputSchema: tool.inputSchema ?? {},
      })),
    }))
    await prisma.toolRegistryEntry.updateMany({
      where: { mcpInstanceId: ids.connector },
      data: { status: 'active', metadata: { requiresExplicitGrant: true } },
    })
    const entries = await prisma.toolRegistryEntry.findMany({ where: { mcpInstanceId: ids.connector } })
    await prisma.agent.update({
      where: { id: ids.agent },
      data: { toolPolicy: Object.fromEntries(entries.map((entry) => [entry.id, true])) },
    })

    const sent: BinderFixture['sent'] = []
    let next: { structured: Record<string, unknown> | Error; success: boolean } | null = null
    let hook: (() => Promise<void>) | null = null
    const send: DeepWaterSend = async (toolCallId, args) => {
      sent.push({ toolCallId, args })
      if (hook) await hook()
      if (!next) throw new Error('No scripted Ledger answer')
      if (next.structured instanceof Error) throw next.structured
      const result: ToolDispatchResult = {
        success: next.success,
        output: JSON.stringify(next.structured),
        raw: { isError: !next.success, content: [], structuredContent: next.structured },
      }
      return result
    }
    const sink = createConsumedSourceSink()
    const contextFor = (effectiveUserId: string): DeepWaterRunBinderContext => ({
      prisma,
      realtime: watch.deps.realtime,
      organizationId: ids.organization,
      teamId: ids.team,
      agentId: ids.agent,
      runId: ids.originRun,
      principalUserId: null,
      channelId: ids.channel,
      threadId: ids.thread,
      effectiveUserId,
      uoaIdentity: watch.identity,
      requesterIdentity: watch.identity,
      consumedSources: sink,
    })
    const context = contextFor(ids.requester)
    await body({
      ...watch,
      sink,
      context,
      binder: createDeepWaterRunBinder(context),
      sent,
      answer: (structured, success = true) => { next = { structured, success } },
      onSend: (next) => { hook = next },
      send,
      binderFor: (effectiveUserId) => createDeepWaterRunBinder(contextFor(effectiveUserId)),
    })
  })
}
