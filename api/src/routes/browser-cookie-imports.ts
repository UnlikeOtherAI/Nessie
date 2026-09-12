import { Prisma } from '@prisma/client'
import {
  CloudBrowserUnknownOutcomeError,
  importBrowserCookies,
  isPrivateBrowserHome,
} from '@nessie/browser-cloud'
import { authorizeExecutorDaemonControlCall, ExecutorError } from '@nessie/executor-manage'
import { createMcpSecretResolver } from '@nessie/mcp-manage'
import { canonicalExecutorJson } from '@nessie/schemas'
import { BROWSER_OPEN_TOOL_ID, isExplicitToolGranted } from '@nessie/runtime'
import { createHash } from 'node:crypto'
import type { FastifyInstance, FastifyReply } from 'fastify'

import {
  BrowserCookieImportPendingBodySchema,
  BrowserCookieImportUploadBodySchema,
  CreateBrowserCookieImportBodySchema,
} from '../contracts/browser-cookie-imports.js'
import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import type { RouteDeps } from './types.js'

const MAX_IMPORT_TTL_MS = 5 * 60 * 1_000

type ImportDatabase = Pick<Prisma.TransactionClient,
  'agent' | 'agentBinding' | 'channelMember' | 'cloudBrowserConnection' | 'organizationMember' | 'thread'>

type ImportTarget = {
  agentName: string
  agentOwnerUserId: string | null
}

/**
 * Recheck every mutable authority at create, poll and upload. The import row
 * is an offer, not a durable entitlement: losing a membership, private-home
 * binding, tool grant, or personal connection invalidates it before cookies
 * cross the executor boundary.
 */
export const loadFreshPrivateImportTarget = async (
  prisma: ImportDatabase,
  input: { agentId: string; organizationId: string; threadId: string; userId: string },
): Promise<ImportTarget | null> => {
  const [home, agent, personalConnection] = await Promise.all([
    isPrivateBrowserHome(prisma, input),
    prisma.agent.findFirst({
      where: { id: input.agentId, organizationId: input.organizationId },
      select: { name: true, ownerUserId: true, toolPolicy: true },
    }),
    prisma.cloudBrowserConnection.count({
      where: {
        organizationId: input.organizationId,
        scope: 'user',
        status: 'active',
        userId: input.userId,
      },
    }),
  ])
  if (!home || !agent || personalConnection < 1
    || !isExplicitToolGranted(agent.toolPolicy, BROWSER_OPEN_TOOL_ID)) return null
  return { agentName: agent.name, agentOwnerUserId: agent.ownerUserId }
}

const daemonError = (reply: FastifyReply, error: unknown): boolean => {
  if (!(error instanceof ExecutorError)) return false
  sendApiError(reply, 401, error.code, 'The executor import request is no longer valid.')
  return true
}

type BrowserCookieImportRouteDeps = RouteDeps & {
  /** Keeps the route's signed/CAS boundary testable without a Browserbase call. */
  browserCookieImporter?: typeof importBrowserCookies
  /** Rechecked at every boundary; injectable for the isolated protocol test. */
  privateImportTargetLoader?: typeof loadFreshPrivateImportTarget
}

export const registerBrowserCookieImportRoutes = (
  app: FastifyInstance,
  deps: BrowserCookieImportRouteDeps,
): void => {
  const resolver = createMcpSecretResolver(deps.prisma, deps.authSecret ?? '')
  const cookieImporter = deps.browserCookieImporter ?? importBrowserCookies
  const loadTarget = deps.privateImportTargetLoader ?? loadFreshPrivateImportTarget

  app.post('/api/browser-cookie-imports', async (request, reply) => {
    const actor = deps.requireActorContext(request, reply)
    if (!actor || !deps.requireUserActor(actor, reply)) return reply
    const body = parseInput(CreateBrowserCookieImportBodySchema, request.body, reply)
    if (!body) return reply
    const [target, executor] = await Promise.all([
      loadTarget(deps.prisma, {
        agentId: body.agentId,
        organizationId: actor.tenant.organizationId,
        threadId: body.threadId,
        userId: actor.actor.actorId,
      }),
      deps.prisma.executor.findFirst({
        where: { id: body.executorId, organizationId: actor.tenant.organizationId },
        select: { pairingOwnerUserId: true, scopeKind: true, status: true },
      }),
    ])
    if (!target || !executor || executor.scopeKind !== 'private'
      || executor.pairingOwnerUserId !== actor.actor.actorId || executor.status !== 'online') {
      sendApiError(reply, 404, 'NOT_FOUND', 'Private browser import is not available.')
      return reply
    }
    const created = await deps.prisma.browserCookieImport.create({
      data: {
        actorId: actor.actor.actorId,
        agentId: body.agentId,
        executorId: body.executorId,
        expiresAt: new Date(Date.now() + MAX_IMPORT_TTL_MS),
        organizationId: actor.tenant.organizationId,
        origins: body.origins,
        threadId: body.threadId,
      },
      select: { expiresAt: true, id: true, state: true },
    })
    return reply.code(201).send(createApiResponse({
      expiresAt: created.expiresAt.toISOString(), id: created.id, state: created.state,
    }))
  })

  app.get('/api/browser-cookie-imports/:importId', async (request, reply) => {
    const actor = deps.requireActorContext(request, reply)
    if (!actor || !deps.requireUserActor(actor, reply)) return reply
    const { importId } = request.params as { importId: string }
    const row = await deps.prisma.browserCookieImport.findFirst({
      where: { id: importId, actorId: actor.actor.actorId, organizationId: actor.tenant.organizationId },
      select: { errorCode: true, expiresAt: true, id: true, state: true },
    })
    if (!row) {
      sendApiError(reply, 404, 'NOT_FOUND', 'Browser import not found.')
      return reply
    }
    return createApiResponse({
      errorCode: row.errorCode, expiresAt: row.expiresAt.toISOString(), id: row.id, state: row.state,
    })
  })

  app.delete('/api/browser-cookie-imports/:importId', async (request, reply) => {
    const actor = deps.requireActorContext(request, reply)
    if (!actor || !deps.requireUserActor(actor, reply)) return reply
    const { importId } = request.params as { importId: string }
    const cancelled = await deps.prisma.browserCookieImport.updateMany({
      where: { id: importId, actorId: actor.actor.actorId, organizationId: actor.tenant.organizationId, state: 'pending' },
      data: { state: 'cancelled' },
    })
    if (cancelled.count !== 1) {
      sendApiError(reply, 409, 'BROWSER_COOKIE_IMPORT_UNAVAILABLE', 'This import can no longer be cancelled.')
      return reply
    }
    return reply.code(204).send()
  })

  app.post(
    '/api/executor-daemon/browser-cookie-imports/pending',
    { config: { public: true } },
    async (request, reply) => {
    const body = parseInput(BrowserCookieImportPendingBodySchema, request.body, reply)
    if (!body) return reply
    try {
      const offer = await authorizeExecutorDaemonControlCall(deps.prisma, {
        connectionEpoch: body.connectionEpoch,
        executorId: body.executorId,
        observedAt: body.observedAt,
        payload: { connectionEpoch: body.connectionEpoch, executorId: body.executorId, observedAt: body.observedAt },
        signature: body.signature,
        type: 'browser_cookie_import.poll',
      }, async (tx) => {
        const row = await tx.browserCookieImport.findFirst({
          where: { executorId: body.executorId, expiresAt: { gt: new Date() }, state: 'pending' },
          include: { agent: { select: { name: true } } },
          orderBy: { createdAt: 'asc' },
        })
        if (!row) return null
        const target = await loadTarget(tx, {
          agentId: row.agentId,
          organizationId: row.organizationId,
          threadId: row.threadId,
          userId: row.actorId,
        })
        if (!target) return null
        return {
          destination: {
            agentName: row.agent.name,
            retention: 'Kept in your private browser until you revoke it.',
            userName: 'You',
          },
          expiresAt: row.expiresAt.toISOString(), origins: row.origins, requestId: row.id,
        }
      })
      return createApiResponse({ offer })
    } catch (error) {
      if (daemonError(reply, error)) return reply
      throw error
    }
    },
  )

  app.post(
    '/api/executor-daemon/browser-cookie-imports/upload',
    { config: { public: true } },
    async (request, reply) => {
    const body = parseInput(BrowserCookieImportUploadBodySchema, request.body, reply)
    if (!body) return reply
    const digest = `sha256:${createHash('sha256').update(canonicalExecutorJson(body.cookies)).digest('hex')}`
    if (digest !== body.payloadDigest || new Set(body.selectedOrigins).size !== body.selectedOrigins.length) {
      sendApiError(reply, 400, 'BROWSER_COOKIE_IMPORT_REJECTED', 'Selected-site import was rejected.')
      return reply
    }
    try {
      const claimed = await authorizeExecutorDaemonControlCall(deps.prisma, {
        connectionEpoch: body.connectionEpoch,
        executorId: body.executorId,
        observedAt: body.submittedAt,
        payload: {
          connectionEpoch: body.connectionEpoch, cookies: body.cookies, executorId: body.executorId,
          payloadDigest: body.payloadDigest, requestId: body.requestId,
          selectedOrigins: body.selectedOrigins, submittedAt: body.submittedAt,
        },
        signature: body.signature,
        type: 'browser_cookie_import.upload',
      }, async (tx) => {
        const row = await tx.browserCookieImport.findFirst({
          where: {
            executorId: body.executorId, id: body.requestId, expiresAt: { gt: new Date() }, state: 'pending',
          },
          include: {
            executor: { select: { organizationId: true, pairingOwnerUserId: true, scopeKind: true } },
          },
        })
        if (!row || row.executor.organizationId !== row.organizationId || row.executor.scopeKind !== 'private'
          || row.executor.pairingOwnerUserId !== row.actorId) return null
        const target = await loadTarget(tx, {
          agentId: row.agentId,
          organizationId: row.organizationId,
          threadId: row.threadId,
          userId: row.actorId,
        })
        if (!target || !body.selectedOrigins.every((origin) => row.origins.includes(origin))
          || body.cookies.imports.some((entry) => !body.selectedOrigins.includes(entry.origin))) return null
        const won = await tx.browserCookieImport.updateMany({
          where: { id: row.id, state: 'pending' },
          data: { claimedAt: new Date(), state: 'importing' },
        })
        return won.count === 1 ? { ...row, agentOwnerUserId: target.agentOwnerUserId } : null
      })
      if (!claimed) {
        sendApiError(reply, 409, 'BROWSER_COOKIE_IMPORT_UNAVAILABLE', 'This import is no longer available.')
        return reply
      }
      try {
        await cookieImporter({
          encryptionSecret: deps.encryptionKeyRing,
          prisma: deps.prisma,
          resolveSecret: (ref) => resolver.resolve(ref),
        }, {
          agentId: claimed.agentId,
          agentOwnerUserId: claimed.agentOwnerUserId,
          cookies: body.cookies.imports,
          expiresAt: claimed.expiresAt,
          organizationId: claimed.organizationId,
          threadId: claimed.threadId,
          userId: claimed.actorId,
        })
        await deps.prisma.browserCookieImport.update({
          where: { id: claimed.id }, data: { importedAt: new Date(), state: 'imported' },
        })
        return createApiResponse({ status: 'imported' as const })
      } catch (error) {
        const unknown = error instanceof CloudBrowserUnknownOutcomeError
        await deps.prisma.browserCookieImport.update({
          where: { id: claimed.id },
          data: {
            errorCode: unknown ? 'BROWSER_COOKIE_IMPORT_UNKNOWN' : 'BROWSER_COOKIE_IMPORT_FAILED',
            state: unknown ? 'unknown' : 'failed',
          },
        })
        sendApiError(reply, 409, unknown ? 'BROWSER_COOKIE_IMPORT_UNKNOWN' : 'BROWSER_COOKIE_IMPORT_FAILED', unknown
          ? 'The site may have received the import. Check the private browser before starting another.'
          : 'The site may require a manual sign-in.')
        return reply
      }
    } catch (error) {
      if (daemonError(reply, error)) return reply
      throw error
    }
    },
  )
}
