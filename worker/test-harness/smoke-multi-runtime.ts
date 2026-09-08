import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import http from 'node:http'

export type ManagedProcess = { child: ChildProcess; label: string; log: () => string }
export type MultiInstanceProxy = { close: () => Promise<void>; routes: number[] }
export type ApiReply = { body: Record<string, unknown>; status: number }
export type SseClient = { close: () => void; ended: Promise<void>; ids: number[] }

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

export const createMultiInstanceLifecycle = (input: {
  portBase: number
  repoRoot: string
  verbose: boolean
}) => {
  const started: ManagedProcess[] = []
  // A throw before teardown would orphan a process the next run would then adopt.
  process.once('exit', () => { for (const managed of started) managed.child.kill('SIGKILL') })

  const assertPortFree = (port: number): Promise<void> => new Promise((done, fail) => {
    const probe = http.createServer()
    probe.once('error', () => fail(new Error(`port ${port} is in use — move SMOKE_MULTI_PORT_BASE`)))
    probe.listen(port, '127.0.0.1', () => probe.close(() => done()))
  })

  const startProcess = (
    label: string,
    entry: string,
    env: Record<string, string>,
  ): ManagedProcess => {
    if (!existsSync(entry)) {
      throw new Error(`${label} cannot start: ${entry} is missing — run pnpm exec turbo run build`)
    }
    const child = spawn(process.execPath, [entry], {
      cwd: input.repoRoot, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    const chunks: string[] = []
    const record = (chunk: Buffer): void => {
      chunks.push(String(chunk))
      if (input.verbose) process.stdout.write(`[${label}] ${String(chunk)}`)
    }
    child.stdout?.on('data', record)
    child.stderr?.on('data', record)
    const managed = { child, label, log: () => chunks.join('') }
    started.push(managed)
    return managed
  }

  // SIGTERM, then the escalation every platform performs: `docker stop` and
  // Cloud Run both SIGKILL once their grace expires, compressed to two seconds.
  const signalProcess = async (
    managed: ManagedProcess,
    signal: NodeJS.Signals,
  ): Promise<void> => {
    if (managed.child.exitCode !== null || managed.child.signalCode !== null) return
    const exit = new Promise<void>((done) => managed.child.once('exit', () => done()))
    managed.child.kill(signal)
    await Promise.race([exit, sleep(2_000)])
    if (managed.child.exitCode === null && managed.child.signalCode === null) managed.child.kill('SIGKILL')
    await exit
  }

  // Alternates requests and fails over before response headers, as a load balancer does.
  const startProxy = async (ports: number[]): Promise<MultiInstanceProxy> => {
    const routes: number[] = []
    let cursor = 0
    const server = http.createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        const body = Buffer.concat(chunks)
        const attempt = (remaining: number): void => {
          const index = cursor % ports.length
          cursor += 1
          routes.push(index)
          const port = ports[index]!
          const upstream = http.request(
            {
              agent: false,
              headers: { ...request.headers, host: `127.0.0.1:${port}` },
              host: '127.0.0.1', method: request.method, path: request.url, port,
            },
            (proxied) => {
              response.writeHead(proxied.statusCode ?? 502, proxied.headers)
              response.flushHeaders()
              response.socket?.setNoDelay(true)
              proxied.once('close', () => { if (!response.writableEnded) response.end() })
              proxied.pipe(response)
            },
          )
          upstream.once('error', () => {
            if (response.headersSent) return response.end()
            routes.pop()
            if (remaining > 0) return attempt(remaining - 1)
            response.writeHead(502)
            response.end()
          })
          if (body.length > 0) upstream.write(body)
          upstream.end()
        }
        attempt(ports.length)
      })
    })
    await new Promise<void>((done) => { server.listen(input.portBase, '127.0.0.1', done) })
    return {
      close: () => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()) }),
      routes,
    }
  }

  return { assertPortFree, signalProcess, startProcess, startProxy, started }
}

export const call = async (
  proxyUrl: string,
  method: string,
  path: string,
  token: string | null,
  body?: unknown,
): Promise<ApiReply> => {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers['authorization'] = `Bearer ${token}`
  const response = await fetch(`${proxyUrl}${path}`, {
    body: body === undefined ? undefined : JSON.stringify(body), headers, method,
  })
  const text = await response.text()
  return { body: text ? (JSON.parse(text) as Record<string, unknown>) : {}, status: response.status }
}

// Deliberately raw `http`: the assertion is about the `id:` sequence on the wire.
export const openSse = (proxyUrl: string, path: string, token: string, lastEventId?: number): SseClient => {
  const ids: number[] = []
  let settle: () => void = () => undefined
  const ended = new Promise<void>((done) => { settle = done })
  const headers: Record<string, string> = { accept: 'text/event-stream', authorization: `Bearer ${token}` }
  if (lastEventId !== undefined) headers['last-event-id'] = String(lastEventId)
  let buffer = ''
  const request = http.request(`${proxyUrl}${path}`, { agent: false, headers }, (response) => {
    response.setEncoding('utf8')
    response.on('data', (chunk: string) => {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) if (line.startsWith('id:')) ids.push(Number(line.slice(3).trim()))
    })
    response.on('end', settle)
    response.on('error', settle)
  })
  request.on('error', settle)
  request.end()
  return { close: () => { request.destroy(); settle() }, ended, ids }
}