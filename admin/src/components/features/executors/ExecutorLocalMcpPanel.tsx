import {
  EXECUTOR_KELPIE_MCP_SERVER_NAME,
  type ExecutorLocalMcpReport,
  type ExecutorLocalMcpStatus,
  type KelpieDevice,
} from '@nessie/schemas'

import type { ExecutorDescriptorRevisionView } from '../../../facades/executors/local-mcp'
import { Pill } from '../../primitives/Pill'
import { SectionLabel } from '../../primitives/SectionLabel'

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
 */

export type ExecutorLocalMcpPanelProps = {
  descriptorRevisions?: readonly ExecutorDescriptorRevisionView[]
  localMcp?: ExecutorLocalMcpReport
}

const serverDisplayName = (server: string): string =>
  server === EXECUTOR_KELPIE_MCP_SERVER_NAME ? 'Kelpie' : server

/**
 * The age of an observation is the only honest "current" this screen has, so
 * it renders beside every entry rather than behind a hover. The exact
 * timestamp stays on the title for anyone who needs it.
 */
const observedAge = (timestamp: string): string => {
  const elapsedMs = Date.now() - new Date(timestamp).getTime()
  if (Number.isNaN(elapsedMs)) return 'at an unreadable time'
  if (elapsedMs < 60_000) return 'just now'
  const minutes = Math.round(elapsedMs / 60_000)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} h ago`
  return `${Math.round(hours / 24)} d ago`
}

const availabilityPill = (status: ExecutorLocalMcpStatus) => {
  if (status.available) return <Pill size="sm" tone="success" uppercase={false}>available</Pill>
  switch (status.reason) {
    case 'not_installed':
      return <Pill size="sm" tone="warning" uppercase={false}>not installed</Pill>
    case 'launch_failed':
      return <Pill size="sm" tone="warning" uppercase={false}>launch failed</Pill>
    case 'handshake_failed':
      return <Pill size="sm" tone="warning" uppercase={false}>handshake failed</Pill>
    case 'unsupported_platform':
      return <Pill size="sm" tone="warning" uppercase={false}>unsupported platform</Pill>
    case 'not_probed':
      return <Pill size="sm" tone="muted" uppercase={false}>not probed</Pill>
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
      return `${name} is not installed on this machine. Install it there and the next heartbeat reports it.`
    case 'launch_failed':
      return `${name} is installed, but the daemon could not start it.`
    case 'handshake_failed':
      return `${name} started, but did not answer the MCP handshake.`
    case 'unsupported_platform':
      return `${name} cannot run on this machine's platform.`
    case 'not_probed':
      return `The daemon has not probed ${name} yet; a later heartbeat should say.`
    default:
      return `${name} is not available, and the daemon gave no reason.`
  }
}

const availableCopy = (status: ExecutorLocalMcpStatus): string => {
  const facts = [
    status.serverVersion ? `${serverDisplayName(status.server)} ${status.serverVersion}` : undefined,
    typeof status.toolCount === 'number'
      ? `${status.toolCount} tool${status.toolCount === 1 ? '' : 's'}`
      : undefined,
  ].filter((fact): fact is string => Boolean(fact))
  return facts.length > 0
    ? facts.join(' · ')
    : 'The daemon completed an MCP handshake with it.'
}

const KelpieDeviceRow = ({ device }: { device: KelpieDevice }) => {
  const facts = [
    device.platform,
    device.runtimeMode,
    device.engine,
    device.version ? `Kelpie ${device.version}` : undefined,
  ].filter((fact): fact is string => Boolean(fact))
  const where = [
    `${device.address}:${device.port}`,
    device.display ? `${device.display.width}×${device.display.height}` : undefined,
  ].filter((fact): fact is string => Boolean(fact))
  return (
    <li className="rounded border border-[color:var(--sep)] px-2 py-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-[color:var(--tx)]">{device.name}</span>
        {device.model ? <span className="text-[color:var(--tx3)]">{device.model}</span> : null}
        {device.paired
          ? <Pill size="sm" tone="success" uppercase={false}>paired</Pill>
          : <Pill size="sm" tone="accent" uppercase={false}>pair on the device</Pill>}
      </div>
      {facts.length > 0 ? <p className="mt-0.5 text-[color:var(--tx2)]">{facts.join(' · ')}</p> : null}
      <p className="mt-0.5 text-[color:var(--tx3)]">
        {where.join(' · ')}{where.length > 0 ? ' · ' : ''}
        last seen <span title={device.lastSeenAt}>{observedAge(device.lastSeenAt)}</span>
      </p>
      {device.paired ? null : (
        <p className="mt-0.5 text-[color:var(--tx2)]">
          Discovered, not drivable — Kelpie refuses automation until a person
          pairs on the device itself.
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
        The daemon has not probed the network for Kelpie instances.
      </p>
    )
  }
  if (status.kelpieDevices.length === 0) {
    return (
      <p className="mt-1 text-[color:var(--tx2)]">
        Kelpie answered, but no browser announced itself on the network. Open
        Kelpie on a device and it appears here on a later heartbeat.
      </p>
    )
  }
  return (
    <ul className="mt-1 grid gap-1">
      {status.kelpieDevices.map((device) => <KelpieDeviceRow device={device} key={device.id} />)}
    </ul>
  )
}

const ServerStatusBlock = ({ status }: { status: ExecutorLocalMcpStatus }) => (
  <div className="rounded border border-[color:var(--sep)] p-2 text-xs">
    <div className="flex flex-wrap items-center gap-2">
      <span className="font-medium text-[color:var(--tx)]">{status.server}</span>
      {availabilityPill(status)}
      <span className="text-[color:var(--tx3)]" title={status.observedAt}>
        observed {observedAge(status.observedAt)}
      </span>
    </div>
    <p className="mt-1 text-[color:var(--tx2)]">
      {status.available ? availableCopy(status) : unavailableCopy(status)}
      {!status.available && status.detail ? ` ${status.detail}` : null}
    </p>
    <KelpieInventory status={status} />
  </div>
)

export const ExecutorLocalMcpPanel = ({
  descriptorRevisions,
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
      <SectionLabel size="sm">Local MCP servers</SectionLabel>
      <p className="text-xs text-[color:var(--tx3)]">
        A last-observed snapshot from the daemon’s heartbeat, never live — the
        daemon may be offline and instances come and go, so read each entry’s
        age before acting on it.
      </p>
      {!localMcp ? (
        <p className="text-xs text-[color:var(--tx2)]">
          This daemon has never reported local MCP status — it predates the
          report, or it has not connected since. The reviewed policy names the
          servers below; nothing is known about them yet.
        </p>
      ) : null}
      {statuses.map((status) => <ServerStatusBlock key={status.server} status={status} />)}
      {unreported.map((name) => (
        <div className="rounded border border-[color:var(--sep)] p-2 text-xs" key={name}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-[color:var(--tx)]">{name}</span>
            <Pill size="sm" tone="muted" uppercase={false}>
              {localMcp ? 'not in the last report' : 'never reported'}
            </Pill>
          </div>
          <p className="mt-1 text-[color:var(--tx2)]">
            {localMcp
              ? 'The active reviewed policy names this server, but the daemon’s last report does not.'
              : 'The active reviewed policy names this server; the daemon has never reported its status.'}
          </p>
        </div>
      ))}
    </div>
  )
}
