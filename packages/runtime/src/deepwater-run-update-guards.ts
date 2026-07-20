import type { ProductIntegrationRunStatus } from '@nessie/schemas'

import {
  TERMINAL_STATUSES,
  toRecord,
} from './integration-runs-mapping.js'

export type DeepWaterImmutableRunState = {
  external_run_id: string | null
  result_json: unknown
  status: ProductIntegrationRunStatus
}

export type DeepWaterResearchRunConflictField =
  | 'externalRunId'
  | 'terminalStatus'

export class DeepWaterResearchRunConflictError extends Error {
  readonly code = 'DEEP_WATER_RUN_IMMUTABLE_CONFLICT'

  constructor(public readonly field: DeepWaterResearchRunConflictField) {
    const label = {
      externalRunId: 'external run id',
      terminalStatus: 'terminal status',
    }[field]
    super(`Deep Water run ${label} is immutable; conflicting update rejected.`)
    this.name = 'DeepWaterResearchRunConflictError'
  }
}

const terminalStatusRequiredByStartTicket = (
  resultJson: unknown,
): ProductIntegrationRunStatus | null => {
  const ticketStatus = toRecord(resultJson).startTicketStatus
  if (ticketStatus === 'complete') return 'completed'
  if (
    ticketStatus === 'failed'
    || ticketStatus === 'cancelled'
    || ticketStatus === 'timed_out'
  ) {
    return 'failed'
  }
  return null
}

export const assertImmutableDeepWaterUpdate = (
  current: DeepWaterImmutableRunState,
  input: {
    externalRunId: string | null
    status: ProductIntegrationRunStatus | null
  },
): void => {
  if (
    current.external_run_id
    && input.externalRunId
    && current.external_run_id !== input.externalRunId
  ) {
    throw new DeepWaterResearchRunConflictError('externalRunId')
  }

  if (
    TERMINAL_STATUSES.includes(current.status)
    && input.status
    && current.status !== input.status
  ) {
    throw new DeepWaterResearchRunConflictError('terminalStatus')
  }

  const ticketStatus = terminalStatusRequiredByStartTicket(current.result_json)
  if (ticketStatus && input.status && ticketStatus !== input.status) {
    throw new DeepWaterResearchRunConflictError('terminalStatus')
  }
}
