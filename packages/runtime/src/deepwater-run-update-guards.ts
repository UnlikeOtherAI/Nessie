import { Prisma } from '@prisma/client'
import type { ProductIntegrationRunStatus } from '@nessie/schemas'

import {
  TERMINAL_STATUSES,
  toRecord,
} from './integration-runs-mapping.js'

export type DeepWaterImmutableRunState = {
  cost_amount: Prisma.Decimal | number | string | null
  cost_currency: string | null
  external_run_id: string | null
  result_json: unknown
  status: ProductIntegrationRunStatus
}

export type DeepWaterResearchRunConflictField =
  | 'bookedCost'
  | 'externalRunId'
  | 'terminalStatus'

export class DeepWaterResearchRunConflictError extends Error {
  readonly code = 'DEEP_WATER_RUN_IMMUTABLE_CONFLICT'

  constructor(public readonly field: DeepWaterResearchRunConflictField) {
    const label = {
      bookedCost: 'booked cost',
      externalRunId: 'external run id',
      terminalStatus: 'terminal status',
    }[field]
    super(`Deep Water run ${label} is immutable; conflicting update rejected.`)
    this.name = 'DeepWaterResearchRunConflictError'
  }
}

const costsEqualAtStoragePrecision = (
  stored: Prisma.Decimal | number | string,
  incoming: number,
): boolean => {
  try {
    return new Prisma.Decimal(stored.toString()).equals(
      new Prisma.Decimal(incoming).toDecimalPlaces(6),
    )
  } catch {
    return false
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
    costAmount: number | null
    costCurrency: string | null
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

  if ((input.costAmount === null) !== (input.costCurrency === null)) {
    throw new Error('Deep Water booked cost amount and currency must be provided together.')
  }
  if (
    current.cost_amount !== null
    && input.costAmount !== null
    && (
      !costsEqualAtStoragePrecision(current.cost_amount, input.costAmount)
      || (
        current.cost_currency !== null
        && current.cost_currency !== input.costCurrency
      )
    )
  ) {
    throw new DeepWaterResearchRunConflictError('bookedCost')
  }
}
