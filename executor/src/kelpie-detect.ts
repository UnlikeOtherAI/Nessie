import { execFile } from 'node:child_process'

import {
  EXECUTOR_KELPIE_DEVICE_MAXIMUM,
  KelpieDeviceSchema,
  type KelpieDevice,
} from '@nessie/schemas'

import type { ExecutorLocalMcpServer } from './mcp-servers.js'

/**
 * What Kelpie can be asked about itself, beyond "does its MCP server start".
 *
 * Kelpie announces itself over mDNS and **every instance picks its own port**,
 * so there is no address to assume and no port to hard-code. The inventory is
 * therefore always a last-observed list, and `kelpie describe --json` is the
 * one place that states it as a contract rather than as human-facing output.
 *
 * A Kelpie too old to answer `describe` is still a usable MCP server. That
 * case reports availability and **omits** the inventory rather than inventing
 * an empty one, because "no browsers are on this network" and "this Kelpie
 * cannot tell me" are different facts and the schema keeps them apart.
 */

/** Long enough for an mDNS sweep plus the CLI's own start-up. */
export const KELPIE_DESCRIBE_TIMEOUT_MS = 20_000

/** Kelpie's own discovery default is 3s; this leaves room for a slow phone. */
const KELPIE_DISCOVERY_TIMEOUT_MS = 5_000

/** A describe document is small; anything this large is not one. */
const KELPIE_DESCRIBE_MAX_BYTES = 4 * 1_024 * 1_024

export type KelpieDescription = {
  cliVersion?: string
  devices: KelpieDevice[]
}

type RunResult = { ok: true; stdout: string } | { ok: false }

const runKelpieDescribe = async (
  program: string,
  spec: ExecutorLocalMcpServer,
  timeoutMs: number,
): Promise<RunResult> => new Promise((resolve) => {
  execFile(
    program,
    ['describe', '--json', '--scan-timeout', String(KELPIE_DISCOVERY_TIMEOUT_MS)],
    {
      ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
      ...(spec.env === undefined ? {} : { env: { ...process.env, ...spec.env } }),
      maxBuffer: KELPIE_DESCRIBE_MAX_BYTES,
      timeout: timeoutMs,
    },
    (error, stdout) => {
      // Every failure is the same answer here — Kelpie could not describe
      // itself — and the reason why is decided by the MCP probe, which knows
      // whether the program exists at all. Nothing from `error` may travel:
      // it carries the argv and a host path.
      if (error) {
        resolve({ ok: false })
        return
      }
      resolve({ ok: true, stdout })
    },
  )
})

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

const asPort = (value: unknown): number | undefined => {
  const port = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  return Number.isSafeInteger(port) && port >= 1 && port <= 65_535 ? port : undefined
}

/**
 * One entry of Kelpie's describe document, read defensively.
 *
 * Kelpie's grammar is its own and will grow fields we have never heard of, so
 * this reads the fields it needs, tolerates the rest, and drops an entry it
 * cannot state truthfully rather than substituting a default. A device with no
 * id or no address is not a device we could ever drive.
 */
export const kelpieDeviceFromDescribeEntry = (
  entry: unknown,
  observedAt: string,
): KelpieDevice | undefined => {
  const source = asRecord(entry)
  if (!source) return undefined
  const id = asString(source.id)
  const name = asString(source.name)
  const address = asString(source.address) ?? asString(source.ip)
  const port = asPort(source.port)
  if (!id || !name || !address || port === undefined) return undefined
  const display = asRecord(source.display)
  const width = typeof display?.width === 'number' ? display.width : undefined
  const height = typeof display?.height === 'number' ? display.height : undefined
  const candidate = {
    address,
    id,
    name,
    port,
    // Kelpie's describe document always states this, so a missing value means
    // a document we do not understand rather than an unpaired device. Reading
    // it as false is the fail-closed answer: it offers a person a pairing step
    // they can take, where a spurious true would offer a capability that then
    // fails at the first call.
    paired: source.paired === true,
    platform: source.platform,
    lastSeenAt: asString(source.lastSeenAt) ?? observedAt,
    ...(asString(source.model) === undefined ? {} : { model: asString(source.model) }),
    ...(asString(source.engine) === undefined ? {} : { engine: asString(source.engine) }),
    ...(asString(source.version) === undefined ? {} : { version: asString(source.version) }),
    ...(source.runtimeMode === 'gui' || source.runtimeMode === 'headless'
      ? { runtimeMode: source.runtimeMode }
      : {}),
    ...(width === undefined || height === undefined ? {} : { display: { height, width } }),
  }
  const parsed = KelpieDeviceSchema.safeParse(candidate)
  return parsed.success ? parsed.data : undefined
}

/**
 * Read a `kelpie describe --json` document into the inventory, or return
 * undefined when this Kelpie cannot produce one.
 */
export const kelpieDescriptionFromJson = (
  stdout: string,
  observedAt: string,
): KelpieDescription | undefined => {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return undefined
  }
  const document = asRecord(parsed)
  if (!document) return undefined
  const discovery = asRecord(document.discovery)
  // A Kelpie that could not browse mDNS at all has not found nothing — it has
  // not looked. Reporting its empty list as an inventory would say "there are
  // no browsers on this network", which is the one thing it cannot know.
  if (discovery?.mdns !== undefined && discovery.mdns !== 'ok') return undefined
  const entries = Array.isArray(discovery?.devices)
    ? discovery.devices
    // Tolerated for a Kelpie that states its instances at the top level.
    : Array.isArray(document.devices) ? document.devices : undefined
  if (!entries) return undefined
  const devices: KelpieDevice[] = []
  for (const entry of entries) {
    // The cap is the wire contract's, so a network full of Kelpies truncates
    // here rather than failing the whole heartbeat downstream.
    if (devices.length >= EXECUTOR_KELPIE_DEVICE_MAXIMUM) break
    const device = kelpieDeviceFromDescribeEntry(entry, observedAt)
    if (device) devices.push(device)
  }
  return {
    devices,
    ...(asString(asRecord(document.cli)?.version) === undefined
      ? {}
      : { cliVersion: asString(asRecord(document.cli)?.version) }),
  }
}

/**
 * Ask the Kelpie behind a named MCP server to describe itself.
 *
 * The program is the one the reviewed policy already named for that server —
 * the executor never goes looking for a `kelpie` binary of its own, because
 * running a program the policy did not name is the thing the policy exists to
 * prevent.
 */
export const describeKelpie = async (
  spec: ExecutorLocalMcpServer,
  options: {
    run?: (program: string, spec: ExecutorLocalMcpServer, timeoutMs: number) => Promise<RunResult>
    timeoutMs?: number
  } = {},
): Promise<KelpieDescription | undefined> => {
  const program = spec.command[0]
  if (!program) return undefined
  const run = options.run ?? runKelpieDescribe
  const result = await run(program, spec, options.timeoutMs ?? KELPIE_DESCRIBE_TIMEOUT_MS)
  if (!result.ok) return undefined
  return kelpieDescriptionFromJson(result.stdout, new Date().toISOString())
}
