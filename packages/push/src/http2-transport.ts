/**
 * Real `node:http2` transport for APNs.
 *
 * Keeps a single HTTP/2 session open per host and reuses it across sends. The
 * session is created lazily on first use and recreated if it has been closed.
 */
import {
  connect,
  constants,
  type ClientHttp2Session,
} from 'node:http2'
import type { ApnsTransport, Http2Request, Http2Response } from './transport.js'

const {
  HTTP2_HEADER_METHOD,
  HTTP2_HEADER_PATH,
  HTTP2_HEADER_STATUS,
} = constants

class Http2ApnsTransport implements ApnsTransport {
  private session: ClientHttp2Session | null = null

  constructor(private readonly baseUrl: string) {}

  private getSession(): ClientHttp2Session {
    if (this.session && !this.session.closed && !this.session.destroyed) {
      return this.session
    }
    const session = connect(this.baseUrl)
    // Prevent an idle/errored session from crashing the process; the next send
    // observes the closed session and reconnects.
    session.on('error', () => {
      if (this.session === session) this.session = null
    })
    this.session = session
    return session
  }

  send(request: Http2Request): Promise<Http2Response> {
    return new Promise<Http2Response>((resolve, reject) => {
      const session = this.getSession()
      const stream = session.request({
        ...request.headers,
        [HTTP2_HEADER_METHOD]: request.method,
        [HTTP2_HEADER_PATH]: request.path,
      })

      let status = 0
      let apnsId: string | undefined
      const chunks: Buffer[] = []

      stream.on('response', (headers) => {
        const rawStatus = headers[HTTP2_HEADER_STATUS]
        status = typeof rawStatus === 'number' ? rawStatus : Number(rawStatus)
        const id = headers['apns-id']
        apnsId = Array.isArray(id) ? id[0] : id
      })
      stream.on('data', (chunk: Buffer) => chunks.push(chunk))
      stream.on('end', () => {
        resolve({ status, apnsId, body: Buffer.concat(chunks).toString('utf8') })
      })
      stream.on('error', reject)

      stream.setEncoding('utf8')
      stream.end(request.body)
    })
  }

  close(): Promise<void> {
    return new Promise<void>((resolve) => {
      const session = this.session
      this.session = null
      if (!session || session.closed || session.destroyed) {
        resolve()
        return
      }
      session.close(() => resolve())
    })
  }
}

/** Build a real HTTP/2 APNs transport for the given base URL. */
export const createHttp2Transport = (baseUrl: string): ApnsTransport =>
  new Http2ApnsTransport(baseUrl)
