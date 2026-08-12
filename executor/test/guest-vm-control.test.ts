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
  client.close()
})
