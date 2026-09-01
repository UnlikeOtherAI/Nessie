import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const readSource = (relative: string) => readFileSync(resolve(here, relative), 'utf8')

test('the app setup card reads only the opaque message pointer and server presenter', () => {
  const source = readSource('../src/components/features/channels/AppSetupCard.tsx')

  assert.match(source, /AppSetupCardSchema\.safeParse\(metadata\?\.appSetupCard\)/)
  assert.match(source, /useAppConnectionRequestCard\(requestId\)/)
  assert.match(source, /useBeginAppConnectionRequest\(\)/)
  assert.doesNotMatch(source, /credentialRef|mcpInstanceId|commsConnectionId/)
})
