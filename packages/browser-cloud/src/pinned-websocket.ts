import { randomBytes, createHash } from 'node:crypto'
import type { Socket } from 'node:net'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'

import { pinnedConnect } from '@nessie/runtime'

import { CLOUD_BROWSER_ERROR_CODES, CloudBrowserError } from './errors.js'
import { assertBrowserbaseUrl } from './browserbase-client.js'

/**
 * A WebSocket client that keeps the egress invariant.
 *
 * `safeFetch` covers HTTP; a CDP connection is a WebSocket, and the MCP SSE
 * transport is not a precedent for one — it rides HTTP. So this is built
 * directly on `pinnedConnect`, the sanctioned escape hatch that resolves and
 * validates a URL, then hands back a raw TCP socket already connected to one
 * vetted address. TLS is layered on top with the original hostname as SNI (so
 * certificate verification still checks the name, not the address), and the
 * RFC 6455 handshake and framing are done here.
 *
 * Deliberately minimal: text frames, ping/pong, close. No extensions, no
 * compression, no fragmentation on send — CDP commands are small JSON objects.
 * Reads must handle fragmentation and 64-bit lengths, because a screenshot
 * comes back as one large base64 payload.
 */

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

const OPCODE = {
  continuation: 0x0,
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa,
} as const

export type PinnedWebSocket = {
  send: (payload: string) => void
  close: () => void
  /** Resolves when the socket is fully closed, for whatever reason. */
  closed: Promise<void>
}

export type PinnedWebSocketOptions = {
  /** Bytes. A frame larger than this closes the connection. */
  maxMessageBytes?: number
  onMessage: (payload: string) => void
  onClose: (error: Error | null) => void
  /** Test seam: supply a duplex instead of dialling. */
  connectImpl?: (url: URL) => Promise<Socket | TLSSocket>
}

const DEFAULT_MAX_MESSAGE_BYTES = 32 * 1024 * 1024

const dialTls = async (url: URL): Promise<TLSSocket> => {
  // `pinnedConnect` requires https:, and validates + pins before returning.
  const httpsUrl = new URL(url.toString())
  httpsUrl.protocol = 'https:'
  const { socket } = await pinnedConnect(httpsUrl)
  return new Promise<TLSSocket>((resolve, reject) => {
    const tlsSocket = tlsConnect(
      { socket, servername: url.hostname },
      () => {
        if (!tlsSocket.authorized && tlsSocket.authorizationError) {
          tlsSocket.destroy()
          reject(new CloudBrowserError(
            CLOUD_BROWSER_ERROR_CODES.UNTRUSTED_ENDPOINT,
            `TLS verification failed: ${String(tlsSocket.authorizationError)}`,
          ))
          return
        }
        resolve(tlsSocket)
      },
    )
    tlsSocket.once('error', reject)
  })
}

const buildHandshake = (url: URL, key: string): string => {
  const path = `${url.pathname}${url.search}`
  return [
    `GET ${path || '/'} HTTP/1.1`,
    `Host: ${url.host}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13',
    '',
    '',
  ].join('\r\n')
}

const expectedAccept = (key: string): string =>
  createHash('sha1').update(`${key}${WS_GUID}`).digest('base64')

/** Client frames must be masked (RFC 6455 §5.3). */
const encodeFrame = (opcode: number, payload: Buffer): Buffer => {
  const mask = randomBytes(4)
  const length = payload.length
  let header: Buffer
  if (length < 126) {
    header = Buffer.alloc(2)
    header[1] = 0x80 | length
  } else if (length < 65_536) {
    header = Buffer.alloc(4)
    header[1] = 0x80 | 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  header[0] = 0x80 | opcode
  const masked = Buffer.allocUnsafe(length)
  for (let index = 0; index < length; index += 1) {
    masked[index] = (payload[index] as number) ^ (mask[index % 4] as number)
  }
  return Buffer.concat([header, mask, masked])
}

type ParsedFrame = {
  fin: boolean
  opcode: number
  payload: Buffer
  totalLength: number
}

/** Returns null when the buffer does not yet hold a whole frame. */
const decodeFrame = (buffer: Buffer): ParsedFrame | null => {
  if (buffer.length < 2) return null
  const first = buffer[0] as number
  const second = buffer[1] as number
  const fin = (first & 0x80) !== 0
  const opcode = first & 0x0f
  // A server frame is never masked; length parsing below assumes that.
  const masked = (second & 0x80) !== 0
  let length = second & 0x7f
  let offset = 2
  if (length === 126) {
    if (buffer.length < offset + 2) return null
    length = buffer.readUInt16BE(offset)
    offset += 2
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null
    const big = buffer.readBigUInt64BE(offset)
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new CloudBrowserError(
        CLOUD_BROWSER_ERROR_CODES.COMMAND_FAILED,
        'The browser sent an oversized WebSocket frame.',
      )
    }
    length = Number(big)
    offset += 8
  }
  let maskKey: Buffer | null = null
  if (masked) {
    if (buffer.length < offset + 4) return null
    maskKey = buffer.subarray(offset, offset + 4)
    offset += 4
  }
  if (buffer.length < offset + length) return null
  const raw = buffer.subarray(offset, offset + length)
  const payload = maskKey
    ? Buffer.from(raw.map((byte, index) => byte ^ (maskKey[index % 4] as number)))
    : Buffer.from(raw)
  return { fin, opcode, payload, totalLength: offset + length }
}

export const openPinnedWebSocket = async (
  rawUrl: string,
  options: PinnedWebSocketOptions,
): Promise<PinnedWebSocket> => {
  const url = assertBrowserbaseUrl(rawUrl)
  const maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES
  const socket = options.connectImpl
    ? await options.connectImpl(url)
    : await dialTls(url)

  const key = randomBytes(16).toString('base64')
  let handshakeDone = false
  // Explicitly `ArrayBufferLike`: `subarray` narrows to that, and the default
  // from `Buffer.alloc` is `ArrayBuffer`, which will not accept it back.
  let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  let fragmentOpcode: number | null = null
  let fragments: Buffer[] = []
  let settled = false
  let resolveClosed: () => void = () => {}
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })

  const finish = (error: Error | null): void => {
    if (settled) return
    settled = true
    socket.destroy()
    options.onClose(error)
    resolveClosed()
  }

  const handleFrame = (frame: ParsedFrame): void => {
    if (frame.opcode === OPCODE.ping) {
      socket.write(encodeFrame(OPCODE.pong, frame.payload))
      return
    }
    if (frame.opcode === OPCODE.pong) return
    if (frame.opcode === OPCODE.close) {
      socket.write(encodeFrame(OPCODE.close, Buffer.alloc(0)))
      finish(null)
      return
    }
    if (frame.opcode === OPCODE.continuation) {
      if (fragmentOpcode === null) {
        finish(new CloudBrowserError(
          CLOUD_BROWSER_ERROR_CODES.COMMAND_FAILED,
          'The browser sent a continuation frame with nothing to continue.',
        ))
        return
      }
      fragments.push(frame.payload)
    } else {
      fragmentOpcode = frame.opcode
      fragments = [frame.payload]
    }
    if (!frame.fin) return
    const complete = Buffer.concat(fragments)
    const opcode = fragmentOpcode
    fragmentOpcode = null
    fragments = []
    if (opcode === OPCODE.text) options.onMessage(complete.toString('utf8'))
  }

  socket.on('data', (chunk: Buffer) => {
    if (settled) return
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
    if (buffer.length > maxMessageBytes) {
      finish(new CloudBrowserError(
        CLOUD_BROWSER_ERROR_CODES.COMMAND_FAILED,
        'The browser sent more data than the transport allows.',
      ))
      return
    }
    if (!handshakeDone) {
      const separator = buffer.indexOf('\r\n\r\n')
      if (separator === -1) return
      const head = buffer.subarray(0, separator).toString('latin1')
      buffer = buffer.subarray(separator + 4)
      const statusLine = head.split('\r\n')[0] ?? ''
      if (!statusLine.includes(' 101')) {
        finish(new CloudBrowserError(
          CLOUD_BROWSER_ERROR_CODES.UNREACHABLE,
          `The browser refused the WebSocket upgrade: ${statusLine}`,
        ))
        return
      }
      const acceptHeader = head
        .split('\r\n')
        .map((line) => line.split(':'))
        .find(([name]) => name?.toLowerCase().trim() === 'sec-websocket-accept')
      const accept = acceptHeader?.slice(1).join(':').trim()
      if (accept !== expectedAccept(key)) {
        finish(new CloudBrowserError(
          CLOUD_BROWSER_ERROR_CODES.UNTRUSTED_ENDPOINT,
          'The browser returned an invalid WebSocket accept token.',
        ))
        return
      }
      handshakeDone = true
    }
    try {
      for (;;) {
        const frame = decodeFrame(buffer)
        if (!frame) break
        buffer = buffer.subarray(frame.totalLength)
        handleFrame(frame)
        if (settled) return
      }
    } catch (error) {
      finish(error as Error)
    }
  })

  socket.on('error', (error: Error) => finish(error))
  socket.on('close', () => finish(null))

  socket.write(buildHandshake(url, key))

  return {
    send: (payload) => {
      if (settled) {
        throw new CloudBrowserError(
          CLOUD_BROWSER_ERROR_CODES.NO_SESSION,
          'The browser connection is closed.',
        )
      }
      socket.write(encodeFrame(OPCODE.text, Buffer.from(payload, 'utf8')))
    },
    close: () => {
      if (settled) return
      socket.write(encodeFrame(OPCODE.close, Buffer.alloc(0)))
      finish(null)
    },
    closed,
  }
}

export const __testing = { decodeFrame, encodeFrame, expectedAccept, buildHandshake }
