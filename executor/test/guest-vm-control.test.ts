import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { GuestVmControlClient } from '../src/guest-vm-control.js'

const frameFor = (value: Record<string, unknown>): Buffer => {
  const body = Buffer.from(JSON.stringify(value))
  const frame = Buffer.allocUnsafe(body.length + 4)
  frame.writeUInt32BE(body.length, 0)
  body.copy(frame, 4)
  return frame
}

test('the VM control client accepts only the ready line then one matching framed guest response', async () => {
  const input = new PassThrough()
  const output = new PassThrough()
  const client = new GuestVmControlClient(input, output)
  output.write('{"session":"ready","valid":true,"workspaceAttached":true}\n')
  await client.waitForReady(100)

  const requestFrame = new Promise<Buffer>((resolvePromise) => input.once('data', resolvePromise))
  const inspection = client.inspectRuntime()
  const rawRequest = await requestFrame
  const bodyLength = rawRequest.readUInt32BE(0)
  assert.equal(rawRequest.length, bodyLength + 4)
  const request = JSON.parse(rawRequest.subarray(4).toString('utf8')) as Record<string, unknown>
  assert.equal(request.kind, 'request')
  assert.equal(Buffer.from(String(request.payload), 'base64').toString('utf8'), '{"operation":"runtime.inspect","version":1}')

  output.write(frameFor({
    kind: 'response',
    payload: Buffer.from(JSON.stringify({
      inspection: { browser: true, claude: false, codex: true, tmux: true },
      version: 1,
    })).toString('base64'),
    requestId: request.requestId,
    version: 1,
  }))
  assert.deepEqual(await inspection, { browser: true, claude: false, codex: true, tmux: true })

  const browserFrame = new Promise<Buffer>((resolvePromise) => input.once('data', resolvePromise))
  const opening = client.openBrowser('https://app.example.test/guide')
  const rawBrowserRequest = await browserFrame
  const browserRequest = JSON.parse(rawBrowserRequest.subarray(4).toString('utf8')) as Record<string, unknown>
  assert.equal(Buffer.from(String(browserRequest.payload), 'base64').toString('utf8'), '{"operation":"browser.open","url":"https://app.example.test/guide","version":1}')
  output.write(frameFor({
    kind: 'response',
    payload: Buffer.from('{"status":"started","version":1}').toString('base64'),
    requestId: browserRequest.requestId,
    version: 1,
  }))
  await opening

  const observeFrame = new Promise<Buffer>((resolvePromise) => input.once('data', resolvePromise))
  const observing = client.observeBrowser()
  const rawObserveRequest = await observeFrame
  const observeRequest = JSON.parse(rawObserveRequest.subarray(4).toString('utf8')) as Record<string, unknown>
  assert.equal(Buffer.from(String(observeRequest.payload), 'base64').toString('utf8'), '{"operation":"browser.observe","version":1}')
  output.write(frameFor({
    kind: 'response',
    payload: Buffer.from(JSON.stringify({
      observation: { targets: [{ title: 'Guide', type: 'page', url: 'https://app.example.test/guide' }] },
      version: 1,
    })).toString('base64'),
    requestId: observeRequest.requestId,
    version: 1,
  }))
  assert.deepEqual(await observing, {
    targets: [{ title: 'Guide', type: 'page', url: 'https://app.example.test/guide' }],
  })

  const codingLaunchFrame = new Promise<Buffer>((resolvePromise) => input.once('data', resolvePromise))
  const launchingCoding = client.launchCodingSession('codex')
  const rawCodingLaunch = await codingLaunchFrame
  const codingLaunch = JSON.parse(rawCodingLaunch.subarray(4).toString('utf8')) as Record<string, unknown>
  assert.equal(Buffer.from(String(codingLaunch.payload), 'base64').toString('utf8'), '{"agent":"codex","operation":"coding.launch","version":1}')
  output.write(frameFor({
    kind: 'response',
    payload: Buffer.from('{"agent":"codex","status":"started","version":1}').toString('base64'),
    requestId: codingLaunch.requestId,
    version: 1,
  }))
  await launchingCoding

  const codingObserveFrame = new Promise<Buffer>((resolvePromise) => input.once('data', resolvePromise))
  const observingCoding = client.observeCodingSession()
  const rawCodingObserve = await codingObserveFrame
  const codingObserve = JSON.parse(rawCodingObserve.subarray(4).toString('utf8')) as Record<string, unknown>
  assert.equal(Buffer.from(String(codingObserve.payload), 'base64').toString('utf8'), '{"operation":"coding.observe","version":1}')
  output.write(frameFor({
    kind: 'response',
    payload: Buffer.from(JSON.stringify({
      observation: { agent: 'codex', lifecycle: 'exited', exitStatus: 0, output: 'Done' },
      version: 1,
    })).toString('base64'),
    requestId: codingObserve.requestId,
    version: 1,
  }))
  assert.deepEqual(await observingCoding, { agent: 'codex', lifecycle: 'exited', exitStatus: 0, output: 'Done' })

  const codingCloseFrame = new Promise<Buffer>((resolvePromise) => input.once('data', resolvePromise))
  const closingCoding = client.closeCodingSession()
  const rawCodingClose = await codingCloseFrame
  const codingClose = JSON.parse(rawCodingClose.subarray(4).toString('utf8')) as Record<string, unknown>
  assert.equal(Buffer.from(String(codingClose.payload), 'base64').toString('utf8'), '{"operation":"coding.close","version":1}')
  output.write(frameFor({
    kind: 'response',
    payload: Buffer.from('{"status":"closed","version":1}').toString('base64'),
    requestId: codingClose.requestId,
    version: 1,
  }))
  await closingCoding
  client.close()
})
