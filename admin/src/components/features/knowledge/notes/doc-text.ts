import type { Node as ProseMirrorNode } from '@tiptap/pm/model'

export type TextSegment = { offset: number; pos: number; length: number }
export type DocText = { text: string; segments: TextSegment[] }

// Project a ProseMirror document to a plain-text string and keep a map from
// text offsets back to document positions. Text nodes are concatenated without
// block separators; note anchors only span within a block, so this matches the
// quote text captured on selection and (for single-block quotes) the server's
// htmlToPlainText projection used by agent-authored notes.
export const buildDocText = (doc: ProseMirrorNode): DocText => {
  let text = ''
  const segments: TextSegment[] = []
  doc.descendants((node, pos) => {
    if (node.isText && node.text) {
      segments.push({ offset: text.length, pos, length: node.text.length })
      text += node.text
    }
    return true
  })
  return { text, segments }
}

export const offsetToPos = (docText: DocText, offset: number): number | null => {
  for (const segment of docText.segments) {
    if (offset >= segment.offset && offset <= segment.offset + segment.length) {
      return segment.pos + (offset - segment.offset)
    }
  }
  return null
}

export const posToOffset = (docText: DocText, pos: number): number | null => {
  for (const segment of docText.segments) {
    if (pos >= segment.pos && pos <= segment.pos + segment.length) {
      return segment.offset + (pos - segment.pos)
    }
  }
  return null
}
