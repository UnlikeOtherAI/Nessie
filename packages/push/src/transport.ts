/**
 * Injectable transports.
 *
 * Both senders take their network call behind a small interface so tests can
 * feed fake responses without touching the network. The real implementations
 * use `node:http2` (APNs) and global `fetch` (FCM); tests pass stubs.
 */

/** A single APNs request over an HTTP/2 session. */
export interface Http2Request {
  method: 'POST'
  path: string
  headers: Record<string, string>
  body: string
}

/** The response from an APNs HTTP/2 request. */
export interface Http2Response {
  status: number
  /** Parsed `apns-id` response header, if present. */
  apnsId?: string
  /** Raw response body (APNs returns JSON `{ reason }` on errors). */
  body: string
}

/**
 * An APNs transport bound to one host. `send` issues one request; `close`
 * tears down any underlying session.
 */
export interface ApnsTransport {
  send(request: Http2Request): Promise<Http2Response>
  close(): Promise<void>
}

/** Factory: build a transport for the given APNs base URL (host origin). */
export type ApnsTransportFactory = (baseUrl: string) => ApnsTransport

/** Minimal response shape the FCM sender needs from a fetch call. */
export interface FetchLikeResponse {
  status: number
  text(): Promise<string>
}

/** A fetch-like function (the global `fetch`, or a test stub). */
export type FetchLike = (
  url: string,
  init: {
    method: string
    headers: Record<string, string>
    body: string
  },
) => Promise<FetchLikeResponse>
