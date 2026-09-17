import {
  EXECUTOR_KELPIE_MCP_SERVER_NAME,
  ExecutorLocalMcpReportSchema,
  type ExecutorLocalMcpReport,
  type ExecutorLocalMcpStatus,
} from '@nessie/schemas'

import { describeKelpie } from './kelpie-detect.js'
import type { ExecutorLocalMcpServer } from './mcp-servers.js'
import type { ExecutorMcpSessionManager } from './mcp-session-manager.js'

/**
 * What the daemon last observed about each MCP server its policy names.
 *
 * This is deliberately *not* computed on the heartbeat. A discovery sweep
 * takes seconds and a heartbeat must not wait for one, so the report is
 * refreshed on its own cadence and every heartbeat carries the last one, with
 * the `observedAt` that says how old it is. A reader that treats it as live is
 * reading it wrong, and the timestamp is there so it does not have to.
 */

/** How often the daemon re-probes. Kelpie instances come and go on a network. */
export const LOCAL_MCP_REFRESH_INTERVAL_MS = 120_000

export type LocalMcpReporter = {
  /** The last observed report, or undefined before the first sweep finishes. */
  current: () => ExecutorLocalMcpReport | undefined
  refresh: () => Promise<ExecutorLocalMcpReport>
  stop: () => void
}

const statusForServer = async (
  spec: ExecutorLocalMcpServer,
  sessions: ExecutorMcpSessionManager,
): Promise<ExecutorLocalMcpStatus> => {
  const observedAt = new Date().toISOString()
  const probe = await sessions.probe(spec.name)
  if (!probe.available) {
    return { available: false, observedAt, reason: probe.reason, server: spec.name }
  }
  const base: ExecutorLocalMcpStatus = {
    available: true,
    catalogDigest: probe.catalogDigest,
    observedAt,
    server: spec.name,
    toolCount: probe.toolCount,
    ...(probe.serverVersion === undefined ? {} : { serverVersion: probe.serverVersion }),
  }
  if (spec.name !== EXECUTOR_KELPIE_MCP_SERVER_NAME) return base
  // Only Kelpie is enumerated, because only Kelpie states a contract for what
  // is on the network. A Kelpie too old to answer `describe` leaves the field
  // absent, which the wire contract reads as "not probed for instances" —
  // never as "no instances".
  const description = await describeKelpie(spec)
  if (!description) return base
  return {
    ...base,
    kelpieDevices: description.devices,
    ...(description.cliVersion === undefined ? {} : { serverVersion: description.cliVersion }),
  }
}

export const createLocalMcpReporter = (
  servers: readonly ExecutorLocalMcpServer[],
  sessions: ExecutorMcpSessionManager,
  options: { intervalMs?: number; now?: () => number } = {},
): LocalMcpReporter => {
  let last: ExecutorLocalMcpReport | undefined
  let timer: NodeJS.Timeout | undefined
  let inFlight: Promise<ExecutorLocalMcpReport> | undefined

  const sweep = async (): Promise<ExecutorLocalMcpReport> => {
    // Servers are probed in parallel: one Kelpie taking its full discovery
    // timeout must not delay the answer about an unrelated server.
    const statuses = await Promise.all(
      servers.map(async (spec) => statusForServer(spec, sessions)),
    )
    const report = ExecutorLocalMcpReportSchema.parse(statuses)
    last = report
    return report
  }

  const refresh = async (): Promise<ExecutorLocalMcpReport> => {
    // A slow sweep must not stack behind the interval timer; a second caller
    // joins the one in flight rather than starting a competing set of probes.
    inFlight ??= sweep().finally(() => {
      inFlight = undefined
    })
    return inFlight
  }

  const intervalMs = options.intervalMs ?? LOCAL_MCP_REFRESH_INTERVAL_MS
  if (servers.length > 0) {
    timer = setInterval(() => {
      void refresh().catch(() => undefined)
    }, intervalMs)
    timer.unref?.()
  }

  return {
    // An executor that names no server reports an empty array, not absence:
    // absence means a daemon too old to report at all.
    current: () => (servers.length === 0 ? [] : last),
    refresh,
    stop: () => {
      if (timer) clearInterval(timer)
      timer = undefined
    },
  }
}
