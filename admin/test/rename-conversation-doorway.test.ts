import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { CONVERSATION_TITLE_MAX_CHARS } from '@nessie/schemas'
import {
  RENAME_CONVERSATION_ACTION_ID,
  RENAME_CONVERSATION_ACTION_PRIORITY,
  canSaveConversationTitle,
  mayRenameConversation,
  renameConversationHeaderActions,
  type ConversationRenameDoorway,
} from '../src/components/features/channels/rename-conversation'
import { CHAT_TOOL_ACTION_PRIORITY } from '../src/components/features/channels/tool-rail/chat-tools'
import { partitionPageHeaderActions } from '../src/components/shared/responsive-page-header-layout'

/**
 * Rule zero for renaming a conversation: `PATCH /api/threads/:threadId` and
 * `useRenameThread` both shipped, and no control in the admin reached either —
 * a title you could only change by starting a different conversation. These
 * pin the doorway's rule (who is offered it, and where it is offered from) and
 * the Save rule, so neither can drift back into the header component where it
 * cannot be read without a DOM.
 */

const source = (path: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/${path}`, import.meta.url)), 'utf8')

const ME = 'user_me'

const doorway = (
  overrides: Partial<ConversationRenameDoorway> = {},
): ConversationRenameDoorway => ({
  conversation: { isGeneral: false, startedByUserId: ME },
  onRename: () => undefined,
  viewerCanManageChannel: false,
  viewerUserId: ME,
  ...overrides,
})

const actionIds = (input: ConversationRenameDoorway | null): string[] =>
  renameConversationHeaderActions(input).map((action) => action.id)

describe('the rename doorway on a conversation header', () => {
  it('is offered to the person who started the conversation', () => {
    assert.equal(mayRenameConversation(doorway()), true)
    assert.deepEqual(actionIds(doorway()), [RENAME_CONVERSATION_ACTION_ID])
  })

  it('is offered to anyone who can manage the room, whoever started it', () => {
    const manager = doorway({
      conversation: { isGeneral: false, startedByUserId: 'user_someone_else' },
      viewerCanManageChannel: true,
    })
    assert.equal(mayRenameConversation(manager), true)
    assert.deepEqual(actionIds(manager), [RENAME_CONVERSATION_ACTION_ID])
  })

  it('is offered to nobody else', () => {
    const bystander = doorway({
      conversation: { isGeneral: false, startedByUserId: 'user_someone_else' },
      viewerCanManageChannel: false,
    })
    assert.equal(mayRenameConversation(bystander), false)
    assert.deepEqual(actionIds(bystander), [])

    // A conversation nobody is recorded as having started is not everybody's:
    // a signed-out (or not-yet-resolved) viewer must not match a null starter.
    assert.equal(
      mayRenameConversation(
        doorway({ conversation: { isGeneral: false, startedByUserId: null }, viewerUserId: null }),
      ),
      false,
    )
    assert.equal(
      mayRenameConversation(
        doorway({ conversation: { isGeneral: false, startedByUserId: null } }),
      ),
      false,
    )
  })

  it('is never offered on a room\'s General thread, nor where there is no conversation', () => {
    // The room's own thread carries the room's name — the server refuses this
    // with `THREAD_TITLE_FIXED`, and the header does not offer the refusal.
    const general = doorway({
      conversation: { isGeneral: true, startedByUserId: ME },
      viewerCanManageChannel: true,
    })
    assert.equal(mayRenameConversation(general), false)
    assert.deepEqual(actionIds(general), [])

    assert.equal(mayRenameConversation(doorway({ conversation: null })), false)
    assert.deepEqual(actionIds(doorway({ conversation: null })), [])
    assert.deepEqual(actionIds(null), [])
  })

  it('is one action in the header\'s own list, and opens the dialog when it is picked', () => {
    let opened = 0
    const actions = renameConversationHeaderActions(
      doorway({ onRename: () => { opened += 1 } }),
    )
    assert.equal(actions.length, 1)
    const [action] = actions
    assert.ok(action)
    assert.equal(action.id, RENAME_CONVERSATION_ACTION_ID)
    assert.equal(action.label, 'Rename')
    assert.equal(action.title, 'Rename this conversation')
    assert.equal(action.kind ?? 'button', 'button')
    assert.ok('onSelect' in action)
    action.onSelect()
    assert.equal(opened, 1)

    // Not primary: the agent's tool doorways are the controls that must
    // survive every width, and this one belongs in More before they do.
    assert.notEqual(action.primary, true)
    assert.ok(action.priority < 90, 'sits below the favourite star')
    assert.ok(action.priority > 80, 'sits above the room\'s own controls')
    assert.equal(action.priority, RENAME_CONVERSATION_ACTION_PRIORITY)
  })

  it('gives up its slot to the tool doorways when the header runs out of room', () => {
    const width = 44
    const layout = [
      { id: 'favorite', priority: 90, width },
      { id: RENAME_CONVERSATION_ACTION_ID, priority: RENAME_CONVERSATION_ACTION_PRIORITY, width },
      { id: 'chat-tool-conversations', primary: true, priority: CHAT_TOOL_ACTION_PRIORITY, width },
      { id: 'search', priority: 40, width },
    ]
    // Room for one control and the overflow trigger: the tool doorway stays,
    // the rename is reachable through More rather than gone.
    const { overflowIds, visibleIds } = partitionPageHeaderActions(layout, 100, 44)
    assert.deepEqual(visibleIds, ['chat-tool-conversations'])
    assert.ok(overflowIds.includes(RENAME_CONVERSATION_ACTION_ID))
  })

  it('is spread into the one header action list rather than drawn as a second bar', () => {
    const header = source('components/features/channels/ChannelHeader.tsx')
    assert.match(header, /\.\.\.renameConversationHeaderActions\(conversationRename\)/)
    assert.doesNotMatch(header, /<header[\s>]/, 'the header is still ScreenHeader\'s')
  })
})

describe('saving a renamed conversation', () => {
  const current = 'Quarterly report'

  it('commits a trimmed title that actually changed', () => {
    assert.equal(
      canSaveConversationTitle({ current, next: 'Quarterly report v2', pending: false }),
      true,
    )
    assert.equal(
      canSaveConversationTitle({ current, next: '  Quarterly report v2  ', pending: false }),
      true,
    )
  })

  it('refuses an unchanged, empty or whitespace-only title', () => {
    assert.equal(canSaveConversationTitle({ current, next: current, pending: false }), false)
    assert.equal(
      canSaveConversationTitle({ current, next: `  ${current}  `, pending: false }),
      false,
      'adding a space is not a rename',
    )
    assert.equal(canSaveConversationTitle({ current, next: '', pending: false }), false)
    assert.equal(canSaveConversationTitle({ current, next: '   ', pending: false }), false)
  })

  it('refuses a title past the server\'s bound, and refuses while one is in flight', () => {
    const atLimit = 'a'.repeat(CONVERSATION_TITLE_MAX_CHARS)
    assert.equal(canSaveConversationTitle({ current, next: atLimit, pending: false }), true)
    assert.equal(
      canSaveConversationTitle({ current, next: `${atLimit}a`, pending: false }),
      false,
    )
    // Trimming happens before the bound, exactly as `RenameThreadBodySchema`
    // does it: a title that only overflows in whitespace is still savable.
    assert.equal(
      canSaveConversationTitle({ current, next: `  ${atLimit}  `, pending: false }),
      true,
    )
    assert.equal(
      canSaveConversationTitle({ current, next: 'Quarterly report v2', pending: true }),
      false,
    )
  })

  it('says what the name is for, and holds the field to the same bound', () => {
    const dialog = source('components/features/channels/RenameConversationDialog.tsx')
    assert.match(dialog, /title="Rename conversation"/)
    assert.match(dialog, /Anyone who can see this conversation sees the name\./)
    assert.match(dialog, /maxLength=\{CONVERSATION_TITLE_MAX_CHARS\}/)
    // The refusal lands on the field (`FormField`'s `error` renders
    // `FormFieldError`), and only a failure that never reached the server
    // becomes a `Notice` for the whole dialog.
    assert.match(dialog, /error=\{fieldError\}/)
    assert.match(dialog, /<FormError>\{noticeError\}<\/FormError>/)
  })
})
