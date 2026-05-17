import assert from 'node:assert/strict'
import test from 'node:test'

import type { FastifyReply } from 'fastify'

import { sendMcpError } from '../src/routes/mcp/shared.js'
import {
  MCP_CATALOG_ERROR_CODES,
  McpCatalogError,
} from '../src/services/mcp-catalog.js'
import {
  MCP_OAUTH_ERROR_CODES,
  McpOAuthError,
} from '../src/services/mcp-oauth.js'

/**
 * Task #39 — pin the HTTP status mapping for catalog/OAuth lifecycle errors.
 *
 * `INVALID_TRANSITION` (catalog) and `NOT_OAUTH2` (oauth) describe a resource
 * that exists but is in a state that disallows the requested mutation —
 * RFC 7231 §6.5.8 calls that a conflict (409), not a payload validation
 * failure (400). The prior mapping returned 400 for both, which made clients
 * unable to distinguish "your request is malformed" from "the server is in
 * the wrong state to honour your request".
 */

type CapturedReply = {
  reply: FastifyReply
  status?: number
  payload?: { error?: { code?: string; message?: string } }
}

const makeReplyStub = (): CapturedReply => {
  const captured: CapturedReply = { reply: undefined as unknown as FastifyReply }
  const reply = {
    code(status: number) {
      captured.status = status
      return this
    },
    send(payload: unknown) {
      captured.payload = payload as CapturedReply['payload']
      return this
    },
  }
  captured.reply = reply as unknown as FastifyReply
  return captured
}

test('sendMcpError maps catalog INVALID_TRANSITION → HTTP 409', () => {
  const cap = makeReplyStub()
  const handled = sendMcpError(
    cap.reply,
    new McpCatalogError(
      MCP_CATALOG_ERROR_CODES.INVALID_TRANSITION,
      'cannot publish a deprecated entry',
    ),
  )
  assert.equal(handled, true)
  assert.equal(cap.status, 409)
  assert.equal(cap.payload?.error?.code, MCP_CATALOG_ERROR_CODES.INVALID_TRANSITION)
})

test('sendMcpError maps catalog DUPLICATE_NAME → HTTP 409 (regression guard)', () => {
  const cap = makeReplyStub()
  sendMcpError(
    cap.reply,
    new McpCatalogError(MCP_CATALOG_ERROR_CODES.DUPLICATE_NAME, 'dup'),
  )
  assert.equal(cap.status, 409)
})

test('sendMcpError maps catalog AUTH_CONFIG_INVALID → HTTP 400 (regression guard)', () => {
  const cap = makeReplyStub()
  sendMcpError(
    cap.reply,
    new McpCatalogError(MCP_CATALOG_ERROR_CODES.AUTH_CONFIG_INVALID, 'bad'),
  )
  assert.equal(cap.status, 400)
})

test('sendMcpError maps OAuth NOT_OAUTH2 → HTTP 409', () => {
  const cap = makeReplyStub()
  const handled = sendMcpError(
    cap.reply,
    new McpOAuthError(
      MCP_OAUTH_ERROR_CODES.NOT_OAUTH2,
      'catalog entry uses authMethod=none, not oauth2',
    ),
  )
  assert.equal(handled, true)
  assert.equal(cap.status, 409)
  assert.equal(cap.payload?.error?.code, MCP_OAUTH_ERROR_CODES.NOT_OAUTH2)
})

test('sendMcpError maps OAuth STATE_INVALID → HTTP 400 (regression guard)', () => {
  const cap = makeReplyStub()
  sendMcpError(
    cap.reply,
    new McpOAuthError(MCP_OAUTH_ERROR_CODES.STATE_INVALID, 'bad state'),
  )
  assert.equal(cap.status, 400)
})

test('sendMcpError maps OAuth TOKEN_EXCHANGE_FAILED → HTTP 502 (regression guard)', () => {
  const cap = makeReplyStub()
  sendMcpError(
    cap.reply,
    new McpOAuthError(MCP_OAUTH_ERROR_CODES.TOKEN_EXCHANGE_FAILED, 'upstream 500'),
  )
  assert.equal(cap.status, 502)
})
