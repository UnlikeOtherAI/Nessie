import assert from 'node:assert/strict'
import test from 'node:test'

import {
  fromPrismaToolGrantSource,
  fromPrismaToolRegistrySource,
  toPrismaToolGrantSource,
  toPrismaToolRegistrySource,
} from '../src/index.js'

test('toPrismaToolRegistrySource translates kebab-case to snake_case', () => {
  assert.equal(toPrismaToolRegistrySource('builtin'), 'builtin')
  assert.equal(toPrismaToolRegistrySource('custom'), 'custom')
  assert.equal(toPrismaToolRegistrySource('mcp-remote'), 'mcp_remote')
  assert.equal(toPrismaToolRegistrySource('interactive-session'), 'interactive_session')
  assert.equal(toPrismaToolRegistrySource('executor'), 'executor')
})

test('fromPrismaToolRegistrySource translates snake_case back to kebab-case', () => {
  assert.equal(fromPrismaToolRegistrySource('builtin'), 'builtin')
  assert.equal(fromPrismaToolRegistrySource('custom'), 'custom')
  assert.equal(fromPrismaToolRegistrySource('mcp_remote'), 'mcp-remote')
  assert.equal(fromPrismaToolRegistrySource('interactive_session'), 'interactive-session')
  assert.equal(fromPrismaToolRegistrySource('executor'), 'executor')
})

test('fromPrismaToolRegistrySource throws on unknown value', () => {
  assert.throws(
    () => fromPrismaToolRegistrySource('mystery'),
    /Unknown Prisma ToolRegistrySource value: mystery/,
  )
})

test('toPrismaToolGrantSource translates kebab-case to snake_case', () => {
  assert.equal(toPrismaToolGrantSource('role'), 'role')
  assert.equal(toPrismaToolGrantSource('agent-override'), 'agent_override')
})

test('fromPrismaToolGrantSource translates snake_case back to kebab-case', () => {
  assert.equal(fromPrismaToolGrantSource('role'), 'role')
  assert.equal(fromPrismaToolGrantSource('agent_override'), 'agent-override')
})

test('fromPrismaToolGrantSource throws on unknown value', () => {
  assert.throws(
    () => fromPrismaToolGrantSource('bogus'),
    /Unknown Prisma ToolGrantSource value: bogus/,
  )
})
