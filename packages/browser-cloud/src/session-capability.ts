import type { Prisma, PrismaClient } from '@prisma/client'
import { openSecret, sealSecret } from '@nessie/runtime'

/**
 * The session capability at rest.
 *
 * A cloud browser is driven over one CDP connect URL, and that URL used to live
 * only in the worker process that opened it. A run that suspends for the
 * cross-origin write approval is re-enqueued and claimed by *any* worker, where
 * the pool held nothing: the run could not drive the browser, could not reopen
 * it (`SESSION_ALREADY_OPEN`), and the remote session billed to its TTL —
 * audit 8.1, docs/standards/horizontal-scaling.md § 1.
 *
 * So the URL is persisted, and because it is a live-session bearer capability
 * it is persisted **sealed**: the same AES-256-GCM packing executor command
 * payloads use (`sealSecret`/`openSecret`, keyed off `config.auth.secret`).
 * What an operator must assume follows from that and is stated in
 * docs/plans/2026-09-02-browserbase-cloud-browsers.md § 5a: a database read
 * plus the auth secret yields a live browser handle, until the session is
 * released or its TTL expires — which is why the columns are cleared the
 * moment the row stops being `active`, rather than at `released`.
 *
 * The origin gate rides along uninterpreted. It is not a secret, but it is the
 * input to the cross-origin write decision, so a worker that re-attaches must
 * rebuild it rather than start from an empty one that gates nothing.
 */

export type PersistedSessionCapability = {
  connectUrl: string
  /** The gate exactly as the worker serialised it; null when none is stored. */
  originGate: Prisma.JsonValue | null
}

/** Seal a connect URL for the `connect_capability_ciphertext` column. */
export const sealConnectCapability = (
  encryptionSecret: string,
  connectUrl: string,
): string => sealSecret(encryptionSecret, connectUrl)

/**
 * What a worker needs to re-attach, or null when this session cannot be driven
 * from anywhere: not `active`, past its TTL, no capability stored, or a
 * ciphertext this deployment's secret cannot open. Null is deliberately the
 * same answer for all four — the caller's job is to stop pretending it holds a
 * browser, not to explain which of them happened.
 */
export const loadSessionCapability = async (
  prisma: Pick<PrismaClient, 'cloudBrowserSession'>,
  input: { sessionId: string; encryptionSecret: string; now?: Date },
): Promise<PersistedSessionCapability | null> => {
  const row = await prisma.cloudBrowserSession.findFirst({
    where: { id: input.sessionId, status: 'active' },
    select: { connectCapabilityCiphertext: true, originGate: true, expiresAt: true },
  })
  if (!row?.connectCapabilityCiphertext) return null
  if (row.expiresAt.getTime() <= (input.now ?? new Date()).getTime()) return null
  try {
    return {
      connectUrl: openSecret(input.encryptionSecret, row.connectCapabilityCiphertext),
      originGate: row.originGate ?? null,
    }
  } catch {
    // A rotated auth secret, or a truncated column. Either way this worker
    // cannot drive the session; the gate then reads as absent, which escalates.
    return null
  }
}

/**
 * Write the gate back after it changed in the driving worker. Scoped to
 * `active` so a release racing a navigation cannot resurrect a cleared row.
 */
export const persistOriginGate = async (
  prisma: Pick<PrismaClient, 'cloudBrowserSession'>,
  input: { sessionId: string; originGate: Prisma.InputJsonValue },
): Promise<void> => {
  await prisma.cloudBrowserSession.updateMany({
    where: { id: input.sessionId, status: 'active' },
    data: { originGate: input.originGate },
  })
}
