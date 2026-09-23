import { Prisma } from '@prisma/client'
import {
  DeepWaterRequesterIdentitySchema,
  type DeepWaterRequesterIdentity,
} from '@nessie/schemas'

import type { DeepWaterBriefDb } from './deepwater-brief-run-record.js'
import { DEEP_WATER_PRODUCT_SLUG } from './integration-runs-mapping.js'

/**
 * The requester's captured UOA identity is what the watch, the delivery and
 * every wake act with long after the request that opened the brief. It is
 * refreshed from every live action the requester takes (amendments-fable F4),
 * but only ever by the same person in the same organisation and team, and never
 * to an older login epoch: a live action can renew the capture, never
 * re-address it.
 */

/** May `incoming` replace `stored`? Same subject, organisation and team, and no older epoch. */
export const mayRefreshDeepWaterIdentity = (
  stored: DeepWaterRequesterIdentity,
  incoming: DeepWaterRequesterIdentity,
): boolean =>
  stored.subject === incoming.subject
  && stored.organizationId === incoming.organizationId
  && stored.teamId === incoming.teamId
  && incoming.tokenVersion >= stored.tokenVersion

export type DeepWaterIdentityRefresh = {
  /** The captured identity now equals `identity`. */
  refreshed: boolean
  /** A `requester_identity_changed` block was cleared by this refresh. */
  unblocked: boolean
}

/**
 * Replace the captured identity with a live one when the rule allows, and in
 * the same statement clear a `requester_identity_changed` block — the person
 * acting again is exactly the remedy that block names, so the watch resumes.
 * One conditional statement: two concurrent actions can never move the epoch
 * backwards or re-address the run.
 */
export const refreshDeepWaterRunIdentity = async (
  tx: DeepWaterBriefDb,
  input: { organizationId: string; runId: string; identity: DeepWaterRequesterIdentity },
): Promise<DeepWaterIdentityRefresh> => {
  const identity = DeepWaterRequesterIdentitySchema.parse(input.identity)
  const rows = await tx.$queryRaw<Array<{ unblocked: boolean }>>(Prisma.sql`
    WITH target AS (
      SELECT "id", "delivery_blocked_reason" = 'requester_identity_changed' AS "was_blocked"
      FROM "product_integration_runs"
      WHERE "id" = CAST(${input.runId} AS uuid)
        AND "organization_id" = CAST(${input.organizationId} AS uuid)
        AND "product_slug" = ${DEEP_WATER_PRODUCT_SLUG}
        AND "uoa_identity" IS NOT NULL
        AND "uoa_identity"->>'subject' = ${identity.subject}
        AND "uoa_identity"->>'organizationId' = ${identity.organizationId}
        AND "uoa_identity"->>'teamId' = ${identity.teamId}
        AND ("uoa_identity"->>'tokenVersion')::integer <= ${identity.tokenVersion}
      FOR UPDATE
    )
    UPDATE "product_integration_runs" AS r
    SET "uoa_identity" = CAST(${JSON.stringify(identity)} AS jsonb),
        "delivery_blocked_reason" = CASE
          WHEN target."was_blocked" THEN NULL
          ELSE r."delivery_blocked_reason"
        END,
        "updated_at" = CURRENT_TIMESTAMP
    FROM target
    WHERE r."id" = target."id"
    RETURNING COALESCE(target."was_blocked", false) AS "unblocked"
  `)
  const row = rows[0]
  return { refreshed: row !== undefined, unblocked: row?.unblocked ?? false }
}
