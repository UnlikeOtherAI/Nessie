import { Prisma, type PrismaClient } from '@prisma/client'

import type { UoaWorkspaceDirectoryEntry } from './uoa-workspace-directory.js'

/**
 * UOA organisations map 1:1 to local Organizations, keyed by the stable UOA
 * organisation id (`Organization.externalOrgId`). A UOA login or workspace
 * switch resolves-or-creates the Organization here, under a per-external-org
 * advisory lock — never through an ambient "oldest organization" lookup
 * (the shared-org model this replaces; see
 * docs/plans/2026-07-10-slack-workspace-login-nessie.md, superseded
 * 2026-08-15). Null `externalOrgId` marks a local-mode organization
 * (bootstrap / no-SSO installs and the generic-OIDC shared org), which keeps
 * its existing behaviour byte-for-byte.
 */

/** The placeholder name used until the workspace directory supplies `orgName`. */
export const externalOrganizationPlaceholderName = (
  externalOrgId: string,
): string => `Organisation ${externalOrgId.slice(0, 8)}`

/**
 * Serialize every materialization touching one UOA organisation across
 * replicas and devices. Lock order everywhere this is used: external-org →
 * external-workspace → user-session / principal locks, so the transactions
 * that combine them can never deadlock on reversed pairs.
 */
export const lockExternalOrganization = async (
  transaction: Prisma.TransactionClient,
  externalOrgId: string,
): Promise<void> => {
  await transaction.$queryRaw(Prisma.sql`
    SELECT 1
    FROM (
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`nessie:external-org:${externalOrgId}`}, 0)
      )
    ) AS acquired
  `)
}

/**
 * Resolve-or-create the local Organization for a UOA organisation. Must run
 * with `lockExternalOrganization` already held in the same transaction. The
 * name at creation is the placeholder — the directory-driven mirror sync
 * (`syncExternalOrganizationNames`) replaces it once UOA's `orgName` is known.
 */
export const materializeExternalOrganizationInTransaction = async (
  transaction: Prisma.TransactionClient,
  externalOrgId: string,
): Promise<{ id: string }> => {
  const existing = await transaction.organization.findUnique({
    where: { externalOrgId },
    select: { id: true },
  })
  if (existing) {
    return existing
  }
  return transaction.organization.create({
    data: {
      externalOrgId,
      name: externalOrganizationPlaceholderName(externalOrgId),
    },
    select: { id: true },
  })
}

/**
 * Mirror UOA's organisation names onto the local rows. `Organization.name` for
 * a UOA org is non-authoritative display data (the profile-mirror doctrine),
 * so this runs best-effort at the two places the verified workspace directory
 * arrives — login (`syncUoaProductAccountLinks`) and the UOA refresh
 * coordinator — and only rewrites rows whose stored name differs.
 */
export const syncExternalOrganizationNames = async (
  prisma: Pick<PrismaClient, 'organization'>,
  directory: UoaWorkspaceDirectoryEntry[] | undefined,
): Promise<void> => {
  if (!directory) return
  const nameByExternalOrgId = new Map<string, string>()
  for (const entry of directory) {
    if (entry.orgName) nameByExternalOrgId.set(entry.organizationId, entry.orgName)
  }
  for (const [externalOrgId, name] of nameByExternalOrgId) {
    await prisma.organization.updateMany({
      where: { externalOrgId, name: { not: name } },
      data: { name },
    })
  }
}
