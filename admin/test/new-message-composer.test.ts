import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * The New message page (`/channels/new`) writes a conversation's first message
 * in the one composer (docs/standards/design-system.md → "One composer"), so
 * paste, the paperclip and a drop stage files there exactly as they do in a
 * conversation, and the first message links them. The browser proof is a
 * headless run against the page; these pin the wiring it depends on.
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

test('it lands in the thread it wrote in, which an agent DM’s bare address is not', () => {
  assert.match(page, /navigate\(`\/channels\/\$\{channel\.id\}\/threads\/\$\{channel\.defaultThreadId\}`/)
})

test('on split its popovers take the modal-owned layer, since the panel is a modal there', () => {
  assert.match(page, /<OverlayOwnerProvider value=\{phoneLayout \? null : 'modal'\}>/)
})
