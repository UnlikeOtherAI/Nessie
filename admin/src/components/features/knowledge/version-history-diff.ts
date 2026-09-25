export type VersionDiffChange = 'same' | 'added' | 'removed' | 'format'

export type VersionDiffToken = {
  text: string
  marks: string
}

export type VersionDiffOperation = {
  change: VersionDiffChange
  oldToken?: VersionDiffToken
  newToken?: VersionDiffToken
}

const BLOCK_TAGS = new Set([
  'address', 'article', 'blockquote', 'dd', 'div', 'dl', 'dt', 'h1', 'h2', 'h3',
  'h4', 'h5', 'h6', 'li', 'ol', 'p', 'pre', 'section', 'table', 'tr', 'ul',
])
const IGNORED_TAGS = new Set(['script', 'style', 'template', 'iframe', 'object', 'svg', 'math'])
const INLINE_MARKS: Record<string, string> = {
  b: 'bold', strong: 'bold', i: 'italic', em: 'italic', u: 'underline',
  s: 'strike', del: 'strike', strike: 'strike', code: 'code',
}
const MAX_DIFF_CELLS = 1_000_000

const appendToken = (tokens: VersionDiffToken[], text: string, marks: string) => {
  if (!text) return
  tokens.push({ text, marks })
}

/** Parse stored HTML into text and formatting metadata. DOMParser never runs
 * parsed scripts, and consumers render only the resulting text as React text.
 */
export const richTextToTokens = (html: string | null | undefined): VersionDiffToken[] => {
  if (!html) return []
  const document = new DOMParser().parseFromString(html, 'text/html')
  const tokens: VersionDiffToken[] = []

  const visit = (node: Node, inheritedMarks: string[]) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? ''
      const marks = inheritedMarks.join('|')
      for (const part of text.match(/\s+|[^\s]+/g) ?? []) appendToken(tokens, part, marks)
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return

    const element = node as Element
    const tag = element.tagName.toLowerCase()
    if (IGNORED_TAGS.has(tag)) return
    if (tag === 'br') {
      appendToken(tokens, '\n', inheritedMarks.join('|'))
      return
    }

    const marks = [...inheritedMarks]
    const mark = INLINE_MARKS[tag]
    if (mark && !marks.includes(mark)) marks.push(mark)
    if (/^h[1-6]$/.test(tag)) marks.push(`heading-${tag[1]}`)
    if (tag === 'pre') marks.push('code')
    if (tag === 'a') marks.push('link')

    const isBlock = BLOCK_TAGS.has(tag)
    if (isBlock && tokens.length && !tokens[tokens.length - 1]?.text.endsWith('\n')) {
      appendToken(tokens, '\n', '')
    }
    if (tag === 'li') appendToken(tokens, '• ', marks.join('|'))
    element.childNodes.forEach((child) => visit(child, marks))
    if (isBlock && !tokens[tokens.length - 1]?.text.endsWith('\n')) {
      appendToken(tokens, '\n', '')
    }
  }

  document.body.childNodes.forEach((node) => visit(node, []))
  while (tokens[0]?.text === '\n') tokens.shift()
  while (tokens[tokens.length - 1]?.text === '\n') tokens.pop()
  return tokens
}

/** Word-level LCS keeps prose readable and identifies formatting-only edits. */
export const buildVersionDiff = (
  oldHtml: string | null | undefined,
  newHtml: string | null | undefined,
): VersionDiffOperation[] => {
  const oldTokens = richTextToTokens(oldHtml)
  const newTokens = richTextToTokens(newHtml)
  const rows = oldTokens.length + 1
  const columns = newTokens.length + 1

  if (oldTokens.length * newTokens.length > MAX_DIFF_CELLS) {
    return [
      ...oldTokens.map((oldToken): VersionDiffOperation => ({ change: 'removed', oldToken })),
      ...newTokens.map((newToken): VersionDiffOperation => ({ change: 'added', newToken })),
    ]
  }

  const lcs = new Uint32Array(rows * columns)
  for (let oldIndex = oldTokens.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newTokens.length - 1; newIndex >= 0; newIndex -= 1) {
      const cell = oldIndex * columns + newIndex
      lcs[cell] = oldTokens[oldIndex]?.text === newTokens[newIndex]?.text
        ? 1 + (lcs[(oldIndex + 1) * columns + newIndex + 1] ?? 0)
        : Math.max(lcs[(oldIndex + 1) * columns + newIndex] ?? 0, lcs[cell + 1] ?? 0)
    }
  }

  const operations: VersionDiffOperation[] = []
  let oldIndex = 0
  let newIndex = 0
  while (oldIndex < oldTokens.length || newIndex < newTokens.length) {
    const oldToken = oldTokens[oldIndex]
    const newToken = newTokens[newIndex]
    if (oldToken && newToken && oldToken.text === newToken.text) {
      operations.push({
        change: oldToken.marks === newToken.marks ? 'same' : 'format',
        oldToken,
        newToken,
      })
      oldIndex += 1
      newIndex += 1
    } else if (
      oldToken
      && (!newToken || (lcs[(oldIndex + 1) * columns + newIndex] ?? 0) >= (lcs[oldIndex * columns + newIndex + 1] ?? 0))
    ) {
      operations.push({ change: 'removed', oldToken })
      oldIndex += 1
    } else if (newToken) {
      operations.push({ change: 'added', newToken })
      newIndex += 1
    }
  }
  return operations
}
