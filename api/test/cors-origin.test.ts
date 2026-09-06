import assert from 'node:assert/strict'
import { register } from 'node:module'
import test from 'node:test'

// server-context imports DB wiring for createServerContext; these tests only
// exercise the pure CORS checker, so keep that unrelated package out of scope.
const dbStub = [
  'export const disconnectPrismaClient = async () => {}',
  'export const getPrismaClient = () => {',
  '  throw new Error("@nessie/db is not used by cors-origin.test.ts")',
  '}',
  'export const writeAuditEntry = async () => {}',
  'export const enqueueQueueJob = async () => {}',
  'export const buildVisibleAgentWhere = () => {',
  '  throw new Error("agent visibility is not used by cors-origin.test.ts")',
  '}',
  'export const buildAgentVisibilityWhere = () => {',
  '  throw new Error("agent visibility is not used by cors-origin.test.ts")',
  '}',
  'export const visibleKnowledgeSpaceWhere = () => {',
  '  throw new Error("knowledge-space visibility is not used by cors-origin.test.ts")',
  '}',
  'export const listVisibleAgentIdsForUser = async () => {',
  '  throw new Error("agent visibility is not used by cors-origin.test.ts")',
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

type CorsOriginChecker = (
  origin: string | undefined,
  callback: (error: Error | null, allowed: boolean) => void,
) => void

type AppMode = 'hosted' | 'local' | 'selfHosted'

type CreateCorsOriginChecker = (input: {
  allowedOrigins: Set<string>
  mode: AppMode
  teamHostBaseDomain?: string
}) => CorsOriginChecker

const { createCorsOriginChecker } = await import('../src/lib/server-context.js') as {
  createCorsOriginChecker: CreateCorsOriginChecker
}

const checkOrigin = async (input: {
  allowedOrigins?: Set<string>
  mode: AppMode
  origin: string
  teamHostBaseDomain?: string
}): Promise<boolean> => {
  const checker = createCorsOriginChecker({
    allowedOrigins: input.allowedOrigins ?? new Set(),
    mode: input.mode,
    ...(input.teamHostBaseDomain ? { teamHostBaseDomain: input.teamHostBaseDomain } : {}),
  })

  return new Promise((resolve, reject) => {
    checker(input.origin, (error, allowed) => {
      if (error) {
        reject(error)
        return
      }

      resolve(allowed)
    })
  })
}

test('createCorsOriginChecker allows Nessie desktop Tauri origins in local mode', async () => {
  assert.equal(await checkOrigin({ mode: 'local', origin: 'tauri://localhost' }), true)
  assert.equal(await checkOrigin({ mode: 'local', origin: 'http://tauri.localhost' }), true)
})

test('createCorsOriginChecker allows Nessie desktop Tauri origins in self-hosted mode', async () => {
  assert.equal(await checkOrigin({ mode: 'selfHosted', origin: 'tauri://localhost' }), true)
  assert.equal(await checkOrigin({ mode: 'selfHosted', origin: 'http://tauri.localhost' }), true)
})

test('createCorsOriginChecker rejects unknown origins', async () => {
  assert.equal(await checkOrigin({ mode: 'selfHosted', origin: 'https://evil.example.com' }), false)
})

test('createCorsOriginChecker keeps configured allowed origins working', async () => {
  const allowedOrigins = new Set(['https://admin.example.com'])

  assert.equal(
    await checkOrigin({
      allowedOrigins,
      mode: 'selfHosted',
      origin: 'https://admin.example.com',
    }),
    true,
  )
})

const TEAM_HOST_BASE = 'nessie.works'

test('a team hostname under the configured base domain is allowed', async () => {
  assert.equal(
    await checkOrigin({
      mode: 'hosted',
      origin: 'https://design.acme.nessie.works',
      teamHostBaseDomain: TEAM_HOST_BASE,
    }),
    true,
  )
})

test('a domain that merely ends with the base domain as a string is refused', async () => {
  // The reason this is a label comparison and not endsWith: every one of these
  // ends with "nessie.works" and none of them is ours.
  for (const origin of [
    'https://design.acme.evil-nessie.works',
    'https://evil-nessie.works',
    'https://nessie.works.attacker.test',
  ]) {
    assert.equal(
      await checkOrigin({ mode: 'hosted', origin, teamHostBaseDomain: TEAM_HOST_BASE }),
      false,
      origin,
    )
  }
})

test('an organisation portal host is allowed too — one label, not just two', async () => {
  // An earlier version required exactly two labels and silently blocked every
  // org portal, which the browser found before a human did.
  assert.equal(
    await checkOrigin({
      mode: 'hosted',
      origin: 'https://acme.nessie.works',
      teamHostBaseDomain: TEAM_HOST_BASE,
    }),
    true,
  )
})

test('the base domain itself, and anything deeper than a team, stay refused', async () => {
  for (const origin of [
    'https://nessie.works',
    'https://a.design.acme.nessie.works',
  ]) {
    assert.equal(
      await checkOrigin({ mode: 'hosted', origin, teamHostBaseDomain: TEAM_HOST_BASE }),
      false,
      origin,
    )
  }
})

test('a team hostname must be https with no explicit port', async () => {
  for (const origin of [
    'http://design.acme.nessie.works',
    'https://design.acme.nessie.works:8443',
  ]) {
    assert.equal(
      await checkOrigin({ mode: 'hosted', origin, teamHostBaseDomain: TEAM_HOST_BASE }),
      false,
      origin,
    )
  }
})

test('labels that are not legal DNS labels are refused', async () => {
  for (const origin of [
    'https://-design.acme.nessie.works',
    'https://design-.acme.nessie.works',
    'https://des_ign.acme.nessie.works',
  ]) {
    assert.equal(
      await checkOrigin({ mode: 'hosted', origin, teamHostBaseDomain: TEAM_HOST_BASE }),
      false,
      origin,
    )
  }
})

test('no base domain configured admits no team hostnames at all', async () => {
  assert.equal(
    await checkOrigin({ mode: 'hosted', origin: 'https://design.acme.nessie.works' }),
    false,
  )
})
