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

test('fine-pointer message actions use the enlarged floating toolbar', () => {
  const styles = readSource('../src/styles.css')
  const actions = styles.slice(
    styles.indexOf('.admin-msg-actions {'),
    styles.indexOf('.admin-msg-action-button {'),
  )
  const finePointer = styles.slice(styles.indexOf('@media (hover: hover) and (pointer: fine)'))

  assert.match(actions, /gap: 3px;/)
  assert.match(actions, /border: 0;/)
  assert.match(actions, /border-radius: 14px;/)
  assert.match(actions, /padding: 4px;/)
  assert.match(actions, /0 1px 2px rgb\(0 0 0 \/ 5%\)/)
  assert.match(actions, /0 6px 20px rgb\(0 0 0 \/ 5%\)/)
  assert.match(finePointer, /top: -12px;/)
  assert.match(finePointer, /right: 20px;/)
  assert.match(finePointer, /width: 36px;/)
  assert.match(finePointer, /height: 36px;/)
  assert.match(finePointer, /font-size: 20px;/)
})
