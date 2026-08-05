import { Prisma, type PrismaClient } from '@prisma/client'

// Utility model (spec §8).
//
// Compaction notes, checkpoint notes, and delegate sub-agents do not need the
// run's headline model. `NESSIE_UTILITY_MODEL` names a cheaper one — but it is
// used ONLY when it resolves through the run's own organization provider route,
// so the call keeps exactly the same Ledger routing, credentials, and signed
// attribution as the run's other inference. Anything else falls back to the
// run's model. Resolved once per run and pinned.

export type UtilityModel = { model: string; provider: string | null }

export const resolveUtilityModel = async (
  prisma: PrismaClient,
  input: { organizationId: string; providerKey: string | null },
): Promise<UtilityModel | null> => {
  const model = process.env['NESSIE_UTILITY_MODEL']?.trim()
  if (!model || !input.providerKey) return null

  const rows = await prisma.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`
      SELECT m.id
      FROM inference_models m
      JOIN inference_providers p ON p.id = m.provider_id
      WHERE m.organization_id = ${input.organizationId}::uuid
        AND p.provider_key = ${input.providerKey}
        AND m.model = ${model}
        AND m.enabled = true
        AND m.lifecycle_status = 'approved'
        AND p.enabled = true
        AND p.lifecycle_status = 'approved'
      LIMIT 1
    `,
  )
  if (rows.length === 0) return null

  return { model, provider: input.providerKey }
}
