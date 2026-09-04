/**
 * Binds the dashboard tools to the shared services.
 *
 * The services live in `@nessie/dashboard` precisely so this file can call the
 * same functions the API routes call. The actor is resolved from the LIVE
 * OrganizationMember row on every call, never from the run's enqueue-time
 * snapshot, so a membership deactivated after a run was queued cannot keep
 * acting.
 */

import type { PrismaClient } from '@prisma/client'
import {
  applyDashboardDelta,
  createDashboard,
  createDashboardMembership,
  createDashboardSource,
  importStaticDashboardSource,
  createEmbedPlacement,
  freezeWidgetSnapshot,
  getDashboardWithWidgets,
  listDashboardSources,
  listDashboardsForActor,
  loadWidgetProjection,
  probeSource,
  resolveDashboardActor,
  setSourceCredential,
  type CredentialStore,
  type DashboardContext,
  type DashboardEgressPolicy,
} from '@nessie/dashboard'
import type { DashboardLayout, DashboardDeltaOperation } from '@nessie/schemas'
import type { FileService } from '@nessie/runtime'
import type { BuiltinToolRuntimeContext } from '../tool-types.js'
import { randomUUID } from 'node:crypto'

export type DashboardToolServices = {
  prisma: PrismaClient
  fileService: FileService
  credentials: CredentialStore
  listDashboardsForActor: typeof listDashboardsForActor
  createDashboard: typeof createDashboard
  getDashboardWithWidgets: typeof getDashboardWithWidgets
  listDashboardSources: typeof listDashboardSources
  createDashboardSource: typeof createDashboardSource
  importStaticSource: (
    context: DashboardContext,
    input: Parameters<typeof importStaticDashboardSource>[1],
  ) => ReturnType<typeof importStaticDashboardSource>
  freezeWidgetSnapshot: typeof freezeWidgetSnapshot
  createEmbedPlacement: typeof createEmbedPlacement
  probeSource: typeof probeSource
  setSourceCredential: typeof setSourceCredential
  applyDelta: (
    context: DashboardContext,
    input: {
      dashboardId: string
      baseRevision: number
      mutationId?: string
      operations: DashboardDeltaOperation[]
      runId: string
    },
  ) => ReturnType<typeof applyDashboardDelta>
  loadWidgetProjection: (
    context: DashboardContext,
    widgetId: string,
  ) => ReturnType<typeof loadWidgetProjection>
  saveLayout: (
    context: DashboardContext,
    input: {
      dashboardId: string
      layout: DashboardLayout
      dashboard: Awaited<ReturnType<typeof getDashboardWithWidgets>>
    },
  ) => Promise<void>
}

export class DashboardToolUnavailable extends Error {}

export const buildDashboardContext = async (
  context: BuiltinToolRuntimeContext,
  services: DashboardToolServices,
): Promise<DashboardContext> => {
  const organizationId = context.actorContext?.tenant?.organizationId
  const userId = context.actorContext?.actor?.actorId
  if (!organizationId || !userId) {
    throw new DashboardToolUnavailable(
      'This run has no acting user, so it cannot manage dashboards.',
    )
  }

  const actor = await resolveDashboardActor(services.prisma, {
    organizationId,
    userId,
    ...(context.agentId ? { agentId: context.agentId } : {}),
  })
  if (!actor) {
    throw new DashboardToolUnavailable(
      'The account this run acts for is no longer an active member of this organisation.',
    )
  }

  return {
    prisma: services.prisma,
    membership: createDashboardMembership(services.prisma),
    actor,
  }
}

/**
 * The deployment's own origins, denied as dashboard sources. Read from env here
 * because the worker has no route-level config object to thread through.
 */
export const dashboardEgressPolicyFromEnv = (): DashboardEgressPolicy => ({
  deniedOrigins: [
    process.env.NESSIE_API_PUBLIC_URL,
    process.env.NESSIE_ADMIN_PUBLIC_URL,
  ].filter((value): value is string => Boolean(value)),
})

/**
 * Saves through the one versioned delta path used by the route. An agent's
 * move therefore participates in the same conflict and replay guarantees.
 */
export const buildSaveLayout = (): DashboardToolServices['saveLayout'] =>
  async (context, input) => {
    await applyDashboardDelta(context, {
      dashboardId: input.dashboardId,
      schemaVersion: 1,
      mutationId: randomUUID(),
      baseRevision: input.dashboard.revision,
      operations: [{ type: 'set_layout', layout: input.layout }],
    }, {
      authorType: 'agent',
    })
  }

export const createDashboardToolServices = (input: {
  prisma: PrismaClient
  fileService: FileService
  credentials: CredentialStore
  loadDataset: (organizationId: string) => (attachmentId: string) => Promise<unknown>
}): DashboardToolServices => ({
  prisma: input.prisma,
  fileService: input.fileService,
  credentials: input.credentials,
  listDashboardsForActor,
  createDashboard,
  getDashboardWithWidgets,
  listDashboardSources,
  createDashboardSource,
  importStaticSource: (context, staticInput) =>
    importStaticDashboardSource(context, staticInput, input.fileService),
  freezeWidgetSnapshot,
  createEmbedPlacement,
  probeSource,
  setSourceCredential,
  applyDelta: (context, delta) => applyDashboardDelta(context, {
    dashboardId: delta.dashboardId,
    schemaVersion: 1,
    mutationId: delta.mutationId ?? randomUUID(),
    baseRevision: delta.baseRevision,
    operations: delta.operations,
  }, { authorType: 'agent', runId: delta.runId }),
  loadWidgetProjection: (context, widgetId) =>
    loadWidgetProjection(context, {
      widgetId,
      loadDataset: input.loadDataset(context.actor.organizationId),
    }),
  saveLayout: buildSaveLayout(),
})

/**
 * Lazily builds the tool services from deployment config.
 *
 * The dispatcher has no FileService on its context (it never needed one before
 * dashboards), so this constructs the same chokepoint the worker's entry point
 * builds and memoizes it — one per process, not one per tool call.
 */
let cachedServices: DashboardToolServices | null = null

export const resolveDashboardToolServices = async (
  prisma: PrismaClient,
): Promise<DashboardToolServices> => {
  if (cachedServices) return cachedServices

  const [{ loadConfig }, runtime, mcpManage, schemas] = await Promise.all([
    import('@nessie/config'),
    import('@nessie/runtime'),
    import('@nessie/mcp-manage'),
    import('@nessie/schemas'),
  ])
  const config = loadConfig()
  const fileService = runtime.createFileService({
    prisma,
    storage: runtime.getStorage(config.storage),
    maxUploadBytes: config.storage.maxUploadBytes,
  })
  const resolver = mcpManage.createPgSecretResolver(prisma, config.auth.secret ?? '')

  const credentials: CredentialStore = {
    put: async (_organizationId, plaintext) =>
      mcpManage
        .createPgSecretStore(prisma, config.auth.secret ?? '', {
          refPrefix: 'secret_dashboard_',
        })
        .put({ accessToken: plaintext }),
    // Namespaced so a dashboard tool can never resolve an MCP OAuth token.
    resolve: async (ref) =>
      ref.startsWith('secret_dashboard_') ? resolver.resolve(ref) : null,
    delete: async (ref) => {
      await prisma.mcpOAuthSecret.deleteMany({ where: { ref } }).catch(() => undefined)
    },
  }

  cachedServices = createDashboardToolServices({
    prisma,
    fileService,
    credentials,
    loadDataset: (organizationId) => async (attachmentId) => {
      const opened = await fileService.openStream(attachmentId, organizationId)
      if (!opened) return null
      const chunks: Buffer[] = []
      let total = 0
      for await (const chunk of opened.stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
        total += buffer.byteLength
        if (total > schemas.DASHBOARD_MAX_DATASET_BYTES) {
          opened.stream.destroy()
          throw new Error('stored dataset exceeds the size cap')
        }
        chunks.push(buffer)
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    },
  })
  return cachedServices
}
