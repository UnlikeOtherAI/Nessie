import type { PrismaClient } from '@prisma/client'
import {
  claimDeepWaterHandoffStart,
  failDeepWaterHandoffStart,
  findDeepWaterHandoffRun,
  persistDeepWaterHandoffReportSources,
  persistDeepWaterHandoffTicket,
  type DeepWaterHandoffLookup,
  type DeepWaterHandoffRunLocator,
  type DeepWaterStartTicketStatus,
} from '@nessie/runtime'

export type DeepWaterHandoffRepository = {
  claimStart: (
    runId: string,
    toolCallId: string,
    args: Record<string, unknown>,
  ) => Promise<boolean>
  failStart: (runId: string, toolCallId: string) => Promise<boolean>
  findRun: () => Promise<DeepWaterHandoffLookup>
  persistReportSources: (
    runId: string,
    externalRunId: string,
    sourceCount: number,
  ) => Promise<boolean>
  persistTicket: (
    runId: string,
    toolCallId: string,
    externalRunId: string,
    ticketStatus: DeepWaterStartTicketStatus,
    reportUrl: string | null,
  ) => Promise<boolean>
}

export const createDeepWaterHandoffRepository = (
  prisma: PrismaClient,
  locator: DeepWaterHandoffRunLocator,
): DeepWaterHandoffRepository => ({
  claimStart: (runId, toolCallId, args) => claimDeepWaterHandoffStart(prisma, {
    ...locator,
    args,
    runId,
    toolCallId,
  }),
  failStart: (runId, toolCallId) => failDeepWaterHandoffStart(prisma, {
    ...locator,
    runId,
    toolCallId,
  }),
  findRun: () => findDeepWaterHandoffRun(prisma, locator),
  persistReportSources: (runId, externalRunId, sourceCount) =>
    persistDeepWaterHandoffReportSources(prisma, {
      ...locator,
      externalRunId,
      runId,
      sourceCount,
    }),
  persistTicket: (runId, toolCallId, externalRunId, ticketStatus, reportUrl) =>
    persistDeepWaterHandoffTicket(prisma, {
      ...locator,
      externalRunId,
      reportUrl,
      runId,
      ticketStatus,
      toolCallId,
    }),
})
