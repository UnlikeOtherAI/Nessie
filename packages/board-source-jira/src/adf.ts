/**
 * Atlassian Document Format, both ways, for comments.
 *
 * Descriptions keep going through `adfToText` (normalise.ts) because the
 * description is part of an item's fingerprint and changing its rendering would
 * re-apply every mirrored issue once. Comments are applied outside the
 * fingerprint, so they can be read as the Markdown the comment surface
 * renders — paragraphs, emphasis, links, lists, code — without that cost.
 *
 * Media nodes are skipped: an ADF media id is not a URL, so an image inside a
 * comment is not resolved in v1 (the issue's attachment list carries the file).
 */

type AdfMark = { type?: string; attrs?: { href?: string } }
type AdfNode = {
  type?: string
  text?: string
  marks?: AdfMark[]
  attrs?: Record<string, unknown>
  content?: AdfNode[]
}

const inline = (nodes: AdfNode[] | undefined): string =>
  (nodes ?? []).map((node) => inlineNode(node)).join('')

const withMarks = (text: string, marks: AdfMark[] | undefined): string => {
  let out = text
  for (const mark of marks ?? []) {
    switch (mark.type) {
      case 'strong':
        out = `**${out}**`
        break
      case 'em':
        out = `*${out}*`
        break
      case 'strike':
        out = `~~${out}~~`
        break
      case 'code':
        out = `\`${out}\``
        break
      case 'link':
        if (mark.attrs?.href) out = `[${out}](${mark.attrs.href})`
        break
      default:
        break
    }
  }
  return out
}

const inlineNode = (node: AdfNode): string => {
  switch (node.type) {
    case 'text':
      return withMarks(node.text ?? '', node.marks)
    case 'hardBreak':
      return '\n'
    case 'mention':
      return String(node.attrs?.text ?? '@someone')
    case 'emoji':
      return String(node.attrs?.text ?? node.attrs?.shortName ?? '')
    case 'inlineCard': {
      const url = node.attrs?.url
      return typeof url === 'string' ? url : ''
    }
    case 'date': {
      const stamp = Number(node.attrs?.timestamp)
      return Number.isFinite(stamp) ? new Date(stamp).toISOString().slice(0, 10) : ''
    }
    default:
      return node.content ? inline(node.content) : node.text ?? ''
  }
}

const list = (node: AdfNode, ordered: boolean, depth: number): string =>
  (node.content ?? [])
    .map((item, index) => {
      const marker = ordered ? `${index + 1}.` : '-'
      // A nested list indents its own lines, one level deeper.
      const body = blocks(item.content, depth + 1)
      return `${'  '.repeat(depth)}${marker} ${body}`
    })
    .join('\n')

const block = (node: AdfNode, depth: number): string => {
  switch (node.type) {
    case 'paragraph':
      return inline(node.content)
    case 'heading': {
      const level = Math.min(Math.max(Number(node.attrs?.level ?? 2), 1), 6)
      return `${'#'.repeat(level)} ${inline(node.content)}`
    }
    case 'bulletList':
      return list(node, false, depth)
    case 'orderedList':
      return list(node, true, depth)
    case 'codeBlock':
      return `\`\`\`${String(node.attrs?.language ?? '')}\n${inline(node.content)}\n\`\`\``
    case 'blockquote':
      return blocks(node.content, depth)
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n')
    case 'rule':
      return '---'
    case 'media':
    case 'mediaSingle':
    case 'mediaGroup':
      return ''
    default:
      return node.content ? blocks(node.content, depth) : inlineNode(node)
  }
}

const blocks = (nodes: AdfNode[] | undefined, depth = 0): string =>
  (nodes ?? [])
    .map((node) => block(node, depth))
    .filter((text) => text.length > 0)
    .join(depth > 0 ? '\n' : '\n\n')

/** A comment body as Markdown. A plain string (API v2) passes through. */
export const adfToMarkdown = (value: unknown): string => {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return ''
  const node = value as AdfNode
  return (node.type === 'doc' ? blocks(node.content) : block(node, 0)).trim()
}

/**
 * Markdown into the smallest ADF Jira accepts: paragraphs, line breaks inside
 * them, and fenced code. Inline Markdown stays literal text — Jira shows what
 * the person typed rather than a guess at what they meant.
 */
export const markdownToAdf = (markdown: string): Record<string, unknown> => {
  const content: Record<string, unknown>[] = []
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  let paragraph: string[] = []
  const flush = () => {
    if (paragraph.length === 0) return
    const parts: Record<string, unknown>[] = []
    paragraph.forEach((line, index) => {
      if (index > 0) parts.push({ type: 'hardBreak' })
      if (line) parts.push({ type: 'text', text: line })
    })
    content.push({ type: 'paragraph', content: parts })
    paragraph = []
  }
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string
    const fence = /^```(\S*)\s*$/.exec(line)
    if (fence) {
      flush()
      const code: string[] = []
      i += 1
      while (i < lines.length && !/^```\s*$/.test(lines[i] as string)) {
        code.push(lines[i] as string)
        i += 1
      }
      content.push({
        type: 'codeBlock',
        ...(fence[1] ? { attrs: { language: fence[1] } } : {}),
        content: code.length > 0 ? [{ type: 'text', text: code.join('\n') }] : [],
      })
      continue
    }
    if (line.trim() === '') flush()
    else paragraph.push(line)
  }
  flush()
  return { type: 'doc', version: 1, content }
}
