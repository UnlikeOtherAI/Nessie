import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { isAgentCardResponseMessage, isResearchRunRefMessage } from '@nessie/schemas'

const here = dirname(fileURLToPath(import.meta.url))
const readSource = (relative: string) => readFileSync(resolve(here, relative), 'utf8')

test('the message row hides edit on a card press and a research card but keeps delete', () => {
  const source = readSource('../src/components/features/channels/ChannelMessageRow.tsx')

  // One predicate each, shared with the server that refuses the edit — never
  // a second hand-rolled metadata check that could disagree with it.
  assert.match(
    source,
    /import \{ isAgentCardResponseMessage, isResearchRunRefMessage \} from '@nessie\/schemas'/,
  )
  assert.match(source, /canEditOwnMessage = canManageOwnMessage\s+&& !isAgentCardResponseMessage\(message\.metadata\)/)
  assert.match(
    source,
    /!isAgentCardResponseMessage\(message\.metadata\)\s+&& !isResearchRunRefMessage\(message\.metadata\)/,
  )
  assert.match(source, /canEdit=\{canEditOwnMessage\}/)
  assert.match(source, /canDelete=\{canManageOwnMessage\}/)
})

test('every edit affordance runs through the one gated row', () => {
  // `ChannelMessageActions` is the only thing that offers the pencil, and the
  // row is the only thing that mounts it — so gating `canEdit` there covers
  // the channel feed, the reply panel, the drawers and the threads inbox.
  const actions = readSource('../src/components/features/channels/ChannelMessageActions.tsx')
  assert.match(actions, /onStartEdit\(messageId, content\)/)
  assert.match(actions, /canEdit/)
})

test('the shared predicate answers the row the same way it answers the service', () => {
  assert.equal(
    isAgentCardResponseMessage({
      agentCardResponse: {
        actionKey: 'allow',
        cardId: '11111111-1111-4111-8111-111111111111',
        schemaVersion: 1,
      },
    }),
    true,
  )
  assert.equal(isAgentCardResponseMessage({ mentions: [] }), false)
})

test('a research card is the server\'s pointer, never the person\'s words to edit', () => {
  // `MESSAGE_IMMUTABLE_RESEARCH_CARD` on the server; no pencil in the row.
  assert.equal(
    isResearchRunRefMessage({
      researchRunRef: { runId: '11111111-1111-4111-8111-111111111111', schemaVersion: 1 },
    }),
    true,
  )
  assert.equal(isResearchRunRefMessage({ researchRunRef: { runId: 'not-a-uuid', schemaVersion: 1 } }), false)
  assert.equal(isResearchRunRefMessage({ mentions: [] }), false)
})
