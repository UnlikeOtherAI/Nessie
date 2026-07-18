import { createHash } from 'node:crypto'

import type { LedgerAttribution } from './ledger.js'

export type CompleteLedgerAttribution = LedgerAttribution & {
  agentId: string
  organizationId: string
  runId: string
  teamId: string
  userId: string
}

export class LedgerAttributionError extends Error {
  readonly code = 'LEDGER_ATTRIBUTION_REQUIRED'

  constructor(fields: string[]) {
    super(
      `Ledger-routed requests require non-empty ${fields.join(', ')} attribution.`,
    )
    this.name = 'LedgerAttributionError'
  }
}

const deterministicUuid = (value: string): string => {
  const bytes = Buffer.from(createHash('sha256').update(value).digest().subarray(0, 16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-')
}

const nonEmpty = (value: string | null | undefined): value is string =>
  typeof value === 'string' && value.trim().length > 0

/**
 * Complete a user-triggered system AI call with stable UUID identities.
 *
 * Real agent/run ids always win. A call without either must name its system
 * component and carry a stable request/job key; the derived UUIDs are valid in
 * Nessie's local usage ledger while `systemComponent` keeps the signed context
 * human-readable to Ledger.
 */
export const completeLedgerAttribution = (
  attribution: LedgerAttribution,
  fallbackSystemComponent?: string,
): CompleteLedgerAttribution => {
  const systemComponent =
    attribution.systemComponent?.trim()
    || fallbackSystemComponent?.trim()
    || null
  const runKey =
    attribution.requestId?.trim()
    || attribution.correlationId?.trim()
    || null
  const userId = attribution.userId?.trim() || null
  const teamId = attribution.teamId?.trim() || null
  const organizationId = attribution.organizationId.trim()
  const agentId =
    attribution.agentId?.trim()
    || (
      systemComponent
        ? deterministicUuid(`nessie:ledger:system-agent:${systemComponent}`)
        : null
    )
  const runId =
    attribution.runId?.trim()
    || (
      systemComponent && runKey
        ? deterministicUuid(
          `nessie:ledger:system-run:${systemComponent}:${organizationId}:${teamId}:${userId}:${runKey}`,
        )
        : null
    )

  const missing: string[] = []
  if (!nonEmpty(userId)) missing.push('user_id')
  if (!nonEmpty(organizationId)) missing.push('organization_id')
  if (!nonEmpty(teamId)) missing.push('team_id')
  if (!nonEmpty(agentId)) missing.push('agent_id')
  if (!nonEmpty(runId)) missing.push('run_id')
  if (missing.length > 0) {
    throw new LedgerAttributionError(missing)
  }

  return {
    ...attribution,
    agentId: agentId as string,
    organizationId,
    runId: runId as string,
    systemComponent,
    teamId: teamId as string,
    userId: userId as string,
  }
}
