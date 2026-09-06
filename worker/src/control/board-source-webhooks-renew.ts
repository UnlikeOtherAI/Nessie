import { createHash, randomUUID } from 'node:crypto'

import { sealSecret } from '@nessie/runtime'

import { AdapterNotRegisteredError, resolveBoardSourceAdapter } from '@nessie/board-sources'
import {
  isBoardSourceCredentialError,
  loadBoardSourceConnectionContext,
} from '@nessie/team-admin'

import { buildWebhookCallback, type BoardSourceSyncDeps } from './board-source-sync.js'

/**
 * Re-register webhooks that are about to expire.
 *
 * Jira is why this exists: its webhooks die after 30 days, and a source whose
 * webhook lapsed keeps working — it falls back to its polling interval — but
 * silently loses the fast path. A capability that degrades quietly is the thing
 * the health standard was written after, so this keeps it from happening rather
 * than waiting for somebody to notice their board is five minutes stale.
 *
 * A provider whose registration does not expire — Linear and GitHub both mint
 * one that lives until it is deleted — leaves `webhookExpiresAt` null and never
 * appears here.
 */
export const renewBoardSourceWebhooks = async (
  deps: BoardSourceSyncDeps,
  input: { withinMs: number },
): Promise<{ renewed: number }> => {
  const { prisma } = deps
  if (!deps.publicApiUrl) return { renewed: 0 }

  const due = await prisma.boardSource.findMany({
    where: {
      webhookExpiresAt: { not: null, lte: new Date(Date.now() + input.withinMs) },
      healthState: { notIn: ['paused', 'owner_inactive'] },
    },
    take: 50,
  })

  let renewed = 0
  for (const source of due) {
    let adapter
    try {
      adapter = resolveBoardSourceAdapter(source.provider)
    } catch (cause) {
      if (cause instanceof AdapterNotRegisteredError) continue
      throw cause
    }

    const context = await loadBoardSourceConnectionContext(
      prisma,
      source.connectionId,
      deps.encryptionSecret,
    )
    if (isBoardSourceCredentialError(context)) continue

    // A fresh token every time: a renewal that reused the old one would keep a
    // callback URL alive after a leak rather than rotating away from it.
    const token = randomUUID()
    try {
      const registration = await adapter.ensureWebhook(
        context,
        source.container as Record<string, unknown>,
        buildWebhookCallback(deps, source.provider, token),
      )
      if (!registration) continue
      await prisma.boardSource.update({
        where: { id: source.id },
        data: {
          webhookExternalId: registration.externalId,
          webhookExpiresAt: registration.expiresAt ? new Date(registration.expiresAt) : null,
          webhookTokenHash: createHash('sha256').update(token).digest('hex'),
          webhookSecretCiphertext: registration.signingSecret
            ? sealSecret(deps.encryptionSecret, registration.signingSecret)
            : null,
        },
      })
      renewed += 1
    } catch {
      // The board still syncs by polling, so a failed renewal is not an outage.
      // Clearing the expiry stops this sweep retrying it every tick; the next
      // successful sync re-registers from scratch.
      await prisma.boardSource.update({
        where: { id: source.id },
        data: {
          webhookExternalId: null,
          webhookExpiresAt: null,
          webhookTokenHash: null,
          webhookSecretCiphertext: null,
        },
      })
    }
  }
  return { renewed }
}
