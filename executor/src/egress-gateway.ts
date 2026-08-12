import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { chmod, lstat } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { Readable, Transform, type Duplex } from 'node:stream'

import { pinnedConnect, pinnedFetch } from '@nessie/runtime/url-safety'

import type { CodingSessionBroker } from './coding-session-broker.js'
import {
  compileExecutorEgressPolicy,
  assertExecutorEgressOrigin,
  type ExecutorEgressPolicy,
  type ExecutorEgressSettings,
} from './egress-policy.js'

const SOCKET_PATH_MAX_CHARS = 96
const OWNER_ONLY_MASK = 0o077
const CODING_CREDENTIAL_PATH = '/.nessie/coding-credential'
const CODING_REQUEST_MAX_BYTES = 4 * 1_024 * 1_024
const CODING_RESPONSE_MAX_BYTES = 16 * 1_024 * 1_024

type CloseableGateway = {
  close: () => Promise<void>
  socketPath: string
}

type GatewayDependencies = {
  pinnedFetch?: typeof pinnedFetch
}

const socketFailure = (socket: Duplex, status: number, message: string): void => {
  socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
}

const assertOwnerOnlySocketParent = async (rawSocketPath: string): Promise<string> => {
  if (!isAbsolute(rawSocketPath)) {
    throw new Error('The executor egress socket path must be absolute.')
  }
  const socketPath = resolve(rawSocketPath)
  if (socketPath.length > SOCKET_PATH_MAX_CHARS) {
    throw new Error('The executor egress socket path is too long.')
  }
  const parent = dirname(socketPath)
  const metadata = await lstat(parent)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('The executor egress socket parent must be an ordinary directory.')
  }
  if (process.getuid?.() !== undefined && metadata.uid !== process.getuid()) {
    throw new Error('The executor egress socket parent must be owned by the current user.')
  }
  if ((metadata.mode & OWNER_ONLY_MASK) !== 0) {
    throw new Error('The executor egress socket parent must be owner-only.')
  }
  try {
    await lstat(socketPath)
    throw new Error('The executor egress socket path already exists.')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return socketPath
}

const requestTarget = (request: IncomingMessage): string | null => {
  const rawAuthority = request.url
  if (!rawAuthority || /[\s/?#@]/.test(rawAuthority)) return null
  try {
    const target = new URL(`https://${rawAuthority}`)
    // The browser's encrypted request determines the HTTP path. The gateway
    // accepts only canonical HTTPS, never arbitrary proxy ports or schemes.
    return target.port || target.protocol !== 'https:' ? null : target.toString()
  } catch {
    return null
  }
}

const responseError = (response: ServerResponse, status: number): void => {
  if (response.headersSent) {
    response.destroy()
    return
  }
  response.writeHead(status, { connection: 'close', 'content-length': '0' })
  response.end()
}

const singleHeader = (request: IncomingMessage, name: string): string | undefined => {
  const value = request.headers[name]
  return typeof value === 'string' ? value : undefined
}

const clientToken = (request: IncomingMessage): string | undefined => {
  const authorization = singleHeader(request, 'authorization')
  if (!authorization || !/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization)) return undefined
  return authorization.slice('Bearer '.length)
}

const boundedRequest = (request: IncomingMessage): Readable => {
  const declared = singleHeader(request, 'content-length')
  if (declared !== undefined && (!/^[0-9]+$/.test(declared) || Number(declared) > CODING_REQUEST_MAX_BYTES)) {
    request.destroy()
    throw new Error('request too large')
  }
  let received = 0
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length
      if (received > CODING_REQUEST_MAX_BYTES) {
        callback(new Error('request too large'))
        return
      }
      callback(null, chunk)
    },
  })
  request.once('error', () => limiter.destroy())
  return request.pipe(limiter)
}

const boundedResponse = (body: ReadableStream<Uint8Array>, response: ServerResponse): void => {
  let received = 0
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length
      if (received > CODING_RESPONSE_MAX_BYTES) {
        callback(new Error('response too large'))
        return
      }
      callback(null, chunk)
    },
  })
  const stream = Readable.fromWeb(body)
  stream.once('error', () => response.destroy())
  limiter.once('error', () => {
    stream.destroy()
    response.destroy()
  })
  stream.pipe(limiter).pipe(response)
}

const codingPathForProvider = (provider: 'anthropic' | 'openai', rawPath: string | undefined): URL | undefined => {
  if (!rawPath || rawPath.includes('?') || rawPath.includes('#') || rawPath.startsWith('//')) return undefined
  if (provider === 'openai' && rawPath === '/v1/responses') return new URL('https://api.openai.com/v1/responses')
  if (provider === 'anthropic' && (rawPath === '/v1/messages' || rawPath === '/v1/messages/count_tokens')) {
    return new URL(`https://api.anthropic.com${rawPath}`)
  }
  return undefined
}

const contentType = (request: IncomingMessage): string | undefined => {
  const value = singleHeader(request, 'content-type')
  return value && /^application\/json(?:;\s*charset=utf-8)?$/i.test(value) ? value : undefined
}

const codingHeaders = (input: {
  accept?: string
  authorization: Record<string, string>
  contentType: string
  provider: 'anthropic' | 'openai'
}): Record<string, string> => ({
  accept: input.accept && input.accept.length <= 128 && /^[\u0020-\u007e]+$/.test(input.accept)
    ? input.accept
    : 'application/json',
  ...input.authorization,
  ...(input.provider === 'anthropic' ? { 'anthropic-version': '2023-06-01' } : {}),
  'content-type': input.contentType,
  'user-agent': 'Nessie Executor/1',
})

const issueCodingToken = (
  request: IncomingMessage,
  response: ServerResponse,
  broker: CodingSessionBroker,
): void => {
  const proof = singleHeader(request, 'x-nessie-session-proof')
  if (
    request.method !== 'GET'
    || request.url !== CODING_CREDENTIAL_PATH
    || !proof
    || singleHeader(request, 'content-length') !== undefined
    || singleHeader(request, 'transfer-encoding') !== undefined
  ) {
    responseError(response, 403)
    return
  }
  request.resume()
  request.once('end', () => {
    const token = broker.issueClientToken(proof)
    if (!token) {
      responseError(response, 403)
      return
    }
    response.writeHead(200, {
      'cache-control': 'no-store',
      connection: 'close',
      'content-length': String(token.length + 1),
      'content-type': 'text/plain; charset=utf-8',
    })
    response.end(`${token}\n`)
  })
  request.once('error', () => responseError(response, 400))
}

const forwardCodingRequest = async (
  request: IncomingMessage,
  response: ServerResponse,
  broker: CodingSessionBroker,
  fetchPinned: typeof pinnedFetch,
): Promise<void> => {
  if (request.method === 'GET' && request.url === CODING_CREDENTIAL_PATH) {
    issueCodingToken(request, response, broker)
    return
  }
  const token = clientToken(request)
  const authorization = token ? broker.authorize(token) : undefined
  const target = authorization && codingPathForProvider(authorization.provider, request.url)
  const type = contentType(request)
  if (request.method !== 'POST' || !authorization || !target || !type) {
    responseError(response, 403)
    return
  }
  let body: Readable
  try {
    body = boundedRequest(request)
  } catch {
    responseError(response, 413)
    return
  }
  const abort = new AbortController()
  response.once('close', () => abort.abort())
  try {
    // PinnedFetch deliberately returns the first response rather than following
    // a redirect. Reusing an injected provider credential across origins would
    // be unsafe even when each redirected host is individually SSRF-safe.
    const upstream = await fetchPinned(target, {
      body: Readable.toWeb(body) as ReadableStream<Uint8Array>,
      // Node fetch requires this flag for a streaming request body. It is not
      // part of the DOM RequestInit type yet used by @nessie/runtime.
      duplex: 'half',
      headers: codingHeaders({
        accept: singleHeader(request, 'accept'),
        authorization: authorization.headers,
        contentType: type,
        provider: authorization.provider,
      }),
      method: 'POST',
      signal: abort.signal,
    } as RequestInit)
    if (upstream.status >= 300 && upstream.status < 400) {
      await upstream.body?.cancel().catch(() => undefined)
      responseError(response, 502)
      return
    }
    response.writeHead(upstream.status, {
      'cache-control': 'no-store',
      connection: 'close',
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
    })
    if (!upstream.body) {
      response.end()
      return
    }
    boundedResponse(upstream.body, response)
  } catch {
    responseError(response, 502)
  }
}

const listen = async (server: Server, socketPath: string): Promise<void> => new Promise((resolvePromise, reject) => {
  const fail = (error: Error): void => {
    server.off('listening', ready)
    reject(error)
  }
  const ready = (): void => {
    server.off('error', fail)
    resolvePromise()
  }
  server.once('error', fail)
  server.once('listening', ready)
  server.listen(socketPath)
})

/**
 * Starts a daemon-private CONNECT gateway. It has no TCP listener and permits
 * HTTPS only through explicit locally approved origins. Its only ordinary HTTP
 * route is an optional session-scoped coding broker with fixed provider paths;
 * it never becomes a generic forwarding proxy. A VM bridge may carry one
 * guest-facing transport to this Unix socket; nothing binds a browser or coding
 * descriptor to it yet.
 */
export const startExecutorEgressGateway = async (input: {
  codingBroker?: CodingSessionBroker
  policy: ExecutorEgressPolicy
  socketPath: string
}, dependencies: GatewayDependencies = {}): Promise<CloseableGateway> => {
  const settings = compileExecutorEgressPolicy(input.policy)
  const socketPath = await assertOwnerOnlySocketParent(input.socketPath)
  const fetchPinned = dependencies.pinnedFetch ?? pinnedFetch
  let activeTunnels = 0
  const server = createServer((request, response) => {
    if (!input.codingBroker) {
      responseError(response, 405)
      return
    }
    void forwardCodingRequest(request, response, input.codingBroker, fetchPinned)
  })
  server.on('connect', (request, clientSocket, head) => {
    if (activeTunnels >= settings.maxConcurrentTunnels) {
      socketFailure(clientSocket, 429, 'Too Many Requests')
      return
    }
    const target = requestTarget(request)
    if (!target) {
      socketFailure(clientSocket, 400, 'Bad Request')
      return
    }
    activeTunnels += 1
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      activeTunnels -= 1
    }
    clientSocket.once('close', release)
    void (async () => {
      try {
        assertExecutorEgressOrigin(target, settings)
        const { socket: upstream } = await pinnedConnect(target)
        upstream.once('close', release)
        upstream.once('error', () => clientSocket.destroy())
        clientSocket.once('error', () => upstream.destroy())
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length > 0) upstream.write(head)
        clientSocket.pipe(upstream)
        upstream.pipe(clientSocket)
      } catch {
        socketFailure(clientSocket, 403, 'Forbidden')
      }
    })()
  })
  // The listen promise handles startup errors; a later transport error should
  // close the socket rather than become an unhandled EventEmitter exception.
  server.on('error', () => undefined)
  await listen(server, socketPath)
  await chmod(socketPath, 0o600)
  return {
    close: async () => new Promise((resolvePromise, reject) => {
      server.close((error) => (error ? reject(error) : resolvePromise()))
    }),
    socketPath,
  }
}

export type { ExecutorEgressSettings }
