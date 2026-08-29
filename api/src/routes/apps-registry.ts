import { syncRegistry, type RegistrySyncProgress } from '@nessie/mcp-manage'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'

import type { RouteDeps } from './types.js'

/**
 * Owner controls for filling the App Store from the official MCP Registry
 * (`docs/plans/2026-08-29-mcp-app-store/`, Phase 3).
 *
 * The ingestion itself lives in `@nessie/mcp-manage` because the worker must be
 * able to run it too; these handlers only decide who may ask, whether a sweep is
 * already running, and what the answer looks like. Nothing here parses a
 * registry record, and nothing here fetches: the shared service owns the Zod
 * validation, the SSRF guard on every advertised endpoint, the http(s)-only
 * check on every URL-shaped field, and the `safeFetch` egress.
 *
 * `/apps` is a member surface; this is not. A sync writes instance-global
 * catalogue rows that everyone then sees, so both routes are `requireOwner`.
 */

/**
 * A sweep is started in the background and the request returns immediately with
 * the run id — the other option in the phase brief, a small bounded page budget
 * run inline, was rejected: the registry walk has no persisted cursor, so a
 * capped run always re-walks the same first N pages. Ten clicks would ingest
 * 200 apps ten times over rather than 2,000 apps once. Progress is therefore
 * reported by `GET .../sync-status` rather than by this response, and the run
 * id is what lets a caller pick its own row out of that list.
 */
const RUN_ID_WAIT_MS = 5_000

/**
 * A run row is claimed by the sweep that created it and released when it writes
 * `completedAt`. A process that dies mid-sweep can never write that, so an
 * unbounded "is anything in flight" test would wedge the button permanently;
 * past this window an abandoned row stops blocking. It is generous on purpose —
 * a full sweep of ~60 pages is minutes, not seconds, and cutting it short would
 * let a second sweep race a live one.
 */
const STALE_SYNC_RUN_MS = 30 * 60_000

/**
 * Enough failing records to tell "the registry changed shape" from "one poison
 * row", which is the only decision this sample drives. The full capped list
 * lives on the run row for anyone who needs it.
 */
const FAILURE_SAMPLE_SIZE = 5

const DEFAULT_STATUS_LIMIT = 10

const SyncRequestSchema = z
  .object({
    // A cap for a deliberately short sweep (a smoke test after a deploy).
    // Omitted means the service's own full walk.
    maxPages: z.number().int().min(1).max(500).optional(),
  })
  .strict()

const SyncStatusQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(DEFAULT_STATUS_LIMIT),
})

const SYNC_RUN_SELECT = {
  id: true,
  source: true,
  startedAt: true,
  completedAt: true,
  serversFetched: true,
  serversCreated: true,
  serversUpdated: true,
  serversFailed: true,
  iconsCached: true,
  error: true,
  failures: true,
} as const

type SyncRunRow = {
  id: string
  source: string
  startedAt: Date
  completedAt: Date | null
  serversFetched: number
  serversCreated: number
  serversUpdated: number
  serversFailed: number
  iconsCached: number
  error: string | null
  failures: unknown
}

const presentSyncRun = (row: SyncRunRow) => {
  const failures = Array.isArray(row.failures) ? row.failures : []
  return {
    id: row.id,
    source: row.source,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    // Whether the last sweep took four minutes or forty is what decides
    // between clicking this button and running the CLI.
    durationMs: row.completedAt ? row.completedAt.getTime() - row.startedAt.getTime() : null,
    serversFetched: row.serversFetched,
    serversCreated: row.serversCreated,
    serversUpdated: row.serversUpdated,
    serversFailed: row.serversFailed,
    iconsCached: row.iconsCached,
    error: row.error,
    failureCount: failures.length,
    failureSample: failures.slice(0, FAILURE_SAMPLE_SIZE),
  }
}

const createDeferred = <T>() => {
  // The executor runs synchronously, so `settle` is always replaced before the
  // constructor returns; the no-op only satisfies definite assignment.
  let settle: (value: T) => void = () => {}
  const promise = new Promise<T>((resolve) => {
    settle = resolve
  })
  return { promise, settle }
}

const resolveAfter = <T>(ms: number, value: T): Promise<T> =>
  new Promise<T>((resolve) => {
    // Unref'd so a pending wait never holds the process open on shutdown.
    setTimeout(() => resolve(value), ms).unref()
  })

export const registerAppsRegistryRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const { prisma, requireActorContext, requireOwner } = deps

  /**
   * Two guards, because neither alone is enough. The in-process handle catches
   * the case that actually happens — one owner double-clicking, or two owners
   * on the same replica — with no race at all. The database check catches a
   * sweep started elsewhere: another API replica, or the `sync:registry` CLI.
   * That second check has a millisecond-wide window (the service creates its
   * own run row, so this route cannot claim one atomically before calling it),
   * which the first check closes for every same-process collision.
   */
  let localSweep: Promise<unknown> | null = null

  const findActiveRun = async () =>
    prisma.mcpRegistrySyncRun.findFirst({
      where: {
        completedAt: null,
        startedAt: { gt: new Date(Date.now() - STALE_SYNC_RUN_MS) },
      },
      orderBy: { startedAt: 'desc' },
      select: { id: true, startedAt: true },
    })

  app.post('/api/admin/mcp-registry/sync', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const body = parseInput(SyncRequestSchema, request.body ?? {}, reply)
    if (!body) return reply

    if (localSweep) {
      sendApiError(
        reply,
        409,
        'REGISTRY_SYNC_IN_PROGRESS',
        'A registry sync is already running on this server',
      )
      return reply
    }

    const active = await findActiveRun()
    if (active) {
      sendApiError(
        reply,
        409,
        'REGISTRY_SYNC_IN_PROGRESS',
        'A registry sync started at '
          + `${active.startedAt.toISOString()} has not finished yet`,
        undefined,
        { runId: active.id },
      )
      return reply
    }

    // The first progress event names the run, which is all this response owes
    // the caller — the counts belong to `sync-status`, where they stay correct
    // as the sweep continues.
    const firstProgress = createDeferred<string | null>()
    const sweep = syncRegistry(prisma, {
      maxPages: body.maxPages,
      onProgress: (progress: RegistrySyncProgress) => {
        firstProgress.settle(progress.runId)
      },
    })

    localSweep = sweep
      .catch((error: unknown) => {
        // The sweep outlives this request, so its failure has nowhere to be
        // returned; the run row carries the error and the log carries the stack.
        request.log.error({ err: error }, 'mcp_registry_sync_failed')
      })
      .finally(() => {
        localSweep = null
        // Release a waiter that never saw a page (an empty or unreachable
        // registry) rather than making it serve out the full timeout.
        firstProgress.settle(null)
      })

    const runId = await Promise.race([
      firstProgress.promise,
      resolveAfter(RUN_ID_WAIT_MS, null),
    ])

    return reply.code(202).send(
      createApiResponse({
        started: true,
        // Null when the sweep had not reported a page within the wait; the run
        // is still running, and `sync-status` names it.
        runId,
        maxPages: body.maxPages ?? null,
      }),
    )
  })

  app.get('/api/admin/mcp-registry/sync-status', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireOwner(actorContext, reply)) return reply

    const query = parseInput(SyncStatusQuerySchema, request.query ?? {}, reply, 'query')
    if (!query) return reply

    const [runs, active] = await Promise.all([
      prisma.mcpRegistrySyncRun.findMany({
        orderBy: { startedAt: 'desc' },
        take: query.limit,
        select: SYNC_RUN_SELECT,
      }),
      findActiveRun(),
    ])

    return createApiResponse({
      // Which listed run is still moving — it disables the sync button and
      // marks the row that will keep changing.
      activeRunId: active?.id ?? null,
      runs: runs.map(presentSyncRun),
    })
  })
}
