import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http'
import { mkdir } from 'node:fs/promises'
import { createConnection, type Socket } from 'node:net'
import { join } from 'node:path'

/**
 * A stand-in for `jailer` + `firecracker` + one booted guest. It is deliberately
 * built from the real transports the backend uses — an HTTP server on a Unix
 * socket and a Unix client speaking the guest's own frame format — so the test
 * exercises framing and sequencing rather than a mock's idea of them.
 */
export type FakeFirecracker = {
  /** The jailer's `--chroot-base-dir`, which the backend chooses itself. */
  chrootBaseDirectory: string
  chrootDirectory: string
  child: ChildProcess
  /** Every `PUT` the backend issued, in order. */
  calls: Array<{ body: unknown; path: string }>
  /** The jailer argv the backend built. */
  jailerArgv: string[]
  jailerPath: string
  stop: () => Promise<void>
}

const readBody = (request: IncomingMessage): Promise<string> => new Promise((resolvePromise) => {
  const chunks: Buffer[] = []
  request.on('data', (chunk: Buffer) => chunks.push(chunk))
  request.once('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')))
})

export const encodeGuestFrame = (envelope: Record<string, unknown>): Buffer => {
  const body = Buffer.from(JSON.stringify(envelope), 'utf8')
  const frame = Buffer.allocUnsafe(body.byteLength + 4)
  frame.writeUInt32BE(body.byteLength, 0)
  body.copy(frame, 4)
  return frame
}

/** The guest never exits on its own; it is killed with the micro-VM. */
const idleChild = (): ChildProcess =>
  spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })

/**
 * Answers control requests as the guest would: one response per request, on the
 * request's own id. `respond` maps a decoded request payload to a payload.
 */
const speakAsGuest = (socket: Socket, token: string, respond: (request: unknown) => unknown): void => {
  socket.write(encodeGuestFrame({
    kind: 'hello',
    payload: '',
    requestId: randomUUID(),
    sessionToken: token,
    version: 1,
  }))
  let buffered = Buffer.alloc(0)
  socket.on('data', (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk])
    while (buffered.byteLength >= 4) {
      const length = buffered.readUInt32BE(0)
      if (buffered.byteLength < length + 4) return
      const envelope = JSON.parse(buffered.subarray(4, length + 4).toString('utf8')) as {
        payload: string
        requestId: string
      }
      buffered = buffered.subarray(length + 4)
      const request: unknown = JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8'))
      socket.write(encodeGuestFrame({
        kind: 'response',
        payload: Buffer.from(JSON.stringify(respond(request)), 'utf8').toString('base64'),
        requestId: envelope.requestId,
        version: 1,
      }))
    }
  })
}

export const createFakeFirecracker = (input: {
  bootstrapToken: string
  /** Skip the guest's control connection, so `start` fails on readiness. */
  bootGuest?: boolean
  respond?: (request: unknown) => unknown
  runtimeDirectory: string
}): { fake: FakeFirecracker; spawnProcess: (path: string, argv: string[]) => ChildProcess } => {
  const calls: FakeFirecracker['calls'] = []
  let server: HttpServer | undefined
  let child: ChildProcess | undefined
  let guest: Socket | undefined
  let chrootBaseDirectory = ''
  let chrootDirectory = ''
  let jailerArgv: string[] = []
  let jailerPath = ''
  const respond = input.respond ?? (() => ({
    inspection: { browser: true, claude: false, codex: true, tmux: true },
    version: 1,
  }))
  const spawnProcess = (path: string, argv: string[]): ChildProcess => {
    jailerPath = path
    jailerArgv = argv
    const base = argv[argv.indexOf('--chroot-base-dir') + 1]!
    chrootBaseDirectory = base
    const id = argv[argv.indexOf('--id') + 1]!
    const execFile = argv[argv.indexOf('--exec-file') + 1]!
    chrootDirectory = join(base, execFile.split('/').pop()!, id, 'root')
    child = idleChild()
    void (async () => {
      // Exactly what the jailer does before exec'ing Firecracker: build the
      // chroot, then let the jailed binary bind its API socket inside it.
      await mkdir(chrootDirectory, { mode: 0o700, recursive: true })
      const created = createServer((request, response) => {
        void (async () => {
          const raw = await readBody(request)
          calls.push({ body: JSON.parse(raw) as unknown, path: request.url ?? '' })
          const action = JSON.parse(raw) as { action_type?: string }
          if (request.url === '/actions' && action.action_type === 'InstanceStart' && input.bootGuest !== false) {
            guest = createConnection({ path: join(chrootDirectory, 'v.sock_49152') })
            guest.once('connect', () => speakAsGuest(guest!, input.bootstrapToken, respond))
            guest.once('error', () => undefined)
          }
          response.writeHead(204, { 'content-length': '0' })
          response.end()
        })()
      })
      created.on('error', () => undefined)
      server = created
      created.listen(join(chrootDirectory, 'firecracker.socket'))
    })()
    return child
  }
  const fake: FakeFirecracker = {
    get calls() { return calls },
    get child() { return child! },
    get chrootBaseDirectory() { return chrootBaseDirectory },
    get chrootDirectory() { return chrootDirectory },
    get jailerArgv() { return jailerArgv },
    get jailerPath() { return jailerPath },
    stop: async () => {
      guest?.destroy()
      await new Promise<void>((resolvePromise) => {
        if (!server) { resolvePromise(); return }
        server.close(() => resolvePromise())
      })
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    },
  }
  return { fake, spawnProcess }
}
