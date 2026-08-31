import assert from 'node:assert/strict'
import { register } from 'node:module'
import test from 'node:test'

const dbStub = [
  'export const disconnectPrismaClient = async () => {}',
  'export const getPrismaClient = () => {',
  '  throw new Error("@nessie/db is not used by rate-limit-client-id.test.ts")',
  '}',
  'export const writeAuditEntry = async () => {}',
  'export const enqueueQueueJob = async () => {}',
  'export const buildVisibleAgentWhere = () => {',
  '  throw new Error("agent visibility is not used by rate-limit-client-id.test.ts")',
  '}',
  'export const listVisibleAgentIdsForUser = async () => {',
  '  throw new Error("agent visibility is not used by rate-limit-client-id.test.ts")',
  '}',
  'export const writeAuditEntryInTransaction = async () => {}',
].join('\n')

const dbStubUrl = `data:text/javascript,${encodeURIComponent(dbStub)}`
const dbLoader = `
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@nessie/db') {
    return {
      shortCircuit: true,
      url: ${JSON.stringify(dbStubUrl)},
    }
  }
  return nextResolve(specifier, context)
}
`

register(`data:text/javascript,${encodeURIComponent(dbLoader)}`, import.meta.url)

const {
  createFastifyTrustProxyConfig,
  getRateLimitClientId,
} = await import('../src/lib/server-context.js') as {
  createFastifyTrustProxyConfig: (trustedProxyHops: number) => false | number
  getRateLimitClientId: (request: { ip: string }) => string
}

test('Fastify proxy trust is disabled unless trusted proxy hops is explicit', () => {
  assert.equal(createFastifyTrustProxyConfig(0), false)
  assert.equal(createFastifyTrustProxyConfig(1), 1)
  assert.equal(createFastifyTrustProxyConfig(2), 2)
})

test('rate-limit client id uses Fastify resolved ip, not raw X-Forwarded-For', () => {
  const request = {
    headers: { 'x-forwarded-for': '1.2.3.4' },
    ip: '203.0.113.10',
  }

  assert.equal(getRateLimitClientId(request), '203.0.113.10')
})
