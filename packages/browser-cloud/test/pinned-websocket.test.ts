import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { Duplex } from 'node:stream'
import { test } from 'node:test'

import { openPinnedWebSocket, __testing } from '../src/pinned-websocket.js'

/**
 * The WebSocket client is hand-written because `safeFetch` cannot carry a CDP
 * connection and the MCP SSE transport is HTTP, not a WebSocket precedent.
 * Hand-written framing is exactly the kind of code that fails silently on a
 * chunk boundary, so these tests drive it through a duplex we control.
 */

type FakeSocket = Duplex & { sent: Buffer[]; feed: (data: Buffer) => void }

const createFakeSocket = (): FakeSocket => {
  const sent: Buffer[] = []
  const duplex = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, callback) {
      sent.push(Buffer.from(chunk))
      callback()
    },
  }) as FakeSocket
  duplex.sent = sent
  duplex.feed = (data: Buffer) => duplex.push(data)
  return duplex
}

const acceptFor = (request: string): string => {
  const key = /sec-websocket-key: (.+)\r\n/i.exec(request)?.[1]?.trim() ?? ''
  return createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64')
}

const handshakeResponse = (accept: string): Buffer =>
  Buffer.from(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '',
      '',
    ].join('\r\n'),
  )

/** A server frame: FIN set, unmasked, as a real server sends. */
const serverFrame = (payload: string, opcode = 0x1): Buffer => {
  const body = Buffer.from(payload, 'utf8')
  let header: Buffer
  if (body.length < 126) {
    header = Buffer.from([0x80 | opcode, body.length])
  } else if (body.length < 65_536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(body.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeBigUInt64BE(BigInt(body.length), 2)
  }
  return Buffer.concat([header, body])
}

const connectFake = async (socket: FakeSocket, onMessage: (payload: string) => void) => {
  const closes: Array<Error | null> = []
  const ws = await openPinnedWebSocket('wss://connect.browserbase.com/session', {
    connectImpl: async () => socket as never,
    onMessage,
    onClose: (error) => closes.push(error),
  })
  // The client writes its handshake immediately; answer it.
  const request = Buffer.concat(socket.sent).toString('latin1')
  socket.sent.length = 0
  socket.feed(handshakeResponse(acceptFor(request)))
  await new Promise((resolve) => setImmediate(resolve))
  return { ws, closes, request }
}

test('completes an RFC 6455 handshake and reads a text frame', async () => {
  const socket = createFakeSocket()
  const messages: string[] = []
  const { request } = await connectFake(socket, (payload) => messages.push(payload))

  assert.match(request, /^GET \/session HTTP\/1\.1\r\n/)
  assert.match(request, /Upgrade: websocket/)
  assert.match(request, /Sec-WebSocket-Version: 13/)

  socket.feed(serverFrame('{"id":1,"result":{}}'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(messages, ['{"id":1,"result":{}}'])
})

test('rejects a handshake whose accept token does not match', async () => {
  const socket = createFakeSocket()
  const closes: Array<Error | null> = []
  await openPinnedWebSocket('wss://connect.browserbase.com/session', {
    connectImpl: async () => socket as never,
    onMessage: () => {},
    onClose: (error) => closes.push(error),
  })
  socket.sent.length = 0
  socket.feed(handshakeResponse('not-the-right-token'))
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(closes.length, 1)
  assert.match(String(closes[0]?.message), /invalid WebSocket accept token/)
})

test('refuses a URL outside Browserbase', async () => {
  await assert.rejects(
    openPinnedWebSocket('wss://evil.example.com/session', {
      connectImpl: async () => createFakeSocket() as never,
      onMessage: () => {},
      onClose: () => {},
    }),
    /outside its own origin/,
  )
})

test('reassembles a message split across chunk boundaries', async () => {
  const socket = createFakeSocket()
  const messages: string[] = []
  await connectFake(socket, (payload) => messages.push(payload))

  // A 300-byte payload uses the 16-bit length path; feed it one byte at a
  // time, which is what a real TCP stream is free to do.
  const payload = JSON.stringify({ id: 2, result: { data: 'x'.repeat(280) } })
  const frame = serverFrame(payload)
  for (const byte of frame) socket.feed(Buffer.from([byte]))
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(messages, [payload])
})

test('reassembles a fragmented message (continuation frames)', async () => {
  const socket = createFakeSocket()
  const messages: string[] = []
  await connectFake(socket, (payload) => messages.push(payload))

  // First fragment: text opcode, FIN clear.
  const first = Buffer.concat([Buffer.from([0x01, 5]), Buffer.from('hello')])
  // Final fragment: continuation opcode, FIN set.
  const last = Buffer.concat([Buffer.from([0x80, 6]), Buffer.from(' world')])
  socket.feed(first)
  socket.feed(last)
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(messages, ['hello world'])
})

test('answers a ping with a masked pong', async () => {
  const socket = createFakeSocket()
  await connectFake(socket, () => {})
  socket.sent.length = 0

  socket.feed(serverFrame('hi', 0x9))
  await new Promise((resolve) => setImmediate(resolve))

  const pong = Buffer.concat(socket.sent)
  assert.equal(pong[0], 0x8a, 'FIN + pong opcode')
  assert.equal((pong[1] as number) & 0x80, 0x80, 'client frames must be masked')
})

test('client frames are masked and round-trip through the decoder', () => {
  const encoded = __testing.encodeFrame(0x1, Buffer.from('round trip'))
  assert.equal((encoded[1] as number) & 0x80, 0x80)
  const decoded = __testing.decodeFrame(encoded)
  assert.equal(decoded?.payload.toString('utf8'), 'round trip')
  assert.equal(decoded?.opcode, 0x1)
  assert.equal(decoded?.fin, true)
})

test('decodeFrame returns null until a whole frame has arrived', () => {
  const encoded = __testing.encodeFrame(0x1, Buffer.from('partial'))
  assert.equal(__testing.decodeFrame(encoded.subarray(0, 3)), null)
  assert.notEqual(__testing.decodeFrame(encoded), null)
})

test('a close frame from the server closes cleanly, not as an error', async () => {
  const socket = createFakeSocket()
  const { closes } = await connectFake(socket, () => {})
  socket.feed(serverFrame('', 0x8))
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(closes, [null])
})
