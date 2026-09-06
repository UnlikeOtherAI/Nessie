import assert from 'node:assert/strict'
import test from 'node:test'

import { answerHijackedFailure } from '../src/routes/mcp-endpoint.js'

// `POST /mcp` hijacks the reply so the MCP transport can own the socket, which
// also means Fastify's error handler no longer runs for it. Anything thrown
// after that has to answer the client itself — otherwise the connection simply
// hangs until the client's own timeout, which is the worst failure shape
// available: it looks like a slow server rather than a broken one.

const fakeRaw = (headersSent = false) => {
  const state = {
    body: undefined as string | undefined,
    ended: false,
    headers: undefined as Record<string, string> | undefined,
    headersSent,
    status: undefined as number | undefined,
  }
  return {
    end: (chunk?: string) => {
      state.body = chunk
      state.ended = true
    },
    get headersSent() {
      return state.headersSent
    },
    state,
    writeHead: (status: number, headers: Record<string, string>) => {
      state.headers = headers
      state.headersSent = true
      state.status = status
    },
  }
}

test('a failure before any output answers with a JSON-RPC error', () => {
  const raw = fakeRaw()
  answerHijackedFailure(raw)

  assert.equal(raw.state.status, 500)
  assert.equal(raw.state.headers?.['content-type'], 'application/json')
  assert.equal(raw.state.ended, true, 'the socket must not be left open')

  const body = JSON.parse(String(raw.state.body))
  assert.equal(body.jsonrpc, '2.0')
  // -32603 is JSON-RPC's internal error, which is what the client reading this
  // knows how to handle.
  assert.equal(body.error.code, -32603)
  assert.equal(body.id, null)
})

test('the message is bounded, never the upstream error', () => {
  const raw = fakeRaw()
  answerHijackedFailure(raw)
  const body = JSON.parse(String(raw.state.body))
  // An upstream string can carry another tenant's data, and a JSON-RPC error
  // goes straight back to a client that may read it into a model.
  assert.equal(body.error.message, 'Internal server error')
})

test('a failure mid-response still closes the socket', () => {
  const raw = fakeRaw(true)
  answerHijackedFailure(raw)

  // Headers are already out, so the status cannot be corrected — the only
  // thing left that helps is not hanging.
  assert.equal(raw.state.status, undefined)
  assert.equal(raw.state.ended, true)
})
