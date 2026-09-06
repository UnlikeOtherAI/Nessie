import { disconnectPrismaClient, getPrismaClient } from '@nessie/db'
import type { PrismaClient } from '@prisma/client'
import { pathToFileURL } from 'node:url'

import { backfillProtectedMcpToolGrants } from '../services/agent-tool-policy-registry.js'
import { runRefreshCredentialSweep } from '../services/api-maintenance.js'
import {
  reconcilePersonalAssistantDefaultToolGrantsAtStartup,
} from '../services/personal-assistant-default-tool-grants.js'
import { seedDefaultPolicies } from '../services/policy-seed.js'

/**
 * The post-migrate reconcile job. Boot connects and listens — seeding, backfills
 * and reconciliation belong here, run once per deploy rather than once per
 * replica (docs/standards/horizontal-scaling.md §5). Every step is idempotent,
 * so a second run reports zero rows created.
 */
export type ReconcileSummary = {
  assistantGrantAgents: number
  assistantGrantsCreated: number
  organizations: number
  policyBindingsCreated: number
  policyRulesCreated: number
  protectedGrantAgents: number
  protectedGrantsCreated: number
}

export type ReconcileLog = (message: string) => void

export const runReconcile = async (
  prisma: PrismaClient,
  log: ReconcileLog,
): Promise<ReconcileSummary> => {
  // Default policy rules. Every organisation, one advisory-locked transaction
  // each, so the login path that seeds a freshly materialized organisation and
  // this job serialise on the same lock instead of racing.
  const organizations = await prisma.organization.findMany({
    select: {
      id: true,
      members: { select: { userId: true }, take: 1, where: { role: 'owner' } },
    },
  })
  let policyRulesCreated = 0
  let policyBindingsCreated = 0
  for (const organization of organizations) {
    // Attribute to the organisation's owner; an organisation with no owner yet
    // is attributed to itself, which is what the startup self-heal did.
    const createdBy = organization.members[0]?.userId ?? organization.id
    const seeded = await prisma.$transaction((tx) =>
      seedDefaultPolicies(tx, organization.id, createdBy))
    policyRulesCreated += seeded.rulesCreated
    policyBindingsCreated += seeded.bindingsCreated
  }
  log(
    `policy defaults: ${organizations.length} organisation(s), `
    + `${policyRulesCreated} rule(s) and ${policyBindingsCreated} binding(s) created`,
  )

  // The worker requires a descriptor-bound ToolGrant for protected MCP tools.
  // Completing the legacy Agent.toolPolicy migration here — before the rollout
  // — keeps existing Linear/DeepWater access from lapsing for a startup window.
  const protectedGrants = await backfillProtectedMcpToolGrants(prisma)
  log(
    `protected MCP tool grants: ${protectedGrants.grantCount} grant(s) across `
    + `${protectedGrants.agentCount} agent(s)`,
  )

  const assistantGrants = await reconcilePersonalAssistantDefaultToolGrantsAtStartup(prisma)
  log(
    `personal-assistant default grants: ${assistantGrants.grantCount} grant(s) across `
    + `${assistantGrants.agentCount} assistant(s)`,
  )

  await runRefreshCredentialSweep(prisma, true)
  log('expired refresh credentials swept')

  return {
    assistantGrantAgents: assistantGrants.agentCount,
    assistantGrantsCreated: assistantGrants.grantCount,
    organizations: organizations.length,
    policyBindingsCreated,
    policyRulesCreated,
    protectedGrantAgents: protectedGrants.agentCount,
    protectedGrantsCreated: protectedGrants.grantCount,
  }
}

/**
 * CLI runner for the reconcile job. Invoke with:
 *   pnpm --filter @nessie/api reconcile
 */
const main = async (): Promise<void> => {
  const prisma = getPrismaClient()
  try {
    await runReconcile(prisma, (message) => {
      console.log(`[reconcile] ${message}`)
    })
  } finally {
    await disconnectPrismaClient()
  }
}

// Only run when this module IS the entrypoint — `startApiServer` imports
// `runReconcile` for the local-mode boot, and importing must not run the job.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('Reconcile failed:', error)
    process.exitCode = 1
  })
}
