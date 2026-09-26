import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = (relativePath: string): string =>
  readFileSync(new URL(relativePath, import.meta.url), 'utf8')

test('document and file details expose attachments inline with list and grid layouts', () => {
  const attachments = source('../src/components/features/knowledge/AttachmentsDrawer.tsx')
  const preview = source('../src/components/features/knowledge/PagePreview.tsx')
  const file = source('../src/components/features/knowledge/FileNodeViewer.tsx')

  assert.match(preview, /<AttachmentsDrawer[\s\S]*?inline/)
  assert.match(file, /<AttachmentsDrawer[\s\S]*?inline/)
  assert.match(attachments, /'grid' \| 'list'/)
  assert.match(attachments, /Add attachment/)
  assert.match(attachments, /attachmentThumbnailPath/)
  assert.match(attachments, /useAttachmentViewer/)
  assert.match(attachments, /Download \$\{attachment\.filename\}/)
  assert.match(attachments, /Delete \$\{attachment\.filename\}/)
})

test('document sections use matching headings and the Attachments action focuses its destination', () => {
  const attachments = source('../src/components/features/knowledge/AttachmentsDrawer.tsx')
  const comments = source('../src/components/features/knowledge/comments/CommentsSection.tsx')
  const documentPane = source('../src/components/features/knowledge/KnowledgeDocumentPane.tsx')

  assert.match(attachments, /<SectionLabel as="h2"[^>]*size="2xs">\s*Attachments/)
  assert.match(comments, /<SectionLabel as="h2"[^>]*size="2xs">Comments/)
  assert.match(attachments, /id="knowledge-page-attachments"[\s\S]*?tabIndex=\{-1\}/)
  assert.match(documentPane, /section\?\.focus\(\{ preventScroll: true \}\)/)
  assert.match(documentPane, /section\?\.scrollIntoView\(\{ behavior: 'smooth', block: 'start' \}\)/)
  assert.match(documentPane, /paneRef\.current\?\.querySelector/)
})

test('document terminology is consistent across creation and document actions', () => {
  const editor = source('../src/components/features/knowledge/PageEditor.tsx')
  const preview = source('../src/components/features/knowledge/PagePreview.tsx')
  const review = source('../src/components/features/knowledge/ReviewPanel.tsx')
  const createLink = source('../src/components/features/knowledge/wikilink/WikilinkCreateConfirm.tsx')

  assert.match(editor, /Save as draft/)
  assert.match(editor, /Publish/)
  assert.match(editor, /New document/)
  assert.match(preview, /Archive document/)
  assert.match(preview, /More document actions/)
  assert.match(review, /New document/)
  assert.match(createLink, /Create document/)
})
