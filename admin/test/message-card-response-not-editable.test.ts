import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { isAgentCardResponseMessage } from '@nessie/schemas'

const here = dirname(fileURLToPath(import.meta.url))
const readSource = (relative: string) => readFileSync(resolve(here, relative), 'utf8')

test('the message row hides edit on a card press but keeps delete', () => {
  const source = readSource('../src/components/features/channels/ChannelMessageRow.tsx')

  // One predicate, shared with the server that refuses the edit — never a
  // second hand-rolled metadata check that could disagree with it.
  assert.match(source, /import \{ isAgentCardResponseMessage \} from '@nessie\/schemas'/)
  assert.match(
    source,
    /canEditOwnMessage = canManageOwnMessage && !isAgentCardResponseMessage\(message\.metadata\)/,
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
