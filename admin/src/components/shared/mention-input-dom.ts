import type { MentionEntity } from './MentionInput'

/* ------------------------------------------------------------------ */
/*  Pure DOM/Range helpers for the mention-input contentEditable      */
/*  controller. No hooks, no component state — everything here reads  */
/*  and writes only the `Node`/`Range`/`Selection` it is handed.       */
/* ------------------------------------------------------------------ */

export function clearChildren(el: HTMLElement): void {
  while (el.firstChild) {
    el.removeChild(el.firstChild)
  }
}

function getLastTextNode(node: Node): Text | null {
  if (node.nodeType === Node.TEXT_NODE) {
    return node as Text
  }

  for (let i = node.childNodes.length - 1; i >= 0; i -= 1) {
    const child = node.childNodes[i]
    if (!child) continue
    const textNode = getLastTextNode(child)
    if (textNode) return textNode
  }

  return null
}

function getSelectionTextNode(
  editor: HTMLElement,
  node: Node,
  offset: number,
): { node: Text; offset: number } | null {
  if (node.nodeType === Node.TEXT_NODE) {
    return { node: node as Text, offset }
  }

  if (node.nodeType !== Node.ELEMENT_NODE) return null
  if (!editor.contains(node)) return null

  const element = node as HTMLElement
  const before = element.childNodes[offset - 1]
  const beforeText = before ? getLastTextNode(before) : null
  if (beforeText) {
    return { node: beforeText, offset: beforeText.textContent?.length ?? 0 }
  }

  const onlyChild = offset === 0 && element === editor && element.childNodes.length === 1
    ? element.childNodes[0]
    : null
  const onlyText = onlyChild ? getLastTextNode(onlyChild) : null
  if (onlyText) {
    return { node: onlyText, offset: onlyText.textContent?.length ?? 0 }
  }

  return null
}

export function getMentionContext(
  editor: HTMLElement,
): { query: string; range: Range; trigger: '@' | '#' } | null {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null

  const { startContainer: node, startOffset: offset } = sel.getRangeAt(0)
  const textSelection = getSelectionTextNode(editor, node, offset)
  if (!textSelection) return null

  const text = (textSelection.node.textContent ?? '').slice(0, textSelection.offset)
  const match = text.match(/(^|[\s\u00A0([{])([@#])([^\s\u00A0]*)$/)
  if (!match) return null

  const trigger = match[2] === '#' ? '#' : '@'
  const query = match[3] ?? ''
  const atPos = textSelection.offset - query.length - 1

  const range = document.createRange()
  range.setStart(textSelection.node, atPos)
  range.setEnd(textSelection.node, textSelection.offset)
  return { query, range, trigger }
}

export function matchesEntityQuery(entity: MentionEntity, query: string): boolean {
  return `${entity.name} ${entity.insertName ?? ''} ${entity.detail ?? ''}`
    .toLowerCase()
    .includes(query.toLowerCase())
}
