import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  describeKelpie,
  kelpieDescriptionFromJson,
  kelpieDeviceFromDescribeEntry,
} from '../src/kelpie-detect.js'

const OBSERVED = '2026-09-17T10:00:00.000Z'

const fullEntry = {
  address: '192.168.1.42',
  display: { height: 2556, width: 1179 },
  engine: 'webkit',
  id: 'kelpie-ios-9f2a',
  lastSeenAt: '2026-09-17T09:59:58.000Z',
  model: 'iPhone 17 Pro',
  name: "Ondrej's iPhone",
  paired: true,
  platform: 'ios',
  port: 51_873,
  runtimeMode: 'gui',
  version: '0.1.3',
}

test('reads every fact Kelpie advertises about an instance', () => {
  const device = kelpieDeviceFromDescribeEntry(fullEntry, OBSERVED)
  assert.ok(device)
  assert.equal(device.id, 'kelpie-ios-9f2a')
  assert.equal(device.name, "Ondrej's iPhone")
  assert.equal(device.model, 'iPhone 17 Pro')
  assert.equal(device.platform, 'ios')
  assert.equal(device.runtimeMode, 'gui')
  assert.equal(device.engine, 'webkit')
  assert.equal(device.version, '0.1.3')
  assert.equal(device.address, '192.168.1.42')
  assert.equal(device.port, 51_873)
  assert.deepEqual(device.display, { height: 2556, width: 1179 })
  assert.equal(device.paired, true)
  assert.equal(device.lastSeenAt, '2026-09-17T09:59:58.000Z')
})

test('a port is never assumed — every instance states its own', () => {
  // Kelpie instances pick their own port, so two on one network differ. A
  // reader that defaulted a port would point at the wrong browser.
  const first = kelpieDeviceFromDescribeEntry({ ...fullEntry, port: 51_873 }, OBSERVED)
  const second = kelpieDeviceFromDescribeEntry(
    { ...fullEntry, id: 'kelpie-mac-1', port: 8_390 },
    OBSERVED,
  )
  assert.equal(first?.port, 51_873)
  assert.equal(second?.port, 8_390)
  const portless = kelpieDeviceFromDescribeEntry(
    { ...fullEntry, port: undefined },
    OBSERVED,
  )
  assert.equal(portless, undefined, 'an instance with no port is not reachable and is dropped')
})

test('an entry missing an identity or an address is dropped, never defaulted', () => {
  for (const missing of ['id', 'name', 'address'] as const) {
    const entry: Record<string, unknown> = { ...fullEntry }
    delete entry[missing]
    assert.equal(
      kelpieDeviceFromDescribeEntry(entry, OBSERVED),
      undefined,
      `an entry with no ${missing} must be dropped`,
    )
  }
})

test('an unpaired instance reports as unpaired rather than being hidden', () => {
  // Kelpie refuses every automation method until a person pairs on the device,
  // so a discoverable-but-undrivable instance is a real state a person acts on.
  const device = kelpieDeviceFromDescribeEntry({ ...fullEntry, paired: false }, OBSERVED)
  assert.ok(device)
  assert.equal(device.paired, false)
})

test('a missing pairing fact reads as unpaired, not as paired', () => {
  const entry: Record<string, unknown> = { ...fullEntry }
  delete entry.paired
  assert.equal(kelpieDeviceFromDescribeEntry(entry, OBSERVED)?.paired, false)
})

test('unknown fields from a newer Kelpie are tolerated', () => {
  const device = kelpieDeviceFromDescribeEntry(
    { ...fullEntry, somethingNessieHasNeverHeardOf: { deeply: ['nested'] } },
    OBSERVED,
  )
  assert.ok(device, 'a field we do not know must not cost us the whole instance')
  assert.equal(device.id, 'kelpie-ios-9f2a')
})

test('falls back to the observation time when an instance states no last-seen', () => {
  const entry: Record<string, unknown> = { ...fullEntry }
  delete entry.lastSeenAt
  assert.equal(kelpieDeviceFromDescribeEntry(entry, OBSERVED)?.lastSeenAt, OBSERVED)
})

test('reads a whole describe document, with the CLI version', () => {
  const description = kelpieDescriptionFromJson(JSON.stringify({
    cli: { path: '/opt/homebrew/bin/kelpie', version: '0.1.11' },
    devices: [fullEntry, { ...fullEntry, id: 'kelpie-mac-1', platform: 'macos' }],
    schemaVersion: 1,
  }), OBSERVED)
  assert.equal(description?.cliVersion, '0.1.11')
  assert.equal(description?.devices.length, 2)
})

test('an installed Kelpie that found nothing reports an empty list, not absence', () => {
  // The two are different facts downstream: an empty list says "nothing is on
  // this network", absence says "this Kelpie could not tell me".
  const description = kelpieDescriptionFromJson(
    JSON.stringify({ devices: [], schemaVersion: 1 }),
    OBSERVED,
  )
  assert.deepEqual(description?.devices, [])
})

test('a document that is not a describe document yields absence', () => {
  assert.equal(kelpieDescriptionFromJson('not json at all', OBSERVED), undefined)
  assert.equal(kelpieDescriptionFromJson('[]', OBSERVED), undefined)
  assert.equal(kelpieDescriptionFromJson('{"schemaVersion":1}', OBSERVED), undefined)
})

test('a network of more Kelpies than the wire carries truncates here', () => {
  const many = Array.from({ length: 50 }, (_, index) => ({ ...fullEntry, id: `kelpie-${index}` }))
  const description = kelpieDescriptionFromJson(
    JSON.stringify({ devices: many, schemaVersion: 1 }),
    OBSERVED,
  )
  assert.equal(description?.devices.length, 32)
})

test('describe runs the program the policy named, never a kelpie of its own', async () => {
  const seen: string[] = []
  await describeKelpie(
    { command: ['/opt/kelpie/bin/kelpie', 'mcp'], name: 'kelpie' },
    {
      run: async (program) => {
        seen.push(program)
        return { ok: true, stdout: JSON.stringify({ devices: [], schemaVersion: 1 }) }
      },
    },
  )
  assert.deepEqual(seen, ['/opt/kelpie/bin/kelpie'])
})

test('a Kelpie too old to describe itself yields absence rather than an empty inventory', async () => {
  const description = await describeKelpie(
    { command: ['kelpie', 'mcp'], name: 'kelpie' },
    { run: async () => ({ ok: false }) },
  )
  assert.equal(description, undefined)
})
