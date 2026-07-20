import type { PrismaClient } from '@prisma/client'
import {
  DEEP_WATER_START_FAILURE_DETAIL,
  type DeepWaterHandoffLookup,
  type DeepWaterHandoffRun,
  type DeepWaterHandoffRunLocator,
  type DeepWaterStartTicketStatus,
} from '@nessie/runtime'
import { FatalToolExecutionError } from './tool-execution-errors.js'
import {
  createDeepWaterHandoffRepository,
  type DeepWaterHandoffRepository,
} from './deepwater-handoff-repository.js'
import {
  isDefinitiveLedgerStartRejection,
  isLedgerResearchTicketId,
  ledgerResearchReportSourceCount,
  ledgerResearchTicket,
  persistedTicketResult,
} from './deepwater-handoff-ticket.js'
import type { ToolDispatchResult } from './tool-dispatch.js'
const DEEP_WATER_START_TOOL = 'research_start'
const DEEP_WATER_LIST_TOOL = 'research_list'
const DEEP_WATER_TICKET_TOOLS = new Set([
  'research_status',
  'research_report',
  'research_cancel',
])
const HANDOFF_INVARIANT_MESSAGE =
  'Deep Water handoff state could not be persisted safely.'
const AMBIGUOUS_START_MESSAGE =
  'Deep Water start did not return a definitive outcome; the run will retry safely.'

export abstract class DeepWaterHandoffFatalError extends FatalToolExecutionError {
  constructor(message: string, readonly handoffRunId: string | null) {
    super(message)
  }
}

export class DeepWaterHandoffInvariantError extends DeepWaterHandoffFatalError {
  constructor(handoffRunId: string | null = null) {
    super(HANDOFF_INVARIANT_MESSAGE, handoffRunId)
  }
}

export class DeepWaterHandoffAmbiguousStartError extends DeepWaterHandoffFatalError {
  constructor(handoffRunId: string | null = null) {
    super(AMBIGUOUS_START_MESSAGE, handoffRunId)
  }
}
export type { DeepWaterHandoffRepository } from './deepwater-handoff-repository.js'

type StartState =
  | 'unattempted'
  | 'recoverable'
  | 'ticket_persisted'
  | 'in_flight'
  | 'succeeded'
  | 'settled'
  | 'failed'
  | 'ambiguous'
const blockedResult = (): ToolDispatchResult => ({
  output: DEEP_WATER_START_FAILURE_DETAIL,
  raw: null,
  success: false,
})

export type DeepWaterGuardedDispatchResult = {
  deliveryToken: symbol | null
  result: ToolDispatchResult
  transportInvoked: boolean
}

const blockedDispatchResult = (): DeepWaterGuardedDispatchResult => ({
  deliveryToken: null,
  result: blockedResult(),
  transportInvoked: false,
})

export type DeepWaterHandoffGuard = {
  assertCompletion: () => void
  dispatchDeepWater: (
    originalToolName: string,
    currentToolCallId: string | undefined,
    currentArgs: Record<string, unknown>,
    dispatch: (
      stableToolCallId: string,
      stableArgs: Record<string, unknown>,
    ) => Promise<ToolDispatchResult>,
  ) => Promise<DeepWaterGuardedDispatchResult>
  markDelivered: (deliveryToken: symbol) => void
  suppressBuiltin: (toolName: string) => Promise<boolean>
  timeoutErrorFor: (originalToolName: string) => Error | null
}

const initialState = (run: DeepWaterHandoffRun): StartState => {
  if (run.externalRunId !== null) {
    if (!isLedgerResearchTicketId(run.externalRunId)) {
      throw new DeepWaterHandoffInvariantError(run.id)
    }
    return run.startTicketStatus !== null || run.status === 'running'
      ? 'ticket_persisted'
      : 'settled'
  }
  if (['completed', 'failed', 'needs_setup', 'warning'].includes(run.status)) {
    return 'settled'
  }
  if (run.startEligible) return 'unattempted'
  if (run.status === 'running' && run.failureEligible) {
    if (run.startToolCallId && run.startArguments) return 'recoverable'
    throw new DeepWaterHandoffInvariantError(run.id)
  }
  throw new DeepWaterHandoffInvariantError(run.id)
}

const createGuard = (
  repository: DeepWaterHandoffRepository,
  run: DeepWaterHandoffRun | null,
): DeepWaterHandoffGuard => {
  if (!run) {
    return {
      assertCompletion: () => undefined,
      dispatchDeepWater: async (_toolName, toolCallId, args, dispatch) => {
        return {
          deliveryToken: null,
          result: await dispatch(toolCallId ?? '', args),
          transportInvoked: true,
        }
      },
      markDelivered: () => undefined,
      suppressBuiltin: async () => false,
      timeoutErrorFor: () => null,
    }
  }

  let startState = initialState(run)
  let stableStartToolCallId = run.startToolCallId
  let stableStartArguments = run.startArguments
  let persistedExternalRunId = run.externalRunId
  let persistedTicketStatus: DeepWaterStartTicketStatus =
    run.startTicketStatus
    ?? (run.status === 'completed'
      ? 'complete'
      : run.status === 'failed' ? 'failed' : 'running')
  let attemptAbandoned = false
  let pendingStartDeliveryToken: symbol | null = null
  let failureMutationStarted = false
  let settleStart: (() => void) | null = null
  let startSettled = Promise.resolve()

  const queueStartDelivery = (): symbol => {
    const token = Symbol('deepwater-start-delivery')
    pendingStartDeliveryToken = token
    return token
  }

  const waitForStart = async (): Promise<void> => {
    if (startState === 'in_flight') await startSettled
  }

  const failStart = async (): Promise<void> => {
    if (failureMutationStarted) return
    failureMutationStarted = true
    let markedFailed = false
    try {
      if (!stableStartToolCallId) {
        throw new DeepWaterHandoffInvariantError(run.id)
      }
      markedFailed = await repository.failStart(run.id, stableStartToolCallId)
    } catch {
      startState = 'ambiguous'
      throw new DeepWaterHandoffInvariantError(run.id)
    }
    if (!markedFailed) {
      startState = 'ambiguous'
      throw new DeepWaterHandoffInvariantError(run.id)
    }
    if (!attemptAbandoned) startState = 'failed'
  }

  const resolveLostClaim = async (
    toolCallId: string,
  ): Promise<'blocked' | 'recover' | 'ticket'> => {
    let lookup: DeepWaterHandoffLookup
    try {
      lookup = await repository.findRun()
    } catch {
      startState = 'ambiguous'
      throw new DeepWaterHandoffInvariantError(run.id)
    }
    if (lookup.kind !== 'found' || lookup.run.id !== run.id) {
      startState = 'ambiguous'
      throw new DeepWaterHandoffInvariantError(run.id)
    }
    const refreshed = lookup.run
    if (refreshed.externalRunId !== null) {
      if (!isLedgerResearchTicketId(refreshed.externalRunId)) {
        startState = 'ambiguous'
        throw new DeepWaterHandoffInvariantError(run.id)
      }
      persistedExternalRunId = refreshed.externalRunId
      persistedTicketStatus = refreshed.startTicketStatus
        ?? (refreshed.status === 'completed'
          ? 'complete'
          : refreshed.status === 'failed' ? 'failed' : 'running')
      startState = 'ticket_persisted'
      return 'ticket'
    }
    if (['completed', 'failed', 'needs_setup', 'warning'].includes(refreshed.status)) {
      startState = 'settled'
      return 'blocked'
    }
    if (
      refreshed.status === 'running'
      && refreshed.failureEligible
      && refreshed.startToolCallId === toolCallId
      && refreshed.startArguments
    ) {
      stableStartToolCallId = toolCallId
      stableStartArguments = refreshed.startArguments
      return 'recover'
    }
    startState = 'ambiguous'
    throw new DeepWaterHandoffInvariantError(run.id)
  }

  return {
    assertCompletion: () => {
      if (
        !attemptAbandoned
        && pendingStartDeliveryToken === null
        && ['failed', 'settled', 'succeeded', 'ticket_persisted'].includes(startState)
      ) {
        return
      }
      if (startState === 'unattempted') {
        throw new DeepWaterHandoffInvariantError(run.id)
      }
      throw new DeepWaterHandoffAmbiguousStartError(run.id)
    },
    dispatchDeepWater: async (
      originalToolName,
      currentToolCallId,
      currentArgs,
      dispatch,
    ) => {
      if (originalToolName !== DEEP_WATER_START_TOOL) {
        if (
          originalToolName === DEEP_WATER_LIST_TOOL
          || !DEEP_WATER_TICKET_TOOLS.has(originalToolName)
        ) {
          return blockedDispatchResult()
        }
        await waitForStart()
        if (
          !persistedExternalRunId
          || attemptAbandoned
          || (startState !== 'succeeded' && startState !== 'ticket_persisted')
        ) {
          return blockedDispatchResult()
        }
        const result = await dispatch(
          currentToolCallId ?? '',
          { id: persistedExternalRunId },
        )
        if (originalToolName === 'research_report' && result.success) {
          const sourceCount = ledgerResearchReportSourceCount(result)
          if (sourceCount === null) {
            startState = 'ambiguous'
            throw new DeepWaterHandoffInvariantError(run.id)
          }
          let persisted = false
          try {
            persisted = await repository.persistReportSources(
              run.id,
              persistedExternalRunId,
              sourceCount,
            )
          } catch {
            startState = 'ambiguous'
            throw new DeepWaterHandoffInvariantError(run.id)
          }
          if (!persisted) {
            startState = 'ambiguous'
            throw new DeepWaterHandoffInvariantError(run.id)
          }
        }
        return { deliveryToken: null, result, transportInvoked: true }
      }
      if (startState === 'ticket_persisted' && persistedExternalRunId) {
        startState = 'succeeded'
        return {
          deliveryToken: queueStartDelivery(),
          result: persistedTicketResult(
            persistedExternalRunId,
            persistedTicketStatus,
          ),
          transportInvoked: false,
        }
      }
      if (startState !== 'unattempted' && startState !== 'recoverable') {
        return blockedDispatchResult()
      }

      const recovering = startState === 'recoverable'
      if (!recovering && !currentToolCallId) {
        throw new DeepWaterHandoffInvariantError(run.id)
      }
      startState = 'in_flight'
      startSettled = new Promise<void>((resolve) => {
        settleStart = resolve
      })
      try {
        if (!recovering) {
          const toolCallId = currentToolCallId as string
          let claimed = false
          try {
            claimed = await repository.claimStart(run.id, toolCallId, currentArgs)
          } catch {
            startState = 'ambiguous'
            throw new DeepWaterHandoffInvariantError(run.id)
          }
          if (!claimed) {
            const resolution = await resolveLostClaim(toolCallId)
            if (resolution === 'blocked') {
              return blockedDispatchResult()
            }
            if (resolution === 'ticket' && persistedExternalRunId) {
              startState = 'succeeded'
              return {
                deliveryToken: queueStartDelivery(),
                result: persistedTicketResult(
                  persistedExternalRunId,
                  persistedTicketStatus,
                ),
                transportInvoked: false,
              }
            }
          } else {
            stableStartToolCallId = toolCallId
            stableStartArguments = currentArgs
          }
        }

        if (!stableStartToolCallId || !stableStartArguments) {
          throw new DeepWaterHandoffInvariantError(run.id)
        }
        let result: ToolDispatchResult
        try {
          result = await dispatch(stableStartToolCallId, stableStartArguments)
        } catch {
          startState = 'ambiguous'
          throw new DeepWaterHandoffAmbiguousStartError(run.id)
        }
        if (!result.success && !isDefinitiveLedgerStartRejection(result)) {
          startState = 'ambiguous'
          throw new DeepWaterHandoffAmbiguousStartError(run.id)
        }
        if (!result.success) {
          await failStart()
          return {
            deliveryToken: queueStartDelivery(),
            result: blockedResult(),
            transportInvoked: true,
          }
        }
        if (run.ledgerOrigin === null) {
          startState = 'ambiguous'
          throw new DeepWaterHandoffInvariantError(run.id)
        }
        const ticket = ledgerResearchTicket(result, run.ledgerOrigin)
        if (!ticket) {
          startState = 'ambiguous'
          throw new DeepWaterHandoffAmbiguousStartError(run.id)
        }

        let persisted = false
        try {
          persisted = await repository.persistTicket(
            run.id,
            stableStartToolCallId,
            ticket.id,
            ticket.status,
            ticket.reportUrl,
          )
        } catch {
          startState = 'ambiguous'
          throw new DeepWaterHandoffInvariantError(run.id)
        }
        if (!persisted) {
          startState = 'ambiguous'
          throw new DeepWaterHandoffInvariantError(run.id)
        }
        persistedExternalRunId = ticket.id
        persistedTicketStatus = ticket.status
        startState = attemptAbandoned ? 'ambiguous' : 'succeeded'
        return {
          deliveryToken: queueStartDelivery(),
          result,
          transportInvoked: true,
        }
      } finally {
        settleStart?.()
        settleStart = null
      }
    },
    markDelivered: (deliveryToken) => {
      if (pendingStartDeliveryToken === deliveryToken) {
        pendingStartDeliveryToken = null
      }
    },
    suppressBuiltin: async (toolName) => {
      if (toolName === 'delegate') return true
      if (!toolName.startsWith('kb_') && toolName !== 'deep_water_run_update') {
        return false
      }
      await waitForStart()
      return attemptAbandoned
        || pendingStartDeliveryToken !== null
        || (startState !== 'succeeded' && startState !== 'ticket_persisted')
    },
    timeoutErrorFor: (originalToolName) => {
      if (
        originalToolName !== DEEP_WATER_START_TOOL
        || (startState !== 'in_flight' && pendingStartDeliveryToken === null)
      ) {
        return null
      }
      attemptAbandoned = true
      startState = 'ambiguous'
      settleStart?.()
      return new DeepWaterHandoffAmbiguousStartError(run.id)
    },
  }
}
const guardFromLookup = (
  repository: DeepWaterHandoffRepository,
  lookup: DeepWaterHandoffLookup,
  expectedRunId?: string,
): DeepWaterHandoffGuard => {
  if (lookup.kind === 'ambiguous') throw new DeepWaterHandoffInvariantError()
  if (lookup.kind === 'none' && expectedRunId) {
    throw new DeepWaterHandoffInvariantError(expectedRunId)
  }
  if (
    lookup.kind === 'found'
    && expectedRunId
    && lookup.run.id !== expectedRunId
  ) {
    throw new DeepWaterHandoffInvariantError(expectedRunId)
  }
  return createGuard(repository, lookup.kind === 'found' ? lookup.run : null)
}

export const createDeepWaterHandoffGuard = async (input: {
  locator: DeepWaterHandoffRunLocator | null
  prisma: PrismaClient
}): Promise<DeepWaterHandoffGuard> => {
  if (!input.locator) {
    return createGuard(
      {
        claimStart: async () => false,
        failStart: async () => false,
        findRun: async () => ({ kind: 'none' }),
        persistReportSources: async () => false,
        persistTicket: async () => false,
      },
      null,
    )
  }
  const locator = input.locator
  const repository = createDeepWaterHandoffRepository(input.prisma, locator)
  try {
    return guardFromLookup(repository, await repository.findRun(), locator.runId)
  } catch (error) {
    if (error instanceof DeepWaterHandoffFatalError) throw error
    throw new DeepWaterHandoffInvariantError(locator.runId)
  }
}
export const createDeepWaterHandoffGuardForTest = async (
  repository: DeepWaterHandoffRepository,
  expectedRunId?: string,
): Promise<DeepWaterHandoffGuard> => {
  try {
    return guardFromLookup(repository, await repository.findRun(), expectedRunId)
  } catch (error) {
    if (error instanceof DeepWaterHandoffFatalError) throw error
    throw new DeepWaterHandoffInvariantError(expectedRunId ?? null)
  }
}
