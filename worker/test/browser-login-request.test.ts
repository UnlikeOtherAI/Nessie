import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import test from 'node:test'

import { browserLoginCardDeadline } from '../src/run/browser-cloud/login-request.js'

test('the login card uses the grant deadline after a short deployment TTL', () => {
  const requestedDeadline = new Date('2026-09-07T12:15:00.000Z')
  const hardDeploymentDeadline = new Date('2026-09-07T12:05:00.000Z')

  const cardDeadline = browserLoginCardDeadline({ expiresAt: hardDeploymentDeadline })

  assert.equal(cardDeadline.getTime(), hardDeploymentDeadline.getTime())
  assert.notEqual(cardDeadline.getTime(), requestedDeadline.getTime())
})

const SRC = new URL('../src/', import.meta.url)

const sourceFiles = (dir: URL): URL[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return sourceFiles(new URL(`${entry.name}/`, dir))
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')
      ? [new URL(entry.name, dir)]
      : []
  })

// One card path. `browser_login_request` kept its own copy of the message,
// card row, pointer, realtime notice and bell; a copy is where the two drift.
// Its card now goes through `postAgentCard`, and nothing else in the worker
// writes an `AgentCard` row, so a card cannot skip any step the door takes.
// The card it posts is pinned against real rows in
// `test/db/browser-login-card.test.ts`.
test('browser_login_request posts its card through postAgentCard', () => {
  const loginRequest = readFileSync(new URL('run/browser-cloud/login-request.ts', SRC), 'utf8')
  assert.match(loginRequest, /import \{ postAgentCard \} from '\.\.\/pa-tools\/agent-card-post\.js'/)
  assert.match(loginRequest, /await postAgentCard\(context, runContext, \{/)
  for (const copied of [
    /agentCard\.create/,
    /createAgentMessage/,
    /AgentCardMessageMetadataSchema/,
    /publishMessageCreated/,
    /alertCardRespondents/,
    /\$transaction/,
  ]) {
    assert.doesNotMatch(loginRequest, copied)
  }

  const writers = sourceFiles(SRC)
    .filter((file) => /\.agentCard\.create\(/.test(readFileSync(file, 'utf8')))
    .map((file) => file.pathname.slice(SRC.pathname.length))
  assert.deepEqual(writers, ['run/pa-tools/agent-card-post.ts'])
})
