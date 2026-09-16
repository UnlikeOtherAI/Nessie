import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { approvalKeys } from '../src/facades/approvals/keys.js'

const source = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')

test('both private mail-send approvals use one frozen-draft preview contract', () => {
  const hooks = source('../src/facades/approvals/hooks.ts')
  const gate = source('../src/components/features/channels/ApprovalGate.tsx')

  assert.deepEqual(
    approvalKeys.mailSendDraft('mailbox_send', 'approval-1'),
    ['approvals', 'approval-1', 'mail-send-draft', 'mailbox_send'],
  )
  assert.deepEqual(
    approvalKeys.mailSendDraft('gmail_draft_send', 'approval-1'),
    ['approvals', 'approval-1', 'mail-send-draft', 'gmail_draft_send'],
  )
  assert.match(hooks, /\/api\/gmail\/drafts\/approvals\/\$\{approvalId\}\/draft/)
  assert.match(hooks, /\/api\/mailbox-connections\/approvals\/\$\{approvalId\}\/draft/)
  assert.match(gate, /gate\?\.toolName === 'mailbox_send' \|\| gate\?\.toolName === 'gmail_draft_send'/)
  assert.match(gate, /active && isMailSend && mailDraft\.data/)
  assert.match(gate, /active && isGmailSend && mailDraft\.data/)
  assert.match(gate, /<MailboxSendApprovalPreview draft=\{mailDraft\.data\}/)
  // There is no second surface to keep in step any more: an approval is
  // answered on its card, so the frozen draft has exactly one renderer.
  assert.match(gate, /disabled=\{resolve\.isPending \|\| \(resolution === 'approved' && !canApprove\)\}/)
  assert.match(hooks, /active: boolean/)
  assert.match(hooks, /removeQueries\(\{ queryKey: approvalKeys\.mailSendDraft\('gmail_draft_send', input\.id\) \}\)/)
  assert.doesNotMatch(gate, /inputSummary.*gmail_draft_send/)
})
