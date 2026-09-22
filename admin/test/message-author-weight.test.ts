import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const readSource = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')

test('message author names resolve the bold font-weight token', () => {
  const styles = readSource('../src/styles.css')
  const messageRow = readSource('../src/components/features/channels/ChannelMessageRow.tsx')
  const transientRows = readSource('../src/components/features/channels/ChannelTransientMessageRows.tsx')

  assert.match(styles, /--font-weight-bold:\s*700;/)
  assert.match(messageRow, /font-bold text-\[var\(--tx\)\]/)
  assert.match(transientRows, /font-bold text-\[var\(--tx\)\]/)
})

test('message reactions precede the reply summary', () => {
  const messageBody = readSource('../src/components/features/channels/ChannelMessageBody.tsx')
  const reactions = messageBody.indexOf('<ChannelMessageActions')
  const replySummary = messageBody.indexOf('<ReplySummaryBar')

  assert.notEqual(reactions, -1)
  assert.notEqual(replySummary, -1)
  assert.ok(reactions < replySummary)
})

test('fine-pointer message actions use the reference floating toolbar', () => {
  const styles = readSource('../src/styles.css')
  const actions = styles.slice(
    styles.indexOf('.admin-msg-actions {'),
    styles.indexOf('.admin-msg-action-button {'),
  )
  const finePointer = styles.slice(styles.indexOf('@media (hover: hover) and (pointer: fine)'))

  assert.match(actions, /gap: 2px;/)
  assert.match(actions, /border: 0;/)
  assert.match(actions, /border-radius: 10px;/)
  assert.match(actions, /background: var\(--panel\);/)
  assert.match(actions, /padding: 3px;/)
  assert.match(actions, /0 1px 2px rgb\(0 0 0 \/ 5%\)/)
  assert.match(actions, /0 6px 20px rgb\(0 0 0 \/ 5%\)/)
  assert.match(finePointer, /top: -12px;/)
  assert.match(finePointer, /right: 20px;/)
  assert.match(finePointer, /width: 26px;/)
  assert.match(finePointer, /height: 26px;/)
  assert.match(finePointer, /border-radius: 10px;/)
  assert.match(finePointer, /width: 14px;/)
  assert.match(finePointer, /height: 14px;/)
})

test('message action toolbar uses the reference Lucide icon set', () => {
  const actions = readSource('../src/components/features/channels/ChannelMessageActions.tsx')

  assert.match(actions, /from 'lucide-react'/)
  for (const icon of ['Check', 'Copy', 'Smile', 'Reply', 'Pencil', 'Trash2']) {
    assert.match(actions, new RegExp(`<${icon}(?:\\s|>)`))
  }
})

test('channel, knowledge, and agent actions reuse one toolbar control', () => {
  const channelActions = readSource('../src/components/features/channels/ChannelMessageActions.tsx')
  const commentActions = readSource('../src/components/features/knowledge/comments/CommentActions.tsx')
  const agentRow = readSource('../src/components/features/agents/AgentListRow.tsx')

  assert.match(channelActions, /<SharedActionToolbar/)
  assert.match(commentActions, /<SharedActionToolbar/)
  assert.match(agentRow, /<SharedActionButton/)
  for (const icon of ['ThumbsUp', 'Smile', 'Reply', 'Check', 'RotateCcw', 'Pencil', 'Trash2']) {
    assert.match(commentActions, new RegExp(`<${icon}(?:\\s|>)`))
  }
})

test('fine-pointer clicks do not pin message actions after hover ends', () => {
  const messageRow = readSource('../src/components/features/channels/ChannelMessageRow.tsx')
  const styles = readSource('../src/styles.css')

  assert.doesNotMatch(messageRow, /onClick=.*setActiveActionMessageId/)
  assert.match(messageRow, /event\.pointerType !== 'mouse'/)
  assert.match(styles, /\.admin-msg-row:focus-visible \.admin-msg-actions/)
  assert.doesNotMatch(styles, /\.admin-msg-row:focus-within \.admin-msg-actions \{/)
})

test('an open emoji picker keeps its portalled anchor toolbar laid out', () => {
  const styles = readSource('../src/styles.css')
  const emojiButton = readSource('../src/components/shared/EmojiReactionButton.tsx')

  assert.match(emojiButton, /data-emoji-picker-open=\{open\}/)
  assert.match(
    styles,
    /\.admin-msg-actions:has\(\[data-emoji-picker-open="true"\]\)\s*\{\s*display: flex;/,
  )

  const emojiMenu = styles.slice(
    styles.indexOf('.admin-msg-emoji-menu {'),
    styles.indexOf('@media (hover: hover) and (pointer: fine)'),
  )
  assert.doesNotMatch(emojiMenu, /\b(?:bottom|position|right|z-index):/)
})

test('knowledge and project comments leave room for the floating toolbar', () => {
  const commentThread = readSource('../src/components/features/knowledge/comments/CommentThread.tsx')
  const styles = readSource('../src/styles.css')

  assert.match(commentThread, /relative overflow-visible rounded-md/)
  assert.match(commentThread, /admin-comment-row admin-msg-row/)
  assert.match(styles, /\.admin-comment-row \{\s*padding-block: 10px;/)
})
