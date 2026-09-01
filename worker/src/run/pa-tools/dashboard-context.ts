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
  addWidget,
  createDashboard,
  createDashboardMembership,
  createDashboardSource,
  createEmbedPlacement,
  freezeWidgetSnapshot,
  getDashboardWithWidgets,
  listDashboardSources,
  listDashboardsForActor,
  loadWidgetProjection,
  probeSource,
  recordDashboardVersion,
  removeWidget,
  resolveDashboardActor,
  setSourceCredential,
  summarizeChange,
  updateWidget,
  validateLayout,
  type CredentialStore,
  type DashboardContext,
  type DashboardEgressPolicy,
} from '@nessie/dashboard'
import type { DashboardLayout, DashboardWidgetKind } from '@nessie/schemas'
import type { FileService } from '@nessie/runtime'
import type { BuiltinToolRuntimeContext } from '../tool-types.js'

export type DashboardToolServices = {
  prisma: PrismaClient
  fileService: FileService
  credentials: CredentialStore
  listDashboardsForActor: typeof listDashboardsForActor
  createDashboard: typeof createDashboard
  getDashboardWithWidgets: typeof getDashboardWithWidgets
  listDashboardSources: typeof listDashboardSources
  createDashboardSource: typeof createDashboardSource
  freezeWidgetSnapshot: typeof freezeWidgetSnapshot
  createEmbedPlacement: typeof createEmbedPlacement
  probeSource: typeof probeSource
  setSourceCredential: typeof setSourceCredential
  addWidget: typeof addWidget
  updateWidget: typeof updateWidget
  removeWidget: typeof removeWidget
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
 * Saves a layout the way the route does: validate against the grid and each
 * kind's size limits, then append a version. An agent's move is therefore
 * recorded and reversible exactly like a drag.
 */
export const buildSaveLayout = (
  prisma: PrismaClient,
): DashboardToolServices['saveLayout'] =>
  async (context, input) => {
    const kinds = new Map<string, DashboardWidgetKind>(
      input.dashboard.widgets.map((widget) => [widget.id, widget.kind as DashboardWidgetKind]),
    )
    validateLayout(input.layout, kinds)

    const before = {
      widgets: input.dashboard.widgets.map((widget) => ({ id: widget.id, kind: widget.kind })),
      layout: input.dashboard.layout as unknown as DashboardLayout,
    }
    const after = { widgets: before.widgets, layout: input.layout }

    await prisma.$transaction(async (tx) => {
      await tx.dashboard.update({
        where: { id: input.dashboardId },
        data: { layout: input.layout as never, revision: { increment: 1 } },
      })
      await recordDashboardVersion(tx, {
        organizationId: context.actor.organizationId,
        dashboardId: input.dashboardId,
        layout: input.layout,
        widgets: input.dashboard.widgets.map((widget) => ({
          id: widget.id,
          kind: widget.kind,
          spec: widget.spec,
        })),
        authorType: 'agent',
        authorId: context.actor.userId,
        summary: summarizeChange(before, after),
      })
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
  freezeWidgetSnapshot,
  createEmbedPlacement,
  probeSource,
  setSourceCredential,
  addWidget,
  updateWidget,
  removeWidget,
  loadWidgetProjection: (context, widgetId) =>
    loadWidgetProjection(context, {
      widgetId,
      loadDataset: input.loadDataset(context.actor.organizationId),
    }),
  saveLayout: buildSaveLayout(input.prisma),
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
