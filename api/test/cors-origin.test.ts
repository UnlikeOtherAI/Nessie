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
}) => CorsOriginChecker

const { createCorsOriginChecker } = await import('../src/lib/server-context.js') as {
  createCorsOriginChecker: CreateCorsOriginChecker
}

const checkOrigin = async (input: {
  allowedOrigins?: Set<string>
  mode: AppMode
  origin: string
}): Promise<boolean> => {
  const checker = createCorsOriginChecker({
    allowedOrigins: input.allowedOrigins ?? new Set(),
    mode: input.mode,
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
