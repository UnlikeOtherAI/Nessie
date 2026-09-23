import {
  EXECUTOR_CODING_SESSIONS_MCP_SERVER_NAME,
  EXECUTOR_KELPIE_MCP_SERVER_NAME,
  type ExecutorLocalMcpReport,
  type ExecutorLocalMcpStatus,
  type KelpieDevice,
} from '@nessie/schemas'

import type { ExecutorDescriptorRevisionView } from '../../../facades/executors/local-mcp'
import { Pill } from '../../primitives/Pill'
import { SectionLabel } from '../../primitives/SectionLabel'
import { ExecutorCodingSessions } from './ExecutorCodingSessions'
import { executorObservedAge } from './executor-presentation'

/**
 * What the daemon last said about each local MCP server its policy names, and
 * — for Kelpie — which browsers answered on its network.
 *
 * Everything here is a snapshot carried on a heartbeat, never a live read:
 * the daemon may be offline, and Kelpie instances announce and leave on their
 * own. So every entry carries the age of the observation it came from, and
 * the three empty-flavoured states stay distinct, because they send a person
 * to different actions:
 *
 * - report absent — this daemon has never said anything (too old, or never
 *   connected since); nothing is known, and the screen says exactly that;
 * - `kelpieDevices` absent — the daemon never probed the network, which says
 *   nothing about whether a browser is out there;
 * - `kelpieDevices: []` — Kelpie answered and no browser did: the remedy is
 *   to open Kelpie on a device, not to install it.
 *
 * The built-in coding bridge also lists the sessions open on the machine,
 * with Close for the person who paired it (`ExecutorCodingSessions`).
 */

export type ExecutorLocalMcpPanelProps = {
  descriptorRevisions?: readonly ExecutorDescriptorRevisionView[]
  executorId: string
  localMcp?: ExecutorLocalMcpReport
}

const serverDisplayName = (server: string): string =>
  server === EXECUTOR_KELPIE_MCP_SERVER_NAME
    ? 'Kelpie'
    : server === EXECUTOR_CODING_SESSIONS_MCP_SERVER_NAME ? 'Coding sessions' : server

const availabilityPill = (status: ExecutorLocalMcpStatus) => {
  if (status.available) return <Pill size="sm" tone="success" uppercase={false}>available</Pill>
  switch (status.reason) {
    case 'not_installed':
      return <Pill size="sm" tone="warning" uppercase={false}>not installed</Pill>
    case 'launch_failed':
      return <Pill size="sm" tone="warning" uppercase={false}>launch failed</Pill>
    case 'handshake_failed':
      return <Pill size="sm" tone="warning" uppercase={false}>connection failed</Pill>
    case 'unsupported_platform':
      return <Pill size="sm" tone="warning" uppercase={false}>unsupported platform</Pill>
    case 'not_probed':
      return <Pill size="sm" tone="muted" uppercase={false}>not checked</Pill>
    default:
      return <Pill size="sm" tone="warning" uppercase={false}>unavailable</Pill>
  }
}

/**
 * The reason sentences are the decision this screen drives: "not installed"
 * sends a person to install Kelpie on that machine, while "installed but
 * nothing answered" sends them to open a browser — rendering them alike
 * would send half of them to the wrong one.
 */
const unavailableCopy = (status: ExecutorLocalMcpStatus): string => {
  const name = serverDisplayName(status.server)
  switch (status.reason) {
    case 'not_installed':
      return `Install ${name} on this machine to use it.`
    case 'launch_failed':
      return `${name} could not start. Check it on the machine.`
    case 'handshake_failed':
      return `${name} started but could not connect. Check it on the machine.`
    case 'unsupported_platform':
      return `${name} cannot run on this machine’s platform.`
    case 'not_probed':
      return `${name} has not been checked yet.`
    default:
      return `${name} is unavailable. Check it on the machine.`
  }
}

const KelpieDeviceRow = ({ device }: { device: KelpieDevice }) => {
  return (
    <li className="py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-[color:var(--tx)]">{device.name}</span>
        {device.model ? <span className="text-[color:var(--tx3)]">{device.model}</span> : null}
        {device.paired
          ? <Pill size="sm" tone="success" uppercase={false}>paired</Pill>
          : <Pill size="sm" tone="accent" uppercase={false}>pair on the device</Pill>}
      </div>
      <p className="mt-0.5 text-[color:var(--tx3)]">
        last seen <span title={device.lastSeenAt}>{executorObservedAge(device.lastSeenAt)}</span>
      </p>
      {device.paired ? null : (
        <p className="mt-0.5 text-[color:var(--tx2)]">
          Open Kelpie on this device to pair it before an agent can use it.
        </p>
      )}
    </li>
  )
}

const KelpieInventory = ({ status }: { status: ExecutorLocalMcpStatus }) => {
  if (status.server !== EXECUTOR_KELPIE_MCP_SERVER_NAME) return null
  if (!status.kelpieDevices) {
    return (
      <p className="mt-1 text-[color:var(--tx3)]">
        Nearby Kelpie devices have not been checked yet.
      </p>
    )
  }
  if (status.kelpieDevices.length === 0) {
    return (
      <p className="mt-1 text-[color:var(--tx2)]">
        No nearby browsers found. Open Kelpie on the device you want to use.
      </p>
    )
  }
  return (
    <ul className="mt-1 grid gap-1">
      {status.kelpieDevices.map((device) => <KelpieDeviceRow device={device} key={device.id} />)}
    </ul>
  )
}

const ServerStatusBlock = ({ executorId, status }: { executorId: string; status: ExecutorLocalMcpStatus }) => (
  <div className="border-b border-[color:var(--sep)] py-3 text-sm">
    <div className="flex flex-wrap items-center gap-2">
      <span className="font-medium text-[color:var(--tx)]">{serverDisplayName(status.server)}</span>
      {availabilityPill(status)}
      <span className="text-[color:var(--tx3)]" title={status.observedAt}>
        observed {executorObservedAge(status.observedAt)}
      </span>
    </div>
    {!status.available ? <p className="mt-1 text-[color:var(--tx2)]">{unavailableCopy(status)}</p> : null}
    <KelpieInventory status={status} />
    <ExecutorCodingSessions executorId={executorId} status={status} />
  </div>
)

export const ExecutorLocalMcpPanel = ({
  descriptorRevisions,
  executorId,
  localMcp,
}: ExecutorLocalMcpPanelProps) => {
  // Only the active revision's names carry a question worth asking — a
  // pending one is reviewed above, a disabled one permits nothing.
  const namedServers = [...new Set(
    (descriptorRevisions ?? [])
      .filter((revision) => revision.reviewStatus === 'active')
      .flatMap((revision) => revision.mcpServers ?? []),
  )]
  const statuses = localMcp ?? []
  const unreported = namedServers.filter(
    (name) => !statuses.some((status) => status.server === name),
  )
  // A policy that fronts no server and a daemon with nothing to report leave
  // no decision here, so the section stays off the page entirely.
  if (namedServers.length === 0 && statuses.length === 0) return null
  return (
    <div className="grid gap-2 border-t border-[color:var(--sep)] pt-3">
      <SectionLabel size="sm">Local apps</SectionLabel>
      <p className="text-xs text-[color:var(--tx3)]">
        Status when the machine last checked in; it may have changed since.
      </p>
      {!localMcp ? (
        <p className="text-xs text-[color:var(--tx2)]">
          The machine has not reported whether these apps are available yet.
        </p>
      ) : null}
      {statuses.map((status) => (
        <ServerStatusBlock executorId={executorId} key={status.server} status={status} />
      ))}
      {unreported.map((name) => (
        <div className="border-b border-[color:var(--sep)] py-3 text-sm" key={name}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-[color:var(--tx)]">{name}</span>
            <Pill size="sm" tone="muted" uppercase={false}>
              {localMcp ? 'not in the last report' : 'never reported'}
            </Pill>
          </div>
          <p className="mt-1 text-[color:var(--tx2)]">
            {localMcp
              ? 'This app is permitted, but the machine did not include it in its last update.'
              : 'This app is permitted, but the machine has not reported its status yet.'}
          </p>
        </div>
      ))}
    </div>
  )
}
