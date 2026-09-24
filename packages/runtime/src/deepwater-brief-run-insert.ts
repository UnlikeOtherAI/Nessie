import { Prisma } from '@prisma/client'
import {
  DeepWaterBriefInputSchema,
  DeepWaterDisclosureSourcesSchema,
  DeepWaterRequesterIdentitySchema,
  DeepWaterScopeStateSchema,
  DeepWaterSourceScopesSchema,
  emptyDeepWaterScopeState,
  type DeepWaterBriefInput,
  type DeepWaterDisclosureSource,
  type DeepWaterRequesterIdentity,
  type DeepWaterSourceScope,
} from '@nessie/schemas'

import {
  readDeepWaterBriefRun,
  type DeepWaterBriefDb,
  type DeepWaterBriefRun,
} from './deepwater-brief-run-record.js'
import { DEEP_WATER_PRODUCT_SLUG, compactPreview } from './integration-runs-mapping.js'

/**
 * The two ways a DeepWater brief product run comes to exist. Both write the
 * captured UOA identity and a non-null `scope_json` together (the
 * `brief_binding_shape` CHECK), and both are idempotent on their origin key, so
 * a retried request or tool call lands on the row it already created.
 *
 * These are the bare inserts. Callers run them inside the DeepWater team
 * transition lock after re-reading readiness (`@nessie/mcp-manage`
 * `createPersonDeepWaterBrief` / `claimAgentOriginRun`), which is what
 * serialises them against a team disable or a grant revocation.
 */

export type DeepWaterBriefRunOrigin =
  | {
      kind: 'person'
      /** The actionId of the request that opened the brief. */
      actionId: string
    }
  | {
      kind: 'agent'
      agentId: string
      /** The Nessie Run that called research_scope_start. */
      runId: string
      /** The provider tool-call id; retries of the same call reuse it. */
      toolCallId: string
      /** The origin Run's principal, so a wake never depends on `runId`. */
      principalUserId: string | null
    }

export type DeepWaterBriefRunInsert = {
  organizationId: string
  teamId: string
  connectorId: string
  requestedByUserId: string
  channelId: string
  threadId: string
  identity: DeepWaterRequesterIdentity
  input: DeepWaterBriefInput
  sourceScopes: DeepWaterSourceScope[]
  disclosureSources: DeepWaterDisclosureSource[]
  origin: DeepWaterBriefRunOrigin
}

export type DeepWaterBriefRunInsertResult = {
  run: DeepWaterBriefRun
  /** False when the origin key already had a row: this is a replay. */
  created: boolean
}

const originKey = (origin: DeepWaterBriefRunOrigin): string =>
  origin.kind === 'person' ? origin.actionId : origin.toolCallId

/**
 * The existing row for an origin key: a person's actionId under their own
 * user id, or an agent Run's tool call.
 */
export const findDeepWaterBriefRunByOrigin = async (
  db: DeepWaterBriefDb,
  input: { organizationId: string; requestedByUserId: string; origin: DeepWaterBriefRunOrigin },
): Promise<DeepWaterBriefRun | null> => {
  const row = await db.productIntegrationRun.findFirst({
    where: input.origin.kind === 'person'
      ? {
          organizationId: input.organizationId,
          originKind: 'person',
          originToolCallId: input.origin.actionId,
          requestedByUserId: input.requestedByUserId,
        }
      : {
          organizationId: input.organizationId,
          originKind: 'agent',
          originRunId: input.origin.runId,
          originToolCallId: input.origin.toolCallId,
        },
    select: { id: true },
  })
  return row ? readDeepWaterBriefRun(db, { organizationId: input.organizationId, runId: row.id }) : null
}

const conflictTarget = (origin: DeepWaterBriefRunOrigin): Prisma.Sql => origin.kind === 'person'
  ? Prisma.sql`("organization_id", "requested_by_user_id", "origin_tool_call_id") WHERE "origin_kind" = 'person'`
  : Prisma.sql`("organization_id", "origin_run_id", "origin_tool_call_id") WHERE "origin_kind" = 'agent'`

/**
 * Insert a `queued` brief run, or return the row its origin key already has.
 *
 * A person's brief is inserted with its opening action already in flight: the
 * request that opened it is the `scope_start` the worker is about to send.
 */
export const insertDeepWaterBriefRun = async (
  tx: DeepWaterBriefDb,
  insert: DeepWaterBriefRunInsert,
): Promise<DeepWaterBriefRunInsertResult> => {
  const identity = DeepWaterRequesterIdentitySchema.parse(insert.identity)
  const briefInput = DeepWaterBriefInputSchema.parse(insert.input)
  const sourceScopes = DeepWaterSourceScopesSchema.parse(insert.sourceScopes)
  const disclosureSources = DeepWaterDisclosureSourcesSchema.parse(insert.disclosureSources)
  const origin = insert.origin

  const now = new Date()
  const scopeState = DeepWaterScopeStateSchema.parse(origin.kind === 'person'
    ? {
        ...emptyDeepWaterScopeState(),
        pendingAction: {
          kind: 'scope_start',
          actionId: origin.actionId,
          since: now.toISOString(),
          turnId: null,
          error: null,
        },
      }
    : emptyDeepWaterScopeState())

  const agent = origin.kind === 'agent' ? origin : null
  const inserted = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    INSERT INTO "product_integration_runs" (
      "organization_id",
      "team_id",
      "product_slug",
      "requested_by_user_id",
      "connector_id",
      "channel_id",
      "thread_id",
      "status",
      "query_preview",
      "input_json",
      "result_json",
      "origin_kind",
      "origin_agent_id",
      "origin_run_id",
      "origin_tool_call_id",
      "principal_user_id",
      "uoa_identity",
      "source_scopes",
      "disclosure_sources",
      "scope_json",
      "updated_at"
    )
    VALUES (
      CAST(${insert.organizationId} AS uuid),
      CAST(${insert.teamId} AS uuid),
      ${DEEP_WATER_PRODUCT_SLUG},
      CAST(${insert.requestedByUserId} AS uuid),
      CAST(${insert.connectorId} AS uuid),
      CAST(${insert.channelId} AS uuid),
      CAST(${insert.threadId} AS uuid),
      'queued'::"ProductIntegrationRunStatus",
      ${compactPreview(briefInput.topic)},
      CAST(${JSON.stringify(briefInput)} AS jsonb),
      '{}'::jsonb,
      ${origin.kind},
      CAST(${agent?.agentId ?? null} AS uuid),
      CAST(${agent?.runId ?? null} AS uuid),
      ${originKey(origin)},
      CAST(${agent?.principalUserId ?? null} AS uuid),
      CAST(${JSON.stringify(identity)} AS jsonb),
      CAST(${JSON.stringify(sourceScopes)} AS jsonb),
      CAST(${JSON.stringify(disclosureSources)} AS jsonb),
      CAST(${JSON.stringify(scopeState)} AS jsonb),
      CURRENT_TIMESTAMP
    )
    ON CONFLICT ${conflictTarget(origin)} DO NOTHING
    RETURNING "id"::text AS "id"
  `)

  const insertedId = inserted[0]?.id
  if (insertedId) {
    const run = await readDeepWaterBriefRun(tx, { organizationId: insert.organizationId, runId: insertedId })
    if (!run) throw new Error(`DeepWater brief run ${insertedId} was not readable after insert`)
    return { run, created: true }
  }

  const existing = await findDeepWaterBriefRunByOrigin(tx, {
    organizationId: insert.organizationId,
    requestedByUserId: insert.requestedByUserId,
    origin,
  })
  if (!existing) {
    // ON CONFLICT DO NOTHING returned nothing, so a row holds this key; not
    // finding it means the lookup and the index disagree — a bug, not a race.
    throw new Error('DeepWater brief run origin key conflicted but no row holds it')
  }
  return { run: existing, created: false }
}
