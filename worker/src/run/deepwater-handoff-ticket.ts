import type { DeepWaterStartTicketStatus } from '@nessie/runtime'

import type { ToolDispatchResult } from './tool-dispatch.js'

const LEDGER_RESEARCH_TICKET_PATTERN = /^rs_[A-Za-z0-9_-]+$/
const DEEP_WATER_TICKET_STATUSES = new Set<DeepWaterStartTicketStatus>([
  'running',
  'complete',
  'failed',
  'cancelled',
  'timed_out',
])

export type LedgerResearchTicket = {
  id: string
  status: DeepWaterStartTicketStatus
}

export const isLedgerResearchTicketId = (value: string): boolean =>
  LEDGER_RESEARCH_TICKET_PATTERN.test(value)

export const persistedTicketResult = (
  externalRunId: string,
  status: DeepWaterStartTicketStatus,
): ToolDispatchResult => {
  const structuredContent = { id: externalRunId, job_id: externalRunId, status }
  return {
    output: JSON.stringify(structuredContent),
    raw: { content: [], isError: false, structuredContent },
    success: true,
  }
}

export const ledgerResearchTicket = (
  result: ToolDispatchResult,
): LedgerResearchTicket | null => {
  if (!result.success || !result.raw || typeof result.raw !== 'object') return null
  const structured = (result.raw as { structuredContent?: unknown }).structuredContent
  if (!structured || typeof structured !== 'object' || Array.isArray(structured)) return null
  const record = structured as Record<string, unknown>
  if (
    typeof record.id !== 'string'
    || typeof record.job_id !== 'string'
    || record.id !== record.job_id
    || !isLedgerResearchTicketId(record.id)
  ) {
    return null
  }
  return typeof record.status === 'string'
    && DEEP_WATER_TICKET_STATUSES.has(record.status as DeepWaterStartTicketStatus)
    ? { id: record.id, status: record.status as DeepWaterStartTicketStatus }
    : null
}

/**
 * Ledger can return an MCP error after it has already created a research row
 * (for example `upstream_rejected` or any 5xx). Those outcomes must retry with
 * the stable idempotency identity so Ledger can return the existing ticket.
 * Only these Ledger-local, pre-creation rejections are definitive.
 */
export const isDefinitiveLedgerStartRejection = (
  result: ToolDispatchResult,
): boolean => {
  if (result.success || !result.raw || typeof result.raw !== 'object') return false
  const raw = result.raw as { isError?: unknown; structuredContent?: unknown }
  if (raw.isError !== true) return false
  if (
    !raw.structuredContent
    || typeof raw.structuredContent !== 'object'
    || Array.isArray(raw.structuredContent)
  ) {
    return false
  }
  const error = raw.structuredContent as Record<string, unknown>
  const code = error.error
  const statusCode = error.status_code
  return (code === 'invalid_request' && (statusCode === 400 || statusCode === 401))
    || (code === 'budget_exceeded' && statusCode === 402)
    || (code === 'forbidden' && statusCode === 403)
}
