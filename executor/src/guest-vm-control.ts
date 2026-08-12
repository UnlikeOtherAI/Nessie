import { randomUUID } from 'node:crypto'
import type { Readable, Writable } from 'node:stream'

import { WorkspacePathError } from './workspace-paths.js'

const FRAME_MAX_BYTES = 65_536
const READY_MAX_BYTES = 4_096
const CONTROL_TIMEOUT_MS = 35_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type PendingRequest = {
  reject: (error: Error) => void
  resolve: (payload: Buffer) => void
  timeout: NodeJS.Timeout
  requestId: string
}

type GuestControlEnvelope = {
  kind: 'response'
  payload: Buffer
  requestId: string
}

export type GuestRuntimeInspection = {
  browser: boolean
  claude: boolean
  codex: boolean
  tmux: boolean
}

const unavailable = (message: string): WorkspacePathError => new WorkspacePathError(message)

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
)

const decodePayload = (value: unknown): Buffer => {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw unavailable('The executor VM helper emitted an invalid control response.')
  }
  return Buffer.from(value, 'base64')
}

const decodeResponse = (frame: Buffer): GuestControlEnvelope => {
  let value: unknown
  try {
    value = JSON.parse(frame.toString('utf8'))
  } catch {
    throw unavailable('The executor VM helper emitted an invalid control response.')
  }
  if (!isRecord(value) || Object.keys(value).some((key) => !['kind', 'payload', 'requestId', 'version'].includes(key))) {
    throw unavailable('The executor VM helper emitted an invalid control response.')
  }
  if (value.kind !== 'response' || value.version !== 1 || typeof value.requestId !== 'string' || !UUID.test(value.requestId)) {
    throw unavailable('The executor VM helper emitted an invalid control response.')
  }
  return { kind: 'response', payload: decodePayload(value.payload), requestId: value.requestId }
}

const encodeRequest = (payload: Buffer, requestId: string): Buffer => {
  const body = Buffer.from(JSON.stringify({
    kind: 'request',
    payload: payload.toString('base64'),
    requestId,
    version: 1,
  }))
  if (body.length > FRAME_MAX_BYTES - 4) throw unavailable('The executor control request is too large.')
  const frame = Buffer.allocUnsafe(body.length + 4)
  frame.writeUInt32BE(body.length, 0)
  body.copy(frame, 4)
  return frame
}

const parseInspection = (payload: Buffer): GuestRuntimeInspection => {
  let value: unknown
  try {
    value = JSON.parse(payload.toString('utf8'))
  } catch {
    throw unavailable('The executor guest rejected the runtime inspection request.')
  }
  if (!isRecord(value) || Object.keys(value).some((key) => !['inspection', 'version'].includes(key)) || value.version !== 1 || !isRecord(value.inspection)) {
    throw unavailable('The executor guest rejected the runtime inspection request.')
  }
  const inspection = value.inspection
  if (
    Object.keys(inspection).some((key) => !['browser', 'claude', 'codex', 'tmux'].includes(key))
    || typeof inspection.browser !== 'boolean'
    || typeof inspection.claude !== 'boolean'
    || typeof inspection.codex !== 'boolean'
    || typeof inspection.tmux !== 'boolean'
  ) {
    throw unavailable('The executor guest rejected the runtime inspection request.')
  }
  return {
    browser: inspection.browser,
    claude: inspection.claude,
    codex: inspection.codex,
    tmux: inspection.tmux,
  }
}

const parseBrowserOpen = (payload: Buffer): void => {
  let value: unknown
  try {
    value = JSON.parse(payload.toString('utf8'))
  } catch {
    throw unavailable('The executor guest rejected the browser launch request.')
  }
  if (
    !isRecord(value)
    || Object.keys(value).some((key) => !['status', 'version'].includes(key))
    || value.status !== 'started'
    || value.version !== 1
  ) {
    throw unavailable('The executor guest rejected the browser launch request.')
  }
}

/** Owns the helper's private stdin/stdout framing after its one-use bootstrap. */
export class GuestVmControlClient {
  private output = Buffer.alloc(0)
  private closed = false
  private pending: PendingRequest | undefined
  private ready = false
  private readyError: Error | undefined
  private readonly readyPromise: Promise<void>
  private rejectReady: ((error: Error) => void) | undefined
  private resolveReady: (() => void) | undefined

  constructor(private readonly input: Writable, output: Readable) {
    this.readyPromise = new Promise<void>((resolvePromise, reject) => {
      this.resolveReady = resolvePromise
      this.rejectReady = reject
    })
    output.on('data', (chunk: Buffer) => this.receive(Buffer.from(chunk)))
    output.once('error', () => this.close(unavailable('The executor VM helper is unavailable.')))
    input.once('error', () => this.close(unavailable('The executor VM helper is unavailable.')))
  }

  waitForReady(timeoutMs: number): Promise<void> {
    const timeout = setTimeout(() => {
      this.close(unavailable('The executor VM helper timed out.'))
    }, timeoutMs)
    return this.readyPromise.finally(() => clearTimeout(timeout))
  }

  async inspectRuntime(): Promise<GuestRuntimeInspection> {
    const payload = await this.request(Buffer.from(JSON.stringify({ operation: 'runtime.inspect', version: 1 })))
    return parseInspection(payload)
  }

  async openBrowser(url: string): Promise<void> {
    const payload = await this.request(Buffer.from(JSON.stringify({ operation: 'browser.open', url, version: 1 })))
    parseBrowserOpen(payload)
  }

  close(error: Error = unavailable('The executor VM helper closed its control pipe.')): void {
    if (this.closed) return
    this.closed = true
    if (!this.ready && !this.readyError) {
      this.readyError = error
      this.rejectReady?.(error)
    }
    if (this.pending) {
      clearTimeout(this.pending.timeout)
      this.pending.reject(error)
      this.pending = undefined
    }
  }

  private request(payload: Buffer): Promise<Buffer> {
    if (this.closed || !this.ready || this.readyError) return Promise.reject(unavailable('The executor VM helper is unavailable.'))
    if (this.pending) return Promise.reject(unavailable('The executor VM already has an active control request.'))
    if (payload.length > 32_768) return Promise.reject(unavailable('The executor control request is too large.'))
    const requestId = randomUUID()
    return new Promise<Buffer>((resolvePromise, reject) => {
      const timeout = setTimeout(() => {
        this.close(unavailable('The executor guest timed out.'))
      }, CONTROL_TIMEOUT_MS)
      this.pending = { reject: reject, requestId, resolve: resolvePromise, timeout }
      this.input.write(encodeRequest(payload, requestId), (error) => {
        if (error) this.close(unavailable('The executor VM helper is unavailable.'))
      })
    })
  }

  private receive(chunk: Buffer): void {
    if (this.closed || this.readyError) return
    this.output = Buffer.concat([this.output, chunk])
    if (!this.ready) this.consumeReady()
    if (this.ready) this.consumeResponses()
  }

  private consumeReady(): void {
    if (this.output.length > READY_MAX_BYTES) {
      this.close(unavailable('The executor VM helper emitted invalid session output.'))
      return
    }
    const lineEnd = this.output.indexOf(0x0a)
    if (lineEnd < 0) return
    const line = this.output.subarray(0, lineEnd)
    this.output = this.output.subarray(lineEnd + 1)
    try {
      const value: unknown = JSON.parse(line.toString('utf8'))
      if (
        !isRecord(value)
        || Object.keys(value).some((key) => !['session', 'valid', 'workspaceAttached'].includes(key))
        || value.session !== 'ready'
        || value.valid !== true
        || value.workspaceAttached !== true
      ) {
        throw new Error('invalid ready response')
      }
      this.ready = true
      this.resolveReady?.()
    } catch {
      this.close(unavailable('The executor VM helper emitted invalid session output.'))
    }
  }

  private consumeResponses(): void {
    while (this.output.length >= 4) {
      const bodyLength = this.output.readUInt32BE(0)
      if (bodyLength > FRAME_MAX_BYTES - 4) {
        this.close(unavailable('The executor VM helper emitted an invalid control response.'))
        return
      }
      const frameLength = bodyLength + 4
      if (this.output.length < frameLength) return
      const frame = this.output.subarray(4, frameLength)
      this.output = this.output.subarray(frameLength)
      let response: GuestControlEnvelope
      try {
        response = decodeResponse(frame)
      } catch (error) {
        this.close(error instanceof Error ? error : unavailable('The executor VM helper is unavailable.'))
        return
      }
      if (!this.pending || response.requestId !== this.pending.requestId) {
        this.close(unavailable('The executor VM helper emitted an unexpected control response.'))
        return
      }
      const pending = this.pending
      this.pending = undefined
      clearTimeout(pending.timeout)
      pending.resolve(response.payload)
    }
  }
}
