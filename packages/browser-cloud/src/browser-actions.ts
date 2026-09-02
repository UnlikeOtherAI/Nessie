import type { ExecutorBrowserActArguments } from '@nessie/schemas'

import type { CdpClient } from './cdp-client.js'
import { CLOUD_BROWSER_ERROR_CODES, CloudBrowserError } from './errors.js'

/**
 * The browser verbs, implemented against CDP with exactly the semantics the
 * executor's guest agent already uses (`executor/guest/browser_cdp.go`).
 *
 * This is the "one logical surface" rule made concrete: the model sends the
 * same closed grammar — navigate / click / type / press / scroll, addressed
 * only by an accessibility node id emitted from a prior observe — whether the
 * browser runs on the person's machine or in the cloud. Selectors, scripts and
 * pixel coordinates are never accepted from the model on either transport.
 */

/** Mirrors the executor's caps so an observation costs the same context. */
const MAX_AX_NODES = 200
const MAX_AX_TEXT_BYTES = 256

export type ObservedNode = {
  nodeId: number
  role: string
  name: string
  value: string
}

export type BrowserObservation = {
  url: string
  title: string
  nodes: ObservedNode[]
  /** Base64 PNG, only when asked for. */
  screenshotBase64?: string
  truncated: boolean
}

const boundedText = (value: unknown): string => {
  if (typeof value !== 'string' || value.length === 0) return ''
  const buffer = Buffer.from(value, 'utf8')
  if (buffer.length <= MAX_AX_TEXT_BYTES) return value
  // Slice on a byte budget, then drop a trailing partial code point.
  return buffer.subarray(0, MAX_AX_TEXT_BYTES).toString('utf8').replace(/�+$/u, '')
}

const readAxValue = (node: Record<string, unknown>, key: string): string => {
  const holder = node[key] as { value?: unknown } | undefined
  return boundedText(holder?.value)
}

const KEY_DETAILS: Record<string, { key: string; code: string; keyCode: number }> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  Space: { key: 'Space', code: ' ', keyCode: 32 },
}

const nodeCenter = async (
  cdp: CdpClient,
  backendNodeId: number,
): Promise<{ x: number; y: number }> => {
  const result = await cdp.call('DOM.getBoxModel', { backendNodeId })
  const content = (result.model as { content?: unknown } | undefined)?.content
  if (!Array.isArray(content) || content.length !== 8) {
    throw new CloudBrowserError(
      CLOUD_BROWSER_ERROR_CODES.COMMAND_FAILED,
      'That element has no layout box — it may be hidden or off-screen.',
    )
  }
  const numbers = content.map((value) => Number(value))
  return {
    x: ((numbers[0] ?? 0) + (numbers[2] ?? 0) + (numbers[4] ?? 0) + (numbers[6] ?? 0)) / 4,
    y: ((numbers[1] ?? 0) + (numbers[3] ?? 0) + (numbers[5] ?? 0) + (numbers[7] ?? 0)) / 4,
  }
}

const viewportCenter = async (cdp: CdpClient): Promise<{ x: number; y: number }> => {
  const metrics = await cdp.call('Page.getLayoutMetrics', {})
  const viewport = (metrics.cssLayoutViewport ?? metrics.layoutViewport) as
    { clientWidth?: unknown; clientHeight?: unknown } | undefined
  const width = Number(viewport?.clientWidth ?? 0)
  const height = Number(viewport?.clientHeight ?? 0)
  return { x: width / 2, y: height / 2 }
}

export const observeBrowser = async (
  cdp: CdpClient,
  input: { includeScreenshot?: boolean } = {},
): Promise<BrowserObservation> => {
  const [tree, history] = await Promise.all([
    cdp.call('Accessibility.getFullAXTree', {}),
    cdp.call('Page.getNavigationHistory', {}).catch(() => ({} as Record<string, unknown>)),
  ])

  const entries = Array.isArray(tree.nodes) ? tree.nodes : []
  const nodes: ObservedNode[] = []
  for (const entry of entries) {
    if (nodes.length === MAX_AX_NODES) break
    const node = entry as Record<string, unknown>
    const backendNodeId = node.backendDOMNodeId
    if (typeof backendNodeId !== 'number') continue
    const role = readAxValue(node, 'role')
    const name = readAxValue(node, 'name')
    const value = readAxValue(node, 'value')
    // A node with no role and nothing to read is noise in the model's window.
    if (!role && !name && !value) continue
    nodes.push({ nodeId: backendNodeId, role, name, value })
  }

  const historyEntries = Array.isArray(history.entries) ? history.entries : []
  const currentIndex = typeof history.currentIndex === 'number' ? history.currentIndex : -1
  const current = (historyEntries[currentIndex] ?? {}) as Record<string, unknown>

  const observation: BrowserObservation = {
    url: typeof current.url === 'string' ? current.url : '',
    title: typeof current.title === 'string' ? current.title : '',
    nodes,
    truncated: entries.length > nodes.length,
  }

  if (input.includeScreenshot) {
    const shot = await cdp.call('Page.captureScreenshot', { format: 'png' })
    if (typeof shot.data === 'string') observation.screenshotBase64 = shot.data
  }

  return observation
}

export type BrowserActResult = {
  status: 'acted'
  settledUrl?: string
}

export const actInBrowser = async (
  cdp: CdpClient,
  action: ExecutorBrowserActArguments,
): Promise<BrowserActResult> => {
  switch (action.action) {
    case 'navigate': {
      await cdp.call('Page.navigate', { url: action.url })
      return { status: 'acted', settledUrl: action.url }
    }
    case 'click': {
      await cdp.call('DOM.scrollIntoViewIfNeeded', { backendNodeId: action.nodeId })
      const { x, y } = await nodeCenter(cdp, action.nodeId)
      await cdp.call('Input.dispatchMouseEvent', {
        type: 'mousePressed', x, y, button: 'left', clickCount: 1,
      })
      await cdp.call('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x, y, button: 'left', clickCount: 1,
      })
      return { status: 'acted' }
    }
    case 'type': {
      await cdp.call('DOM.focus', { backendNodeId: action.nodeId })
      await cdp.call('Input.insertText', { text: action.text })
      return { status: 'acted' }
    }
    case 'press': {
      const details = KEY_DETAILS[action.key]
      if (!details) {
        throw new CloudBrowserError(
          CLOUD_BROWSER_ERROR_CODES.COMMAND_FAILED,
          `Unsupported key: ${action.key}`,
        )
      }
      const payload = {
        key: details.key,
        code: details.code,
        windowsVirtualKeyCode: details.keyCode,
      }
      await cdp.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...payload })
      await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', ...payload })
      return { status: 'acted' }
    }
    case 'scroll': {
      if (action.nodeId !== undefined) {
        await cdp.call('DOM.scrollIntoViewIfNeeded', { backendNodeId: action.nodeId })
      }
      const { x, y } = await viewportCenter(cdp)
      await cdp.call('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x, y, deltaX: 0, deltaY: action.deltaY,
      })
      return { status: 'acted' }
    }
    default: {
      // The schema is a closed discriminated union; this is unreachable and
      // exists so a new verb cannot be added without handling it here.
      const exhaustive: never = action
      throw new CloudBrowserError(
        CLOUD_BROWSER_ERROR_CODES.COMMAND_FAILED,
        `Unsupported browser action: ${JSON.stringify(exhaustive)}`,
      )
    }
  }
}

/**
 * The observation as the model reads it. Kept here so both transports can
 * render an observation the same way.
 */
export const renderObservation = (observation: BrowserObservation): string => {
  const lines = [
    `url: ${observation.url || '(blank)'}`,
    `title: ${observation.title || '(none)'}`,
    '',
    'elements (nodeId · role · name · value):',
    ...observation.nodes.map((node) => {
      const parts = [`${node.nodeId}`, node.role || '-', node.name || '-']
      if (node.value) parts.push(node.value)
      return `  ${parts.join(' · ')}`
    }),
  ]
  if (observation.truncated) {
    lines.push(`  … more elements omitted (showing the first ${MAX_AX_NODES}).`)
  }
  return lines.join('\n')
}

export const __testing = { boundedText, MAX_AX_NODES, MAX_AX_TEXT_BYTES }
