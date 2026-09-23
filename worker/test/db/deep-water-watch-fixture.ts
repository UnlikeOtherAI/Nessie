import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'

import { PrismaClient } from '@prisma/client'
import {
  LedgerIdentityError,
  applyDeepWaterScopeResult,
  insertDeepWaterBriefRun,
  readDeepWaterBriefRun,
  type DeepWaterBriefRun,
  type DeepWaterBriefRunOrigin,
  type LedgerIdentityService,
} from '@nessie/runtime'
import type { LedgerScopeResult, WsScope } from '@nessie/schemas'
import { personalAssistantDmKey } from '@nessie/team-admin'

import type { DeepWaterWatchDeps } from '../../src/control/deepwater-watch.js'
import type { dispatchTool } from '../../src/run/tool-dispatch.js'
import { deleteThreadQueueJobs } from './support.js'

/**
 * One tenant for the DeepWater watch suites: a requester who is an organisation
 * member, a public project channel with a thread and a bound shared agent that
 * ran once, the team's managed DeepWater connector, and scripted Ledger and
 * storage doubles. Everything the watch writes hangs off the organisation.
 */

type Answer = Record<string, unknown> | ((args: Record<string, unknown>) => Record<string, unknown>)

export type ScriptedLedger = {
  calls: Array<{ toolName: string; args: Record<string, unknown>; toolCallId: string }>
  answer: (toolName: string, structured: Answer, success?: boolean) => void
}

/** One realtime publish, as the transport received it. */
export type RecordedPublish = { scopes: WsScope[]; event: string; data: unknown; idempotencyKey?: string }

export type RecordedRealtime = {
  published: RecordedPublish[]
  /** Every publish throws while set, as a transport outage would. */
  failPublishes: (fail: boolean) => void
}

export type WatchFixture = {
  prisma: PrismaClient
  deps: DeepWaterWatchDeps
  ledger: ScriptedLedger
  realtime: RecordedRealtime
  ids: Record<
    | 'organization' | 'project' | 'team' | 'channel' | 'thread' | 'requester' | 'agent' | 'originRun' | 'connector'
    | 'assistantChannel' | 'assistantThread',
    string
  >
  identity: { subject: string; organizationId: string; teamId: string; tokenVersion: number }
  /** `true` loses the requester's link; an error is thrown as the signer's own. */
  failIdentity: (failure: boolean | LedgerIdentityError) => void
  insert: (origin: 'person' | 'agent', options?: { toolCallId?: string }) => Promise<DeepWaterBriefRun>
  attach: (runId: string, result: LedgerScopeResult) => Promise<void>
  read: (runId: string) => Promise<DeepWaterBriefRun>
  cleanup: () => Promise<void>
}

export const researchId = (): string => `rs_${randomUUID().replaceAll('-', '')}`

export const seedWatchFixture = async (): Promise<WatchFixture> => {
  process.env.LEDGER_PROXY_TOKEN = 'lk_watch_test'
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  const requester = await prisma.user.create({ data: { displayName: 'Requester', email: `dw-${suffix}@example.test` } })
  const organization = await prisma.organization.create({ data: { name: `dw-watch-${suffix}` } })
  await prisma.organizationMember.create({ data: { organizationId: organization.id, userId: requester.id, role: 'member' } })
  const project = await prisma.project.create({ data: { name: 'Research', organizationId: organization.id } })
  const team = await prisma.team.create({ data: { name: 'Research', projectId: project.id } })
  const channel = await prisma.channel.create({
    data: {
      label: 'research',
      slug: `research-${suffix}`,
      organizationId: organization.id,
      projectId: project.id,
      teamId: team.id,
    },
  })
  const thread = await prisma.thread.create({ data: { channelId: channel.id } })
  // The requester's own Personal Assistant conversation, as sign-in bootstraps it.
  const assistantChannel = await prisma.channel.create({
    data: {
      dmKey: personalAssistantDmKey({ organizationId: organization.id, userId: requester.id }),
      label: 'Personal Assistant',
      members: { create: [{ userId: requester.id }] },
      organizationId: organization.id,
      projectId: project.id,
      slug: `pa-${suffix}`,
      systemChannelType: 'personal_assistant',
      teamId: team.id,
      type: 'dm',
      visibility: 'private',
    },
  })
  const assistantThread = await prisma.thread.create({ data: { channelId: assistantChannel.id, title: 'General' } })
  const agent = await prisma.agent.create({
    data: { name: 'Analyst', organizationId: organization.id, projectId: project.id, teamId: team.id, role: 'assistant' },
  })
  await prisma.agentBinding.create({ data: { agentId: agent.id, channelId: channel.id } })
  // Terminal, so no run sweep ever picks it up.
  const originRun = await prisma.run.create({ data: { agentId: agent.id, threadId: thread.id, status: 'completed' } })
  const catalog = await prisma.mcpCatalogEntry.findFirstOrThrow({
    where: { name: 'deep-water', organizationId: null, visibility: 'public' },
    select: { id: true },
  })
  const connector = await prisma.mcpServerInstance.create({
    data: {
      catalogEntryId: catalog.id,
      credentialRef: 'LEDGER_PROXY_TOKEN',
      installedBy: requester.id,
      lifecycleState: 'active',
      organizationId: organization.id,
      scopeId: team.id,
      scopeType: 'team',
      transportConfig: { transport: 'http', url: 'https://ledger.example/v1/mcp/deepwater' },
    },
  })

  const answers = new Map<string, { structured: Answer; success: boolean }>()
  const ledger: ScriptedLedger = {
    calls: [],
    answer: (toolName, structured, success = true) => {
      answers.set(toolName, { structured, success })
    },
  }
  let identityFailure: boolean | LedgerIdentityError = false
  const ledgerIdentity: LedgerIdentityService = {
    requestHeaders: async (_attribution, options) => {
      if (identityFailure instanceof LedgerIdentityError) throw identityFailure
      if (identityFailure) throw new LedgerIdentityError('LEDGER_UOA_IDENTITY_REQUIRED', 'no linked identity')
      return { 'X-Nessie-Context': `signed:${options?.toolCallId ?? ''}` }
    },
  }
  const dispatchMcpTool: typeof dispatchTool = async (input) => {
    const toolName = input.spec.transport === 'mcp' ? input.spec.toolName : 'http'
    const headers = input.spec.transport === 'mcp' && input.spec.connection.transport !== 'stdio'
      ? input.spec.connection.headers ?? {}
      : {}
    ledger.calls.push({
      toolName,
      args: input.args as Record<string, unknown>,
      toolCallId: (headers['X-Nessie-Context'] ?? '').replace(/^signed:/, ''),
    })
    const scripted = answers.get(toolName)
    if (!scripted) throw new Error(`No scripted Ledger answer for ${toolName}`)
    const structured = typeof scripted.structured === 'function'
      ? scripted.structured(input.args as Record<string, unknown>)
      : scripted.structured
    return {
      success: scripted.success,
      output: JSON.stringify(structured),
      raw: { isError: !scripted.success, content: [], structuredContent: structured },
    }
  }
  const stored = new Map<string, Buffer>()
  const fileService: DeepWaterWatchDeps['fileService'] = {
    store: async (input) => {
      const chunks: Buffer[] = []
      for await (const chunk of input.body) chunks.push(Buffer.from(chunk as Buffer))
      const body = Buffer.concat(chunks)
      const attachment = await prisma.attachment.create({
        data: {
          organizationId: input.organizationId,
          kind: 'file',
          mime: input.mime,
          filename: input.filename,
          sizeBytes: BigInt(body.length),
          storageKey: `test/${randomUUID()}`,
        },
      })
      stored.set(attachment.id, body)
      return { attachment, bytesWritten: body.length }
    },
    delete: async (attachmentId) => {
      stored.delete(attachmentId)
      await prisma.attachment.deleteMany({ where: { id: attachmentId } })
      return true
    },
    openStream: async (attachmentId) => {
      const body = stored.get(attachmentId)
      const attachment = await prisma.attachment.findUnique({ where: { id: attachmentId } })
      return body && attachment ? { stream: Readable.from(body), attachment } : null
    },
  }

  const published: RecordedPublish[] = []
  let publishesFail = false
  const realtime: DeepWaterWatchDeps['realtime'] = {
    publishWs: async (scopes, input) => {
      if (publishesFail) throw new Error('realtime transport down')
      published.push({
        scopes,
        event: input.event,
        data: input.data,
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      })
      return { type: 'event', event: input.event, data: input.data, ts: input.ts ?? new Date().toISOString() } as never
    },
  }

  const identity = {
    subject: `uoa|${requester.id}`,
    organizationId: `uoa-org-${organization.id}`,
    teamId: `uoa-team-${team.id}`,
    tokenVersion: 2,
  }
  const ids = {
    organization: organization.id,
    project: project.id,
    team: team.id,
    channel: channel.id,
    thread: thread.id,
    requester: requester.id,
    agent: agent.id,
    originRun: originRun.id,
    connector: connector.id,
    assistantChannel: assistantChannel.id,
    assistantThread: assistantThread.id,
  }
  const read = async (runId: string): Promise<DeepWaterBriefRun> => {
    const run = await readDeepWaterBriefRun(prisma, { organizationId: organization.id, runId })
    if (!run) throw new Error(`run ${runId} is gone`)
    return run
  }
  return {
    prisma,
    deps: { prisma, ledgerIdentity, dispatchMcpTool, fileService, embeddingModel: 'test-embedding', realtime },
    ledger,
    realtime: { published, failPublishes: (fail) => { publishesFail = fail } },
    ids,
    identity,
    failIdentity: (failure) => { identityFailure = failure },
    insert: async (originKind, options = {}) => {
      const origin: DeepWaterBriefRunOrigin = originKind === 'person'
        ? { kind: 'person', actionId: randomUUID() }
        : {
            kind: 'agent',
            agentId: agent.id,
            runId: originRun.id,
            toolCallId: options.toolCallId ?? `call_${randomUUID()}`,
            principalUserId: null,
          }
      const inserted = await prisma.$transaction((tx) => insertDeepWaterBriefRun(tx, {
        organizationId: organization.id,
        teamId: team.id,
        connectorId: connector.id,
        requestedByUserId: requester.id,
        channelId: channel.id,
        threadId: thread.id,
        identity,
        input: {
          schemaVersion: 1,
          topic: 'Heat pumps in older houses',
          context: null,
          pillars: null,
          settings: { depth: 'light' },
          originRootMessageId: null,
        },
        sourceScopes: [],
        disclosureSources: [],
        origin,
      }))
      return inserted.run
    },
    attach: async (runId, result) => {
      await prisma.$transaction((tx) => applyDeepWaterScopeResult(tx, { organizationId: organization.id, runId, result }))
    },
    read,
    cleanup: async () => {
      await deleteThreadQueueJobs(prisma, thread.id)
      await deleteThreadQueueJobs(prisma, assistantThread.id)
      await prisma.$executeRawUnsafe(`DELETE FROM queue_jobs WHERE payload->>'organizationId' = $1`, organization.id)
      await prisma.runThreadPendingMessage.deleteMany({ where: { threadId: thread.id } })
      await prisma.organization.deleteMany({ where: { id: organization.id } })
      await prisma.user.deleteMany({ where: { id: requester.id } })
      await prisma.$disconnect()
    },
  }
}

/** A ScopeResult on the wire, as Ledger's research_scope_* tools answer. */
export const wireScope = (input: {
  id: string
  status?: string
  turn?: { id: string; seq: number; status: string; author_kind: 'person' | 'agent'; retryable?: boolean }
  revision?: number
  withTranscript?: boolean
}): Record<string, unknown> => ({
  id: input.id,
  status: input.status ?? 'drafting',
  error_code: null,
  title: null,
  turn: input.turn ? { error_code: null, retryable: false, ...input.turn } : null,
  brief: input.revision === undefined
    ? null
    : {
        state: 'drafting',
        revision: input.revision,
        topic: 'Heat pumps in older houses',
        reply: 'I have drafted two pillars.',
        pillars: ['Costs', 'Performance'],
        settings: {
          depth: 'light',
          chapter_depth: 'standard',
          search_quality: 'standard',
          languages: [],
          output_language: 'en',
          recency: 'any',
          writing_style: 'standard',
        },
        locked_settings: ['depth'],
        open_questions: [],
        analysis: null,
        ready: true,
        ...(input.withTranscript ? { messages: [] } : {}),
      },
})
