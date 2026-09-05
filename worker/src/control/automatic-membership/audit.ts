/**
 * Audit for job-emitted automatic-membership events.
 *
 * `emitAuditEvent` lives in `api/src/services/audit.ts` and needs a full
 * `AuthorizedActionContext`, and the worker cannot import api services — which
 * is why the roster code lives in a package at all. So job-emitted events go
 * through `writeAuditEntry`, the chain writer `emitAuditEvent` itself wraps,
 * with an explicit system actor and the authorizing administrator recorded in
 * the metadata.
 *
 * The domain-verification challenge never appears here. It is the proof an
 * organisation controls a domain, and `REDACTED_FIELDS` covering the key name
 * is a backstop, not a licence to pass it.
 */

import { randomUUID } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'
import { writeAuditEntry } from '@nessie/db'

export type AutomaticMembershipAuditAction =
  | 'organization.automatic_membership.dns_checked'
  | 'organization.automatic_membership.domain_suspended'
  | 'organization.automatic_membership.grant_issued'
  | 'organization.automatic_membership.reconcile_finished'
  | 'organization.automatic_membership.rule_needs_reauthorization'

export const writeAutomaticMembershipAudit = async (
  prisma: PrismaClient,
  input: {
    organizationId: string
    action: AutomaticMembershipAuditAction
    resourceType: string
    resourceId: string
    outcome: 'success' | 'denied' | 'error'
    reason?: string
    metadata?: Record<string, unknown>
  },
): Promise<void> => {
  try {
    await writeAuditEntry(prisma, {
      action: input.action,
      actorId: 'automatic-membership',
      actorType: 'system',
      organizationId: input.organizationId,
      outcome: input.outcome,
      requestId: randomUUID(),
      resourceId: input.resourceId,
      resourceType: input.resourceType,
      ...(input.reason ? { reason: input.reason.slice(0, 500) } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    })
  } catch (error) {
    // Audit must never take down the work it is describing, exactly as
    // `emitAuditEvent` never throws.
    console.error('automatic membership: audit write failed', error)
  }
}
