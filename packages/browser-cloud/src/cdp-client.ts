import { CLOUD_BROWSER_ERROR_CODES, CloudBrowserError } from './errors.js'
import { openPinnedWebSocket, type PinnedWebSocket } from './pinned-websocket.js'

/**
 * A minimal Chrome DevTools Protocol client over the pinned WebSocket.
 *
 * Browserbase hands back a *browser-level* connect URL, so unlike the
 * executor's guest agent (which dials a page's debugger URL directly) this
 * attaches to a page target and sends every page command with that flat
 * session id.
 */

export type CdpClient = {
  call: (
    method: string,
    params?: Record<string, unknown>,
    options?: { sessionId?: string | null },
  ) => Promise<Record<string, unknown>>
  /** The attached page session; null until `attachToPage` runs. */
  pageSessionId: () => string | null
  attachToPage: () => Promise<string>
  targets: () => Promise<Array<{ targetId: string; type: string; title: string; url: string }>>
  close: () => void
  closed: Promise<void>
}

type Pending = {
  resolve: (value: Record<string, unknown>) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

const DEFAULT_CALL_TIMEOUT_MS = 30_000

export const connectCdp = async (
  connectUrl: string,
  options: {
    callTimeoutMs?: number
    openImpl?: typeof openPinnedWebSocket
  } = {},
): Promise<CdpClient> => {
  const callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
  const pending = new Map<number, Pending>()
  let nextId = 1
  let attachedSessionId: string | null = null
  let socketError: Error | null = null

  const failAll = (error: Error): void => {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    pending.clear()
  }

  const open = options.openImpl ?? openPinnedWebSocket
  let socket: PinnedWebSocket
  socket = await open(connectUrl, {
    onMessage: (payload) => {
      let message: Record<string, unknown>
      try {
        message = JSON.parse(payload) as Record<string, unknown>
      } catch {
        return
      }
      const id = message.id
      if (typeof id !== 'number') return
      const entry = pending.get(id)
      if (!entry) return
      pending.delete(id)
      clearTimeout(entry.timer)
      const error = message.error as { message?: unknown } | undefined
      if (error) {
        entry.reject(new CloudBrowserError(
          CLOUD_BROWSER_ERROR_CODES.COMMAND_FAILED,
          typeof error.message === 'string' ? error.message : 'The browser rejected the command.',
        ))
        return
      }
      entry.resolve((message.result as Record<string, unknown>) ?? {})
    },
    onClose: (error) => {
      socketError = error
        ?? new CloudBrowserError(
          CLOUD_BROWSER_ERROR_CODES.NO_SESSION,
          'The browser connection closed.',
        )
      failAll(socketError)
    },
  })

  const call: CdpClient['call'] = (method, params = {}, callOptions = {}) => {
    if (socketError) return Promise.reject(socketError)
    const id = nextId
    nextId += 1
    const sessionId = callOptions.sessionId === undefined
      ? attachedSessionId
      : callOptions.sessionId
    const frame = JSON.stringify({
      id,
      method,
      params,
      ...(sessionId ? { sessionId } : {}),
    })
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        // A timed-out CDP command is genuinely ambiguous — the page may have
        // acted. The caller converts this into the unknown-outcome error.
        reject(new CloudBrowserError(
          CLOUD_BROWSER_ERROR_CODES.COMMAND_FAILED,
          `The browser did not answer ${method} in time.`,
        ))
      }, callTimeoutMs)
      pending.set(id, { resolve, reject, timer })
      try {
        socket.send(frame)
      } catch (error) {
        pending.delete(id)
        clearTimeout(timer)
        reject(error as Error)
      }
    })
  }

  const targets: CdpClient['targets'] = async () => {
    const result = await call('Target.getTargets', {}, { sessionId: null })
    const infos = result.targetInfos
    if (!Array.isArray(infos)) return []
    return infos.flatMap((entry) => {
      const row = entry as Record<string, unknown>
      if (typeof row.targetId !== 'string' || typeof row.type !== 'string') return []
      return [{
        targetId: row.targetId,
        type: row.type,
        title: typeof row.title === 'string' ? row.title : '',
        url: typeof row.url === 'string' ? row.url : '',
      }]
    })
  }

  const attachToPage: CdpClient['attachToPage'] = async () => {
    const pages = (await targets()).filter((target) => target.type === 'page')
    const page = pages[0]
    if (!page) {
      throw new CloudBrowserError(
        CLOUD_BROWSER_ERROR_CODES.COMMAND_FAILED,
        'The cloud browser has no page open.',
      )
    }
    const attached = await call(
      'Target.attachToTarget',
      { targetId: page.targetId, flatten: true },
      { sessionId: null },
    )
    const sessionId = attached.sessionId
    if (typeof sessionId !== 'string') {
      throw new CloudBrowserError(
        CLOUD_BROWSER_ERROR_CODES.COMMAND_FAILED,
        'The cloud browser did not return a page session.',
      )
    }
    attachedSessionId = sessionId
    // Page and DOM must be enabled before navigation events and box models
    // are available; Accessibility is what `observe` reads.
    await call('Page.enable')
    await call('DOM.enable')
    await call('Accessibility.enable')
    return sessionId
  }

  return {
    call,
    pageSessionId: () => attachedSessionId,
    attachToPage,
    targets,
    close: () => socket.close(),
    closed: socket.closed,
  }
}
