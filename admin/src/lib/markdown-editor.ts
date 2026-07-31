import { findMarkdownCodeRanges, type MarkdownCodeRange } from './message-markdown'

type MentionRange = {
  end: number
  id: string
  start: number
  text: string
  type: string
}

// A line break the browser needs to paint an empty final line. It carries no
// author text, so every offset walk below steps over it.
const isFillerBreak = (node: Node): boolean =>
  node.nodeType === Node.ELEMENT_NODE &&
  (node as HTMLElement).dataset.fillerBreak === 'true'

// Concealed delimiters stay in the DOM — they are part of what gets sent — but
// carry no caret positions of their own, so they behave as one atomic unit.
const concealedLength = (node: Node): number | null => {
  if (node.nodeType !== Node.ELEMENT_NODE) return null
  const element = node as HTMLElement
  if (element.dataset.markdownFence !== 'concealed') return null
  return element.textContent?.length ?? 0
}

// The browser drops its own filler <br> into an editable block that would
// otherwise render empty. Ours is tagged and always sits last, so an untagged
// final break at the top level is the browser's and carries no author newline.
export function extractEditorText(node: Node, isRoot = true): string {
  let output = ''
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      output += child.textContent ?? ''
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      if (isFillerBreak(child)) continue
      const element = child as HTMLElement
      if (element.tagName !== 'BR') {
        output += extractEditorText(element, false)
      } else if (!isRoot || child !== node.lastChild) {
        output += '\n'
      }
    }
  }
  return output
}

const editorTextLength = (node: Node): number => {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent?.length ?? 0
  if (node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).tagName === 'BR') {
    return isFillerBreak(node) ? 0 : 1
  }
  return extractEditorText(node, false).length
}

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
        if (!isFillerBreak(element)) offset += 1
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
      if (!isFillerBreak(node)) offset += 1
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

// A concealed delimiter is atomic like a mention chip: uneditable so the
// browser never types into a span it cannot show, and crossed by a single
// arrow press instead of one dead keystroke per backtick.
const appendFence = (parent: Node, text: string, conceal: boolean) => {
  if (!text) return
  const fence = document.createElement('span')
  fence.className = 'mention-editor-fence'
  fence.dataset.markdownFence = conceal ? 'concealed' : 'visible'
  if (conceal) fence.contentEditable = 'false'
  fence.textContent = text
  parent.appendChild(fence)
}

const intersectsCode = (mention: MentionRange, codeRanges: MarkdownCodeRange[]) =>
  codeRanges.some((code) => mention.start < code.end && mention.end > code.start)

// Delimiters are dropped from view once they wrap something, the way a chat
// composer shows the finished snippet rather than its syntax. An empty pair
// keeps its backticks so a half-typed fence never becomes invisible.
const appendCodeSegment = (
  parent: Node,
  text: string,
  range: MarkdownCodeRange,
) => {
  const code = document.createElement('span')
  code.dataset.markdownCode = range.kind
  code.className = `mention-editor-code mention-editor-code-${range.kind}`
  const conceal = range.contentEnd > range.contentStart

  appendFence(code, text.slice(range.start, range.contentStart), conceal)
  appendText(code, text.slice(range.contentStart, range.contentEnd))
  appendFence(code, text.slice(range.contentEnd, range.end), conceal)
  parent.appendChild(code)
}

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
      appendCodeSegment(fragment, text, segment)
    }
    cursor = segment.end
  }
  appendText(fragment, text.slice(cursor))
  if (text.endsWith('\n')) {
    const filler = document.createElement('br')
    filler.dataset.fillerBreak = 'true'
    fragment.appendChild(filler)
  }
  editor.replaceChildren(fragment)
}

const restoreCursor = (editor: HTMLElement, targetOffset: number) => {
  let offset = 0
  let target: { node: Node; offset: number } | null = null

  // The edge of a code span belongs to the text around it, not to the span:
  // a caret parked inside one at its own boundary is not a position the
  // browser will type into, so it slides typing back under the delimiter.
  const outside = (node: Node, after: boolean): { node: Node; offset: number } => {
    const parent = node.parentNode ?? editor
    const index = Array.prototype.indexOf.call(parent.childNodes, node)
    const position = after ? index + 1 : index
    const atEdge = position === 0 || position === parent.childNodes.length
    return parent !== editor && atEdge && (parent as HTMLElement).dataset?.markdownCode
      ? outside(parent, position > 0)
      : { node: parent, offset: position }
  }

  const visit = (node: Node) => {
    if (target) return
    const concealed = concealedLength(node)
    if (concealed !== null) {
      if (targetOffset <= offset + concealed) {
        target = outside(node, targetOffset > offset)
      }
      offset += concealed
      return
    }
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
      if (isFillerBreak(node)) return
      if (targetOffset <= offset + 1) target = outside(node, true)
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

const caretOffset = (editor: HTMLElement): number | null => {
  const selection = window.getSelection()
  const anchorNode = selection?.anchorNode ?? null
  const inEditor = Boolean(
    selection && selection.rangeCount > 0 && anchorNode && editor.contains(anchorNode),
  )
  return inEditor && selection && anchorNode
    ? pointOffset(editor, anchorNode, selection.anchorOffset)
    : null
}

export const decorateMarkdownEditor = (editor: HTMLElement, text: string): void => {
  const cursor = caretOffset(editor)
  const mentions = collectMentionRanges(editor)
  appendDecoratedContent(editor, text, mentions, findMarkdownCodeRanges(text))
  if (cursor !== null) restoreCursor(editor, cursor)
}

const spliceEditorText = (
  editor: HTMLElement,
  start: number,
  end: number,
  insertion: string,
): string => {
  const text = extractEditorText(editor)
  const next = text.slice(0, start) + insertion + text.slice(end)
  const shift = insertion.length - (end - start)
  const mentions = collectMentionRanges(editor).map((mention) =>
    mention.start < start
      ? mention
      : { ...mention, end: mention.end + shift, start: mention.start + shift },
  )

  appendDecoratedContent(editor, next, mentions, findMarkdownCodeRanges(next))
  restoreCursor(editor, start + insertion.length)
  return next
}

// Browsers disagree about what a soft line break inserts into a contenteditable
// — Chrome adds two <br>s and leaves the caret nowhere. Splicing the text
// ourselves keeps the document and the caret exactly where the author put them.
export const insertMarkdownEditorText = (
  editor: HTMLElement,
  insertion: string,
): string => {
  const cursor = caretOffset(editor) ?? extractEditorText(editor).length
  return spliceEditorText(editor, cursor, cursor, insertion)
}

const concealedRanges = (text: string): MarkdownCodeRange[] =>
  findMarkdownCodeRanges(text).filter((range) => range.contentEnd > range.contentStart)

// Which characters one delete keystroke should remove. A delimiter goes whole —
// it is a single invisible object to the author — and any other character goes
// on its own, including one merely adjacent to a snippet, which the browser
// would otherwise take together with the delimiter beside it.
const deleteSpan = (
  ranges: MarkdownCodeRange[],
  index: number,
): [number, number] | null => {
  const touched = ranges.find((range) => range.start <= index + 1 && range.end >= index)
  if (!touched) return null
  if (index >= touched.start && index < touched.contentStart) {
    return [touched.start, touched.contentStart]
  }
  if (index >= touched.contentEnd && index < touched.end) {
    return [touched.contentEnd, touched.end]
  }
  return [index, index + 1]
}

// Inside a snippet whose delimiters are out of view the browser edits blind: it
// types under a delimiter it cannot show and deletes whole ones by surprise.
// Every edit that touches a concealed range is therefore applied to the text
// here, so what the author sees and what gets sent stay the same document.
// Returns the new text when it owned the edit, or null to leave it to the browser.
export const applyConcealedFenceEdit = (
  editor: HTMLElement,
  inputType: string,
  data: string | null,
): string | null => {
  const selection = window.getSelection()
  if (!selection?.isCollapsed) return null

  const text = extractEditorText(editor)
  const cursor = caretOffset(editor)
  if (cursor === null) return null

  const ranges = concealedRanges(text)

  if (inputType === 'insertText' && data !== null) {
    const abuts = ranges.some(
      (range) => cursor === range.end || cursor === range.start,
    )
    return abuts ? spliceEditorText(editor, cursor, cursor, data) : null
  }

  const removed =
    inputType === 'deleteContentBackward' && cursor > 0
      ? deleteSpan(ranges, cursor - 1)
      : inputType === 'deleteContentForward' && cursor < text.length
        ? deleteSpan(ranges, cursor)
        : null

  return removed ? spliceEditorText(editor, removed[0], removed[1], '') : null
}

export const setMarkdownEditorText = (editor: HTMLElement, text: string): void => {
  editor.replaceChildren()
  appendText(editor, text)
  decorateMarkdownEditor(editor, text)
}
