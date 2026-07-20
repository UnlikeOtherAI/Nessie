import {
  type DeepWaterHandoffLookup,
  type DeepWaterHandoffRun,
} from '@nessie/runtime'

import type { DeepWaterHandoffRepository } from './deepwater-handoff-guard.js'
import type { ToolDispatchResult } from './tool-dispatch.js'

export const START_ARGS = { query: 'Map geothermal risk', depth: 'deep' }

export const ticketResult = (
  structuredContent: unknown,
): ToolDispatchResult => ({
  output: JSON.stringify(structuredContent),
  raw: { content: [], isError: false, structuredContent },
  success: true,
})

export const runningTicket = (id: string): ToolDispatchResult =>
  ticketResult({ id, job_id: id, status: 'running' })

export const errorResult = (
  error: string,
  statusCode: number,
): ToolDispatchResult => ({
  output: error,
  raw: {
    content: [],
    isError: true,
    structuredContent: { error, status_code: statusCode },
  },
  success: false,
})

export const handoffRun = (
  overrides: Partial<DeepWaterHandoffRun> = {},
): DeepWaterHandoffRun => ({
  externalRunId: null,
  failureEligible: true,
  id: 'handoff-run-1',
  startArguments: null,
  startEligible: true,
  startTicketStatus: null,
  startToolCallId: null,
  status: 'queued',
  ...overrides,
})

export const found = (
  run = handoffRun(),
): DeepWaterHandoffLookup => ({
  kind: 'found',
  run,
})

export const makeRepository = (options: {
  claimStart?: DeepWaterHandoffRepository['claimStart']
  failStart?: DeepWaterHandoffRepository['failStart']
  findRun?: DeepWaterHandoffRepository['findRun']
  persistTicket?: DeepWaterHandoffRepository['persistTicket']
} = {}) => {
  const calls = { claim: 0, fail: 0, find: 0, persist: 0 }
  const repository: DeepWaterHandoffRepository = {
    claimStart: async (...args) => {
      calls.claim += 1
      return options.claimStart ? options.claimStart(...args) : true
    },
    failStart: async (...args) => {
      calls.fail += 1
      return options.failStart ? options.failStart(...args) : true
    },
    findRun: async () => {
      calls.find += 1
      return options.findRun ? options.findRun() : found()
    },
    persistTicket: async (...args) => {
      calls.persist += 1
      return options.persistTicket ? options.persistTicket(...args) : true
    },
  }
  return { calls, repository }
}
