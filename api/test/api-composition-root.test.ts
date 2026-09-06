import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

/**
 * The API entrypoint is a composition root, not a script (2026-09-05 review,
 * FO3-5).
 *
 * `api/src/index.ts` used to parse the repo-root `.env`, call
 * `createServerContext()` and construct a model-usage accumulator at module
 * scope.
 * Importing it therefore read the filesystem, mutated `process.env`, opened a
 * Prisma pool — and, in a hosted mode with no `NESSIE_AUTH_SECRET`, called
 * `process.exit(1)` from inside an import. That made the refusal untestable
 * and made every importer (a test wanting `buildApp`, a caller wanting
 * `createCorsOriginChecker`) inherit all of it.
 *
 * Two properties are pinned:
 *  - importing the module with `DATABASE_URL` and `NESSIE_AUTH_SECRET` unset
 *    in `selfHosted` mode completes, in a child process, with exit code 0;
 *  - the missing-secret refusal is a thrown `ServerConfigurationError` that a
 *    caller can catch, which is what `startApiServer` does before exiting.
 */

const execFileAsync = promisify(execFile)

const apiDir = fileURLToPath(new URL('..', import.meta.url))
const indexUrl = pathToFileURL(fileURLToPath(new URL('../src/index.ts', import.meta.url))).href

const childEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env, NESSIE_MODE: 'selfHosted' }
  delete env.DATABASE_URL
  delete env.NESSIE_AUTH_SECRET
  return env
}

test('importing the API entrypoint has no side effects: no config load, no pool, no exit', async () => {
  const script = [
    `const mod = await import(${JSON.stringify(indexUrl)})`,
    "if (typeof mod.buildApp !== 'function') throw new Error('buildApp is not exported')",
    "if (typeof mod.startApiServer !== 'function') throw new Error('startApiServer is not exported')",
    "if (typeof mod.createCorsOriginChecker !== 'function') throw new Error('createCorsOriginChecker is not exported')",
    // The checker is usable straight out of the import, with nothing built.
    "const allows = mod.createCorsOriginChecker({ allowedOrigins: new Set(['https://admin.example']), mode: 'selfHosted' })",
    "await new Promise((resolve, reject) => allows('https://admin.example', (error, ok) => (error || !ok ? reject(error ?? new Error('origin refused')) : resolve(undefined))))",
    "console.log('IMPORT_CLEAN')",
  ].join('\n')

  const { stdout } = await execFileAsync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', script],
    { cwd: apiDir, env: childEnv() },
  )

  assert.match(stdout, /IMPORT_CLEAN/)
})

test('a missing auth secret in a hosted mode throws instead of exiting the process', async () => {
  const script = [
    "const { createServerContext, ServerConfigurationError } = await import('./src/lib/server-context.ts')",
    'let thrown = null',
    'try { createServerContext() } catch (error) { thrown = error }',
    "if (!thrown) throw new Error('a missing NESSIE_AUTH_SECRET was accepted')",
    "if (!(thrown instanceof ServerConfigurationError)) throw new Error('wrong error type: ' + thrown)",
    "if (!/NESSIE_AUTH_SECRET/.test(thrown.message)) throw new Error('unhelpful message: ' + thrown.message)",
    "console.log('THROWN_NOT_EXITED')",
  ].join('\n')

  const { stdout } = await execFileAsync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', script],
    { cwd: apiDir, env: { ...childEnv(), DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/unused' } },
  )

  assert.match(stdout, /THROWN_NOT_EXITED/)
})
