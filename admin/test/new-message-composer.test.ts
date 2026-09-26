import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * The New message page (`/channels/new`) writes a conversation's first message
 * in the one composer (docs/standards/design-system.md → "One composer"), so
 * paste, the paperclip and a drop stage files there exactly as they do in a
 * conversation, the first message links them, and a typed credential is
 * stopped for the vault before anything is sent. The browser proof is a
 * headless run against the page; these pin the wiring it depends on. The
 * interception itself is `secret-capture-interception.test.ts`.
 */

const page = readFileSync(
  fileURLToPath(new URL('../src/pages/ChannelConversationComposePage.tsx', import.meta.url)),
  'utf8',
)

test('the page writes in the one composer, not a copy of its editor', () => {
  assert.match(page, /<ChannelComposer\s/)
  // Elements, not the `useRef<MentionInputHandle>` the page still holds.
  assert.doesNotMatch(page, /<MentionInput\s/)
  assert.doesNotMatch(page, /<form\s/)
})

test('its files are staged the way every composer stages them, a drop included', () => {
  assert.match(page, /const attachments = useComposerAttachments\(\)/)
  assert.match(page, /attachments=\{attachments\}/)
  assert.match(page, /useFileDrop\(attachments\.addFiles\)/)
  assert.match(page, /\{\.\.\.drop\.dropHandlers\}/)
  assert.match(page, /<DropZoneOverlay active=\{drop\.isDragging\} label="Drop files to attach" \/>/)
})

test('the first message carries the finished uploads, and only a sent one clears them', () => {
  assert.match(page, /\.\.\.\(attachmentIds\.length > 0 \? \{ attachmentIds \} : \{\}\)/)
  const success = page.slice(page.indexOf('await sendMessage.mutateAsync'), page.indexOf('} catch (err) {'))
  const failure = page.slice(page.indexOf('} catch (err) {'), page.indexOf('} finally {'))
  assert.match(success, /attachments\.clearStaged\(\)/)
  assert.doesNotMatch(failure, /clearStaged/, 'a failed start keeps the staged files')
  assert.match(failure, /restoreText\(content\)/, 'and puts back words Enter already took')
})

test('a typed credential is held before the conversation is started', () => {
  // The interception every composer runs, with no room yet to offer as scope.
  assert.match(page, /useSecretCapture\(\{ projectId: null \}\)/)
  const submit = page.slice(
    page.indexOf('const submit = useCallback'),
    page.indexOf('const confirmSecretCapture'),
  )
  const intercept = submit.indexOf('interceptSecret(content, { agentMentions')
  assert.ok(intercept > 0, 'the send scans its text')
  assert.ok(
    intercept < submit.indexOf('startConversation.mutateAsync'),
    'before the conversation request, not just the message one',
  )
  const held = submit.slice(intercept, submit.indexOf('sending.current = true'))
  assert.match(held, /mentionRef\.current\?\.clear\(\)/)
  assert.match(held, /setMessage\(''\)/)
  assert.match(held, /return/)
  assert.doesNotMatch(held, /restoreText/, 'the raw words are not put back')
  assert.doesNotMatch(held, /clearStaged/, 'the staged files wait for the masked resend')
})

test('it shows the one capture form, and saving starts the conversation masked', () => {
  assert.match(page, /secretCapture=\{secretCapture\}/)
  assert.match(page, /onConfirmSecretCapture=\{confirmSecretCapture\}/)
  assert.match(page, /onDismissSecretCapture=\{dismissSecretCapture\}/)
  const confirm = page.slice(
    page.indexOf('const confirmSecretCapture'),
    page.indexOf('const isPending'),
  )
  // The masked turn takes the same start as any first message, so it lands in
  // its thread, carries the staged files, and restores its words on failure.
  assert.match(confirm, /const turn = releaseSecret\(secret\)/)
  assert.match(confirm, /await submit\(turn\.content, turn\.agentMentions\)/)
})

test('it lands in the thread it wrote in, which an agent DM’s bare address is not', () => {
  assert.match(page, /navigate\(`\/channels\/\$\{channel\.id\}\/threads\/\$\{channel\.defaultThreadId\}`/)
})

test('on split its popovers take the modal-owned layer, since the panel is a modal there', () => {
  assert.match(page, /<OverlayOwnerProvider value=\{phoneLayout \? null : 'modal'\}>/)
})
