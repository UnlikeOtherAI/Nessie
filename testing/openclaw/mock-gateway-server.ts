#!/usr/bin/env node
/**
 * mock-gateway-server.ts — Minimal OpenClaw Gateway mock for contract testing
 *
 * This mock implements enough of the Gateway WS protocol to test a client
 * without running a real OpenClaw instance. It simulates:
 *   - connect.challenge → connect handshake
 *   - hello-ok response with device token
 *   - chat.history (returns mock transcript)
 *   - chat.send (streams mock response events)
 *   - chat.abort
 *   - sessions.list (returns mock session list)
 *   - sessions.preview
 *   - sessions.messages.subscribe/unsubscribe
 *   - sessions.patch
 *   - node.pair (device pairing flow)
 *
 * Run:
 *   npx ts-node testing/openclaw/mock-gateway-server.ts
 *   # or: node --loader ts-node/esm testing/openclaw/mock-gateway-server.ts
 *
 * Listens on ws://localhost:18790 (avoids conflict with real Gateway on 18789).
 */

import { WebSocketServer, WebSocket } from 'ws'

const PORT = 18790
const wss = new WebSocketServer({ port: PORT })

let requestId = 1
const newId = () => requestId++

// ─── Mock data ────────────────────────────────────────────────────────────────

const MOCK_SESSIONS = [
  {
    key: 'agent:main:telegram:dm:12345',
    agentId: 'main',
    channel: 'telegram',
    label: 'support',
    spawnedBy: 'telegram:dm',
    createdAt: '2026-04-01T09:00:00Z',
    updatedAt: '2026-04-04T14:22:00Z',
    title: 'Support thread with @alice',
    lastMessage: 'Here is the quarterly report...',
    messageCount: 47,
    isActive: true,
  },
  {
    key: 'agent:main:tui:local',
    agentId: 'main',
    channel: 'tui',
    label: null,
    spawnedBy: 'tui:local',
    createdAt: '2026-04-03T10:00:00Z',
    updatedAt: '2026-04-04T16:00:00Z',
    title: 'Local TUI session',
    lastMessage: 'What is the weather?',
    messageCount: 12,
    isActive: true,
  },
  {
    key: 'agent:main:hook:quarterly',
    agentId: 'main',
    channel: 'hook',
    label: 'quarterly',
    spawnedBy: 'webhook',
    createdAt: '2026-03-15T08:00:00Z',
    updatedAt: '2026-03-15T08:01:00Z',
    title: 'Quarterly report webhook',
    lastMessage: 'Triggered: quarterly report digest',
    messageCount: 2,
    isActive: false,
  },
]

const MOCK_TRANSCRIPT = [
  { role: 'user', content: 'Hello, who are you?', ts: '2026-04-03T10:00:00Z' },
  { role: 'assistant', content: "I'm OpenClaw, your personal AI assistant.", ts: '2026-04-03T10:00:01Z' },
  { role: 'user', content: 'What can you do?', ts: '2026-04-03T10:00:05Z' },
  { role: 'assistant', content: 'I can chat, run tools, manage your messages, and automate tasks.', ts: '2026-04-03T10:00:06Z' },
]

// ─── Helpers ─────────────────────────────────────────────────────────────────

function send(ws: WebSocket, data: object) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data))
  }
}

function sendError(ws: WebSocket, id: number, code: string, message: string) {
  send(ws, { type: 'res', id, ok: false, error: { code, message } })
}

// ─── Connection handler ───────────────────────────────────────────────────────

wss.on('connection', (ws) => {
  console.log('[mock-gw] Client connected')

  let connected = false
  let deviceToken: string | null = null
  let sessionSubscriptions = new Set<string>()
  let pendingChatRuns = new Map<string, ReturnType<typeof setTimeout>>()

  ws.on('message', (raw) => {
    let msg: any
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }

    // ─── connect.challenge (server sends first) ──────────────────────────────
    if (!connected && msg.type !== 'req') {
      send(ws, {
        type: 'event',
        event: 'connect.challenge',
        payload: { nonce: 'mock-nonce-' + Date.now(), ts: Date.now() },
      })
      return
    }

    // ─── connect ─────────────────────────────────────────────────────────────
    if (msg.type === 'req' && msg.method === 'connect') {
      const params = msg.params ?? {}
      const device = params.device ?? {}
      const auth = params.auth ?? {}

      console.log('[mock-gw] connect:', {
        role: params.role,
        scopes: params.scopes,
        deviceId: device.id,
        token: auth.token ? '***' : 'missing',
      })

      if (!auth.token) {
        send(ws, {
          type: 'res', id: msg.id, ok: false,
          error: { code: 'AUTH_TOKEN_REQUIRED', message: 'No auth token provided' },
        })
        return
      }

      // Simulate pairing pending for new devices
      if (!deviceToken) {
        deviceToken = 'dev_mock_' + Math.random().toString(36).slice(2)
        send(ws, {
          type: 'res', id: msg.id, ok: true,
          payload: {
            auth: { deviceToken, expiresAt: null },
            detail: {
              code: 'DEVICE_AUTH_PENDING_APPROVAL',
              message: 'Waiting for device approval on gateway host',
            },
            recommendedNextStep: 'Run "openclaw devices approve" on the gateway host',
          },
        })
      } else {
        // Already paired
        send(ws, {
          type: 'res', id: msg.id, ok: true,
          payload: {
            auth: { deviceToken, expiresAt: null },
          },
        })
        connected = true
      }
      return
    }

    if (msg.type !== 'req') return

    const { id, method, params = {} } = msg
    console.log('[mock-gw] →', method, id)

    switch (method) {

      // ─── chat.history ──────────────────────────────────────────────────────
      case 'chat.history': {
        const key = params.sessionKey ?? 'agent:main:tui:local'
        send(ws, {
          type: 'res', id, ok: true,
          payload: {
            sessionKey: key,
            messages: MOCK_TRANSCRIPT.slice(-(params.limit ?? 100)),
            total: MOCK_TRANSCRIPT.length,
          },
        })
        break
      }

      // ─── chat.send ─────────────────────────────────────────────────────────
      case 'chat.send': {
        const runId = 'run-' + Math.random().toString(36).slice(2, 8)
        const sessionKey = params.sessionKey ?? 'agent:main:tui:local'
        const message = params.message?.content ?? 'Hello'
        const timeoutMs = params.timeoutMs ?? 30000

        // Send "running" event
        send(ws, {
          type: 'event', event: 'chat',
          payload: { runId, sessionKey, seq: 1, state: 'running' },
        })

        // Stream delta events
        const words = [`Echo: "${message}"`, 'This is a mock response.', 'It works!']
        let seq = 2
        for (const word of words) {
          const timer = setTimeout(() => {
            send(ws, {
              type: 'event', event: 'chat',
              payload: {
                runId, sessionKey, seq: seq++,
                state: 'delta',
                message: { role: 'assistant', content: word },
              },
            })
          }, 200 * seq)
          pendingChatRuns.set(runId + seq, timer)
        }

        // Final event
        const finalTimer = setTimeout(() => {
          send(ws, {
            type: 'event', event: 'chat',
            payload: {
              runId, sessionKey, seq: seq + 1,
              state: 'final',
              message: { role: 'assistant', content: 'Mock response complete.' },
              usage: { inputTokens: 50, outputTokens: 30, totalTokens: 80, cost: 0.0012 },
            },
          })
        }, timeoutMs)
        pendingChatRuns.set(runId, finalTimer)
        break
      }

      // ─── chat.abort ────────────────────────────────────────────────────────
      case 'chat.abort': {
        const runId = params.runId ?? ''
        const sessionKey = params.sessionKey ?? ''
        // Abort pending timers
        pendingChatRuns.forEach((timer, key) => {
          if (key.startsWith(runId || 'run-')) {
            clearTimeout(timer)
            pendingChatRuns.delete(key)
          }
        })
        send(ws, {
          type: 'event', event: 'chat',
          payload: { runId, sessionKey, seq: 999, state: 'aborted' },
        })
        send(ws, { type: 'res', id, ok: true, payload: { aborted: true } })
        break
      }

      // ─── sessions.list ─────────────────────────────────────────────────────
      case 'sessions.list': {
        let sessions = [...MOCK_SESSIONS]
        if (params.search) {
          const q = params.search.toLowerCase()
          sessions = sessions.filter(s =>
            s.title?.toLowerCase().includes(q) ||
            s.lastMessage?.toLowerCase().includes(q) ||
            s.key.toLowerCase().includes(q)
          )
        }
        sessions = sessions.slice(0, params.limit ?? 50)
        send(ws, { type: 'res', id, ok: true, payload: { sessions, total: sessions.length } })
        break
      }

      // ─── sessions.preview ──────────────────────────────────────────────────
      case 'sessions.preview': {
        const keys: string[] = params.keys ?? []
        const previews = keys.map(k => ({
          key: k,
          preview: `[Preview of session ${k}]`,
          messageCount: 5,
        }))
        send(ws, { type: 'res', id, ok: true, payload: { previews } })
        break
      }

      // ─── sessions.messages.subscribe ───────────────────────────────────────
      case 'sessions.messages.subscribe': {
        const key = params.key ?? ''
        sessionSubscriptions.add(key)
        send(ws, {
          type: 'event', event: 'session.subscribed',
          payload: { key, subscribed: true },
        })
        send(ws, { type: 'res', id, ok: true, payload: { subscribed: true } })

        // Simulate a message arriving after 2s
        setTimeout(() => {
          if (sessionSubscriptions.has(key)) {
            send(ws, {
              type: 'event', event: 'session.message',
              payload: {
                key,
                message: { role: 'assistant', content: '[Mock: simulated message]' },
                seq: 1,
              },
            })
          }
        }, 2000)
        break
      }

      // ─── sessions.messages.unsubscribe ────────────────────────────────────
      case 'sessions.messages.unsubscribe': {
        const key = params.key ?? ''
        sessionSubscriptions.delete(key)
        send(ws, { type: 'res', id, ok: true, payload: { subscribed: false } })
        break
      }

      // ─── sessions.patch ───────────────────────────────────────────────────
      case 'sessions.patch': {
        const { key, ...updates } = params
        send(ws, { type: 'res', id, ok: true, payload: { key, ...updates, patched: true } })
        break
      }

      // ─── config.apply / config.patch ──────────────────────────────────────
      case 'config.apply':
      case 'config.patch': {
        // Rate-limit simulation: accept the request
        send(ws, { type: 'res', id, ok: true, payload: { applied: true } })
        break
      }

      // ─── device.pair (node pairing) ───────────────────────────────────────
      case 'device.pair': {
        send(ws, {
          type: 'event', event: 'device.pair.pending',
          payload: { requestId: 'req-' + Math.random().toString(36).slice(2, 8) },
        })
        send(ws, { type: 'res', id, ok: true, payload: { status: 'pending_approval' } })
        break
      }

      // ─── Unknown method ───────────────────────────────────────────────────
      default: {
        console.log('[mock-gw] Unknown method:', method)
        sendError(ws, id, 'METHOD_NOT_FOUND', `Unknown method: ${method}`)
      }
    }
  })

  ws.on('close', () => {
    console.log('[mock-gw] Client disconnected')
    pendingChatRuns.forEach(t => clearTimeout(t))
    pendingChatRuns.clear()
  })

  ws.on('error', (err) => {
    console.error('[mock-gw] WS error:', err.message)
  })
})

console.log(`[mock-gw] OpenClaw mock Gateway listening on ws://localhost:${PORT}`)
console.log('[mock-gw] For testing: export OPENCLAW_GW_URL="ws://localhost:18790" in your client')
console.log('[mock-gw] Press Ctrl+C to stop')
