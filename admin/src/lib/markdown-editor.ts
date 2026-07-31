import { findMarkdownCodeRanges, type MarkdownCodeRange } from './message-markdown'

type MentionRange = {
  end: number
  id: string
  start: number
  text: string
  type: string
}

export function extractEditorText(node: Node): string {
  let output = ''
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      output += child.textContent ?? ''
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const element = child as HTMLElement
      output += element.tagName === 'BR' ? '\n' : extractEditorText(element)
    }
  }
  return output
}

const editorTextLength = (node: Node): number =>
  node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).tagName === 'BR'
    ? 1
    : extractEditorText(node).length

const collectMentionRanges = (editor: HTMLElement): MentionRange[] => {
  const ranges: MentionRange[] = []
  let offset = 0

  const visit = (node: Node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        offset += child.textContent?.length ?? 0
        continue
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue

      const element = child as HTMLElement
      if (element.tagName === 'BR') {
        offset += 1
      } else if (element.dataset.mentionId) {
        const text = element.textContent ?? ''
        ranges.push({
          end: offset + text.length,
          id: element.dataset.mentionId,
          start: offset,
          text,
          type: element.dataset.mentionType ?? 'user',
        })
        offset += text.length
      } else {
        visit(element)
      }
    }
  }

  visit(editor)
  return ranges
}

const pointOffset = (
  root: HTMLElement,
  targetNode: Node,
  targetOffset: number,
): number | null => {
  let offset = 0
  let found: number | null = null

  const visit = (node: Node) => {
    if (found !== null) return
    if (node === targetNode) {
      if (node.nodeType === Node.TEXT_NODE) {
        found = offset + targetOffset
        return
      }
      for (let index = 0; index < targetOffset; index += 1) {
        const child = node.childNodes[index]
        if (child) offset += editorTextLength(child)
      }
      found = offset
      return
    }

    if (node.nodeType === Node.TEXT_NODE) {
      offset += node.textContent?.length ?? 0
      return
    }
    if (node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).tagName === 'BR') {
      offset += 1
      return
    }
    for (const child of node.childNodes) visit(child)
  }

  visit(root)
  return found
}

const appendText = (parent: Node, text: string) => {
  const lines = text.split('\n')
  lines.forEach((line, index) => {
    if (index > 0) parent.appendChild(document.createElement('br'))
    if (line) parent.appendChild(document.createTextNode(line))
  })
}

const intersectsCode = (mention: MentionRange, codeRanges: MarkdownCodeRange[]) =>
  codeRanges.some((code) => mention.start < code.end && mention.end > code.start)

const appendDecoratedContent = (
  editor: HTMLElement,
  text: string,
  mentions: MentionRange[],
  codeRanges: MarkdownCodeRange[],
) => {
  const fragment = document.createDocumentFragment()
  const segments = [
    ...codeRanges.map((range) => ({ ...range, segment: 'code' as const })),
    ...mentions
      .filter((mention) => !intersectsCode(mention, codeRanges))
      .map((range) => ({ ...range, segment: 'mention' as const })),
  ].sort((left, right) => left.start - right.start)
  let cursor = 0

  for (const segment of segments) {
    if (segment.start < cursor) continue
    appendText(fragment, text.slice(cursor, segment.start))
    if (segment.segment === 'mention') {
      const mention = document.createElement('span')
      mention.contentEditable = 'false'
      mention.dataset.mentionId = segment.id
      mention.dataset.mentionType = segment.type
      mention.className = 'mention-tag'
      mention.textContent = segment.text
      fragment.appendChild(mention)
    } else {
      const code = document.createElement('span')
      code.dataset.markdownCode = segment.kind
      code.className = `mention-editor-code mention-editor-code-${segment.kind}`
      appendText(code, text.slice(segment.start, segment.end))
      fragment.appendChild(code)
    }
    cursor = segment.end
  }
  appendText(fragment, text.slice(cursor))
  editor.replaceChildren(fragment)
}

const restoreCursor = (editor: HTMLElement, targetOffset: number) => {
  let offset = 0
  let target: { node: Node; offset: number } | null = null

  const visit = (node: Node) => {
    if (target) return
    if (node.nodeType === Node.TEXT_NODE) {
      const length = node.textContent?.length ?? 0
      if (targetOffset <= offset + length) {
        target = { node, offset: Math.max(0, targetOffset - offset) }
      } else {
        offset += length
      }
      return
    }
    if (node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).tagName === 'BR') {
      if (targetOffset <= offset + 1) {
        const parent = node.parentNode ?? editor
        target = {
          node: parent,
          offset: Array.prototype.indexOf.call(parent.childNodes, node) + 1,
        }
      }
      offset += 1
      return
    }
    for (const child of node.childNodes) visit(child)
  }
  visit(editor)

  const selection = window.getSelection()
  if (!selection) return
  const range = document.createRange()
  const resolvedTarget = target as { node: Node; offset: number } | null
  if (resolvedTarget) {
    range.setStart(resolvedTarget.node, resolvedTarget.offset)
  } else {
    range.selectNodeContents(editor)
    range.collapse(false)
  }
  range.collapse(true)
  selection.removeAllRanges()
  selection.addRange(range)
}

export const decorateMarkdownEditor = (editor: HTMLElement, text: string): void => {
  const selection = window.getSelection()
  const anchorNode = selection?.anchorNode ?? null
  const hasEditorSelection = Boolean(
    selection && selection.rangeCount > 0 && anchorNode && editor.contains(anchorNode),
  )
  const cursorOffset = hasEditorSelection && selection && anchorNode
    ? pointOffset(editor, anchorNode, selection.anchorOffset)
    : null
  const mentions = collectMentionRanges(editor)
  appendDecoratedContent(editor, text, mentions, findMarkdownCodeRanges(text))
  if (cursorOffset !== null) restoreCursor(editor, cursorOffset)
}

export const setMarkdownEditorText = (editor: HTMLElement, text: string): void => {
  editor.replaceChildren()
  appendText(editor, text)
  decorateMarkdownEditor(editor, text)
}
