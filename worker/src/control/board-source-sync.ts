import { createHash, randomBytes, randomUUID } from 'node:crypto'

import type { PrismaClient } from '@prisma/client'
import {
  AdapterNotRegisteredError,
  SourceAuthError,
  SourceContainerGoneError,
  SourceCursorExpiredError,
  SourceRateLimitedError,
  type SyncCheckpoint,
  resolveBoardSourceAdapter,
} from '@nessie/board-sources'
import {
  BOARD_SOURCE_BACKOFF_CEILING_MS,
  BOARD_SOURCE_CLAIM_TIMEOUT_MS,
} from '@nessie/schemas'
import { sealSecret } from '@nessie/runtime'
import {
  applyInboundItem,
  autoMatchItemAssignees,
  type BoardWatchEvent,
  externalTenantKeyFor,
  isBoardSourceCredentialError,
  loadBoardSourceConnectionContext,
  loadIdentityLinks,
  parseFieldMappings,
  parseStateMapping,
} from '@nessie/team-admin'

import { claimHealthTransition, clearHealth } from './board-source-health.js'

import { notifyBoardWatchers } from './board-watch-notify.js'

/**
 * Keeping a project's mirrored items current.
 *
 * The scheduling shape is the dashboard refresher's, because the problem is the
 * same one: `nextRunAt`/`claimedAt` claimed by a conditional UPDATE so two
 * workers cannot run one source at once, capped exponential backoff on
 * transient failure, and a stable `lastErrorCode` rather than an upstream
 * message. What is new is that a *durable* failure names a remedy and alerts —
 * a board that quietly stops updating still looks like a board.
 */

export type BoardSourceSyncDeps = {
  prisma: PrismaClient
  encryptionSecret: string
  /** Public callback base, for registering vendor webhooks. Null disables them. */
  publicApiUrl: string | null
  enqueueHealthAlert: (input: { sourceId: string; revision: number }) => Promise<void>
  publishBoardUpdated: (input: { organizationId: string; projectId: string }) => Promise<void>
}

/** Capped exponential backoff: 1m, 2m, 4m … up to the six-hour ceiling. */
const backoffMs = (consecutiveFailures: number): number =>
  Math.min(60_000 * 2 ** Math.min(consecutiveFailures, 9), BOARD_SOURCE_BACKOFF_CEILING_MS)

const parseCheckpoint = (value: unknown): SyncCheckpoint => {
  if (value && typeof value === 'object' && 'phase' in value) {
    return value as SyncCheckpoint
  }
  return { phase: 'initial' }
}

/** Pages per job, so one enormous first import cannot hold a worker forever. */
const MAX_PAGES_PER_JOB = 100

export const executeBoardSourceSync = async (
  deps: BoardSourceSyncDeps,
  input: { sourceId: string },
): Promise<{ applied: number; outcome: 'completed' | 'paused' | 'failed' }> => {
  const { prisma } = deps
  const source = await prisma.boardSource.findUnique({
    where: { id: input.sourceId },
    include: { connection: { select: { id: true, externalTenantId: true } } },
  })
  if (!source) return { applied: 0, outcome: 'failed' }
  if (source.healthState === 'paused') {
    await prisma.boardSource.update({
      where: { id: source.id },
      data: { claimedAt: null },
    })
    return { applied: 0, outcome: 'paused' }
  }

  const context = await loadBoardSourceConnectionContext(
    prisma,
    source.connectionId,
    deps.encryptionSecret,
  )
  if (isBoardSourceCredentialError(context)) {
    // Each of these is a state a person can act on, and the remedy differs, so
    // they are not collapsed into one "error".
    const transition =
      context.error === 'OWNER_INACTIVE'
        ? { state: 'owner_inactive' as const, reason: 'OWNER_INACTIVE' }
        : { state: 'needs_reauthorization' as const, reason: 'CREDENTIAL_REJECTED' }
    await failSource(deps, source.id, transition, { resetClaim: true })
    return { applied: 0, outcome: 'failed' }
  }

  let adapter
  try {
    adapter = resolveBoardSourceAdapter(source.provider)
  } catch (cause) {
    if (cause instanceof AdapterNotRegisteredError) {
      await failSource(
        deps,
        source.id,
        {
          state: 'misconfigured',
          reason: 'PROVIDER_NOT_CONFIGURED',
          detail: source.provider,
        },
        { resetClaim: true },
      )
      return { applied: 0, outcome: 'failed' }
    }
    throw cause
  }

  const container = source.container as Record<string, unknown>
  const tenant = {
    organizationId: source.organizationId,
    provider: source.provider,
    externalTenantKey: externalTenantKeyFor(source),
  }
  const applyContext = {
    id: source.id,
    organizationId: source.organizationId,
    projectId: source.projectId,
    provider: source.provider,
    stateMapping: parseStateMapping(source.stateMapping),
    fieldMappings: parseFieldMappings(source.fieldMappings),
    identityByExternalUserId: await loadIdentityLinks(prisma, tenant),
  }

  await prisma.boardSource.update({
    where: { id: source.id },
    data: { lastSyncStartedAt: new Date() },
  })

  let checkpoint = parseCheckpoint(source.checkpoint)
  // An initial sync is a `created` for every row — 543 of them on the first
  // real board this ran against. Nobody asked to be told that a board they
  // just connected has tickets on it, so a first sync tells nobody and the
  // watchers start from the next change.
  const initialSync = checkpoint.phase === 'initial'
  const events: BoardWatchEvent[] = []
  let applied = 0
  let unmappedState: string | null = null

  try {
    for (let page = 0; page < MAX_PAGES_PER_JOB; page += 1) {
      const result = await adapter.fetchPage(context, container, checkpoint, {
        syncWindowDays: source.syncWindowDays,
      })
      // Before the page is applied, not after: an assignee this run can
      // recognise by email must land on the very items that named them, rather
      // than on whatever changes next.
      await autoMatchItemAssignees(
        prisma,
        tenant,
        result.items,
        applyContext.identityByExternalUserId,
      )
      for (const item of result.items) {
        const outcome = await applyInboundItem(prisma, applyContext, item)
        if (outcome.applied === 'unmapped_state') {
          unmappedState = outcome.stateName
          continue
        }
        if (outcome.applied === 'created' || outcome.applied === 'updated') {
          applied += 1
          if (!initialSync && outcome.changes.length > 0) {
            events.push({
              taskId: outcome.taskId,
              projectId: source.projectId,
              organizationId: source.organizationId,
              fingerprint: outcome.fingerprint,
              changes: outcome.changes,
            })
          }
        }
      }
      checkpoint = result.checkpoint
      // Persisted after every page, so a killed worker resumes rather than
      // restarting an import that may be thousands of items long.
      await prisma.boardSource.update({
        where: { id: source.id },
        data: { checkpoint: checkpoint as unknown as object },
      })
      if (!result.hasMore) break
    }

    if (deps.publicApiUrl) await ensureWebhook(deps, adapter, context, source, container)

    if (unmappedState) {
      await failSource(
        deps,
        source.id,
        { state: 'misconfigured', reason: 'UNMAPPED_STATE', detail: unmappedState },
        { resetClaim: true, keepSchedule: true },
      )
    } else {
      await prisma.boardSource.update({
        where: { id: source.id },
        data: {
          lastSyncCompletedAt: new Date(),
          consecutiveFailures: 0,
          lastErrorCode: null,
          claimedAt: null,
          nextRunAt: new Date(Date.now() + pollingIntervalMs(adapter)),
        },
      })
      await clearHealth(prisma, source.id)
    }

    if (applied > 0) {
      await deps.publishBoardUpdated({
        organizationId: source.organizationId,
        projectId: source.projectId,
      })
    }
    // A sweep is reconciliation and may carry a backlog after an outage, so its
    // watchers hear one summary rather than one message per ticket. A webhook —
    // "this changed just now" — is the per-ticket case, and lives elsewhere.
    await notifyBoardWatchers(prisma, events, { delivery: 'sweep' })
    return { applied, outcome: 'completed' }
  } catch (cause) {
    await handleSyncFailure(deps, source, cause, adapter)
    return { applied, outcome: 'failed' }
  }
}

const pollingIntervalMs = (adapter: { incrementalPollingIntervalMs?: number }): number =>
  adapter.incrementalPollingIntervalMs ?? 15 * 60 * 1000

const ensureWebhook = async (
  deps: BoardSourceSyncDeps,
  adapter: ReturnType<typeof resolveBoardSourceAdapter>,
  context: Parameters<typeof adapter.ensureWebhook>[0],
  source: { id: string; webhookExternalId: string | null },
  container: Record<string, unknown>,
): Promise<void> => {
  if (source.webhookExternalId) return
  const token = randomUUID()
  try {
    const registration = await adapter.ensureWebhook(
      context,
      container,
      buildWebhookCallback(deps, adapter.provider, token),
    )
    // Null is the provider declining, not a failure — an ordinary member's
    // Linear key may not create webhooks, and a repository the person can read
    // but not administer has no hook to hang. The declared poll covers both,
    // and the board says which it is running on.
    if (!registration) return
    await deps.prisma.boardSource.update({
      where: { id: source.id },
      data: {
        webhookExternalId: registration.externalId,
        webhookExpiresAt: registration.expiresAt ? new Date(registration.expiresAt) : null,
        // Only the hash is stored: the token itself lives in the callback URL
        // the provider holds, and a leaked database row must not be enough to
        // forge a delivery.
        webhookTokenHash: createHash('sha256').update(token).digest('hex'),
        webhookSecretCiphertext: registration.signingSecret
          ? sealSecret(deps.encryptionSecret, registration.signingSecret)
          : null,
      },
    })
  } catch {
    // A board still syncs by polling without a webhook, so this is a
    // misconfiguration to fix rather than an outage.
    await claimHealthTransition(deps.prisma, source.id, {
      state: 'misconfigured',
      reason: 'WEBHOOK_REGISTRATION_FAILED',
    })
  }
}

/**
 * The callback one registration is made against: where the provider calls, the
 * token that identifies the source in that URL, and a signing secret offered to
 * providers that let the caller choose one. A provider that mints its own
 * ignores the offer and returns what it minted.
 *
 * A fresh token *and* a fresh secret every registration, so a re-registration
 * rotates away from a leaked callback rather than re-blessing it.
 */
export const buildWebhookCallback = (
  deps: Pick<BoardSourceSyncDeps, 'publicApiUrl'>,
  provider: string,
  token: string,
): { url: string; token: string; secret: string } => ({
  url: webhookCallbackUrl(deps.publicApiUrl ?? '', provider, token),
  token,
  secret: randomBytes(32).toString('hex'),
})

/**
 * The one place a callback URL is spelled. Trello signs `body + callbackURL`,
 * so verification rebuilds this from the delivery's own token — a second
 * spelling would verify against a URL the provider is not calling.
 */
export const webhookCallbackUrl = (
  publicApiUrl: string,
  provider: string,
  token: string,
): string => `${publicApiUrl}/api/board-sources/webhooks/${provider}/${token}`

const handleSyncFailure = async (
  deps: BoardSourceSyncDeps,
  source: { id: string; consecutiveFailures: number },
  cause: unknown,
  adapter: { incrementalPollingIntervalMs?: number },
): Promise<void> => {
  const { prisma } = deps

  // A transient budget refusal is not a health state: the board's freshness
  // simply ages while the backoff runs.
  if (cause instanceof SourceRateLimitedError) {
    const failures = source.consecutiveFailures + 1
    await prisma.boardSource.update({
      where: { id: source.id },
      data: {
        consecutiveFailures: failures,
        lastErrorCode: 'SOURCE_RATE_LIMITED',
        claimedAt: null,
        nextRunAt: new Date(Date.now() + (cause.retryAfterMs ?? backoffMs(failures))),
      },
    })
    return
  }

  // A stale cursor is recoverable by construction: drop it and re-read the
  // window on the next run.
  if (cause instanceof SourceCursorExpiredError) {
    await prisma.boardSource.update({
      where: { id: source.id },
      data: {
        checkpoint: { phase: 'initial' },
        claimedAt: null,
        nextRunAt: new Date(),
      },
    })
    return
  }

  if (cause instanceof SourceAuthError) {
    await failSource(
      deps,
      source.id,
      { state: 'needs_reauthorization', reason: 'CREDENTIAL_REJECTED' },
      { resetClaim: true },
    )
    return
  }

  if (cause instanceof SourceContainerGoneError) {
    await failSource(
      deps,
      source.id,
      { state: 'misconfigured', reason: 'CONTAINER_GONE' },
      { resetClaim: true },
    )
    return
  }

  const failures = source.consecutiveFailures + 1
  const exhausted = backoffMs(failures) >= BOARD_SOURCE_BACKOFF_CEILING_MS
  await prisma.boardSource.update({
    where: { id: source.id },
    data: {
      consecutiveFailures: failures,
      lastErrorCode: 'SOURCE_HTTP_ERROR',
      claimedAt: null,
      nextRunAt: new Date(Date.now() + backoffMs(failures)),
    },
  })
  // Only once the backoff is spent does a failing source become a thing a
  // person is told about; before that it is a hiccup that fixed itself.
  if (exhausted) {
    await failSource(
      deps,
      source.id,
      { state: 'error', reason: 'SYNC_FAILED', errorCode: 'SOURCE_HTTP_ERROR' },
      { resetClaim: false, keepSchedule: true },
    )
  }
  void adapter
}

const failSource = async (
  deps: BoardSourceSyncDeps,
  sourceId: string,
  transition: Parameters<typeof claimHealthTransition>[2],
  options: { resetClaim: boolean; keepSchedule?: boolean },
): Promise<void> => {
  if (options.resetClaim && !options.keepSchedule) {
    await deps.prisma.boardSource.update({
      where: { id: sourceId },
      data: { claimedAt: null, nextRunAt: null },
    })
  } else if (options.resetClaim) {
    await deps.prisma.boardSource.update({
      where: { id: sourceId },
      data: { claimedAt: null },
    })
  }
  const revision = await claimHealthTransition(deps.prisma, sourceId, transition)
  if (revision !== null) await deps.enqueueHealthAlert({ sourceId, revision })
}

/**
 * Claim the sources that are due. The conditional UPDATE on `claimedAt` is what
 * stops two workers running one source at once; a claim older than the timeout
 * belonged to a worker that died mid-page.
 */
export const sweepDueBoardSources = async (
  prisma: PrismaClient,
  input: { limit: number; now?: Date },
): Promise<{ sourceId: string }[]> => {
  const now = input.now ?? new Date()
  const staleClaim = new Date(now.getTime() - BOARD_SOURCE_CLAIM_TIMEOUT_MS)

  const due = await prisma.boardSource.findMany({
    where: {
      healthState: { notIn: ['paused', 'owner_inactive'] },
      nextRunAt: { lte: now },
      OR: [{ claimedAt: null }, { claimedAt: { lt: staleClaim } }],
    },
    orderBy: { nextRunAt: 'asc' },
    take: input.limit,
    select: { id: true, claimedAt: true },
  })

  const claimed: { sourceId: string }[] = []
  for (const source of due) {
    const result = await prisma.boardSource.updateMany({
      where: { id: source.id, claimedAt: source.claimedAt },
      data: { claimedAt: now },
    })
    if (result.count === 1) claimed.push({ sourceId: source.id })
  }
  return claimed
}
