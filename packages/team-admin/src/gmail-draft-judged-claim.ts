import type { PrismaClient } from '@prisma/client'

import type { JudgedGmailDraftAuthorization } from './send-authorization.js'

/**
 * Atomically reserve a judged Gmail draft for dispatch.
 *
 * The grant and connection rows are locked in the same SQL statement that
 * flips the draft to `sending`. A prior revocation wins; a later revocation
 * waits until the claim has linearized. Keeping this as SQL matters: a live
 * read followed by a normal draft update leaves a window for a revoke between
 * those two operations.
 */
export const claimJudgedGmailDraft = async (
  prisma: PrismaClient,
  input: {
    authorization: JudgedGmailDraftAuthorization
    contentFingerprint: string
    draftActionId: string
  },
): Promise<boolean> => {
  const { authorization } = input
  // This is also in the worker handler, but the shared irreversible-write
  // boundary must not rely on a caller preserving that invariant.
  if (input.contentFingerprint !== authorization.contentFingerprint) return false

  const rows = await prisma.$queryRaw<{ id: string }[]>`
    WITH live_grant AS (
      SELECT send_grant.id
      FROM "send_authorization_grants" AS send_grant
      INNER JOIN "comms_connections" AS connection_row
        ON connection_row.id = send_grant.connection_id
      WHERE send_grant.id = ${authorization.grantId}::uuid
        AND send_grant.organization_id = ${authorization.organizationId}::uuid
        AND send_grant.connection_id = ${authorization.connectionId}::uuid
        AND send_grant.agent_id = ${authorization.agentId}::uuid
        AND send_grant.mode = 'judged'::"SendAuthorizationMode"
        AND send_grant.revoked_at IS NULL
        AND (send_grant.expires_at IS NULL OR send_grant.expires_at > CURRENT_TIMESTAMP)
        AND send_grant.boundary IS NOT NULL
        AND encode(digest(send_grant.boundary, 'sha256'), 'hex') = ${authorization.boundaryHash}
        AND connection_row.id = ${authorization.connectionId}::uuid
        AND connection_row.organization_id = ${authorization.organizationId}::uuid
        AND connection_row.owner_user_id = ${authorization.requestingUserId}::uuid
        AND connection_row.status = 'active'::"CommsConnectionStatus"
      FOR UPDATE OF send_grant, connection_row
    )
    UPDATE "gmail_draft_actions" AS draft
    SET state = 'sending'::"GmailDraftActionState",
        content_fingerprint = ${input.contentFingerprint},
        send_after = NULL,
        updated_at = CURRENT_TIMESTAMP
    FROM live_grant
    WHERE draft.id = ${input.draftActionId}::uuid
      AND draft.organization_id = ${authorization.organizationId}::uuid
      AND draft.owner_user_id = ${authorization.requestingUserId}::uuid
      AND draft.connection_id = ${authorization.connectionId}::uuid
      AND draft.content_fingerprint = ${authorization.contentFingerprint}
      AND draft.state = 'draft'::"GmailDraftActionState"
    RETURNING draft.id
  `
  return rows.length === 1
}
