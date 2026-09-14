import { connectCdp, loadSessionCapability, type CdpClient } from '@nessie/browser-cloud'

import type { HumanBrowserInput } from '../contracts/browser-cloud.js'
import type { RouteDeps } from './types.js'

const LIVE_SESSION_TIMEOUT_MS = 10_000

/**
 * Attaches to a browser through its sealed capability for one API operation.
 *
 * No connect or provider URL crosses this boundary. The capability is read
 * only inside the API and the CDP socket closes even if a timeout wins.
 */
export const withLiveBrowserSession = async <T>(
  prisma: RouteDeps['prisma'],
  input: { encryptionSecret: import('@nessie/runtime').EncryptionKeyRingInput; sessionId: string },
  drive: (cdp: CdpClient) => Promise<T>,
): Promise<T | null> => {
  let abandoned = false
  let cdp: CdpClient | null = null
  let timeoutHandle: NodeJS.Timeout | null = null
  const closeWhenIdle = (): void => {
    cdp?.close()
    cdp = null
  }
  try {
    const capability = await loadSessionCapability(prisma, {
      encryptionSecret: input.encryptionSecret,
      sessionId: input.sessionId,
    })
    if (!capability) return null
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error('timed out')), LIVE_SESSION_TIMEOUT_MS)
      timeoutHandle.unref?.()
    })
    return await Promise.race([
      (async () => {
        const client = await connectCdp(capability.connectUrl)
        if (abandoned) {
          client.close()
          throw new Error('abandoned')
        }
        cdp = client
        await client.attachToPage()
        if (abandoned) throw new Error('abandoned')
        return drive(client)
      })().finally(closeWhenIdle),
      timeout,
    ])
  } catch {
    return null
  } finally {
    abandoned = true
    if (timeoutHandle) clearTimeout(timeoutHandle)
    closeWhenIdle()
  }
}

export const captureLiveBrowserScreenshot = async (
  prisma: RouteDeps['prisma'],
  input: { encryptionSecret: import('@nessie/runtime').EncryptionKeyRingInput; sessionId: string },
): Promise<string | null> => withLiveBrowserSession(prisma, input, async (cdp) => {
  const screenshot = await cdp.call('Page.captureScreenshot', {
    format: 'png',
    optimizeForSpeed: true,
  })
  return typeof screenshot.data === 'string' ? `data:image/png;base64,${screenshot.data}` : null
})

type HumanBrowserKey = Extract<HumanBrowserInput, { type: 'key' }>['key']

const HUMAN_KEY_DETAILS: Record<HumanBrowserKey, { code: string; key: string; keyCode: number }> = {
  Alt: { code: 'AltLeft', key: 'Alt', keyCode: 18 },
  ArrowDown: { code: 'ArrowDown', key: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', key: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', key: 'ArrowRight', keyCode: 39 },
  ArrowUp: { code: 'ArrowUp', key: 'ArrowUp', keyCode: 38 },
  Backspace: { code: 'Backspace', key: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', key: 'Delete', keyCode: 46 },
  End: { code: 'End', key: 'End', keyCode: 35 },
  Enter: { code: 'Enter', key: 'Enter', keyCode: 13 },
  Escape: { code: 'Escape', key: 'Escape', keyCode: 27 },
  Home: { code: 'Home', key: 'Home', keyCode: 36 },
  PageDown: { code: 'PageDown', key: 'PageDown', keyCode: 34 },
  PageUp: { code: 'PageUp', key: 'PageUp', keyCode: 33 },
  Space: { code: 'Space', key: ' ', keyCode: 32 },
  Tab: { code: 'Tab', key: 'Tab', keyCode: 9 },
}

/** Dispatches a validated person gesture. Values are never stored or logged. */
export const dispatchHumanBrowserInput = async (
  cdp: CdpClient,
  input: HumanBrowserInput,
): Promise<void> => {
  switch (input.type) {
    case 'navigate':
      await cdp.call('Page.navigate', { url: input.url })
      return
    case 'reload':
      await cdp.call('Page.reload')
      return
    case 'switch_tab':
      await cdp.activatePage(input.targetId)
      return
    case 'back':
    case 'forward': {
      const history = await cdp.call('Page.getNavigationHistory')
      const currentIndex = history.currentIndex
      const entries = history.entries
      if (!Array.isArray(entries) || typeof currentIndex !== 'number') return
      const nextIndex = input.type === 'back' ? currentIndex - 1 : currentIndex + 1
      const entry = entries[nextIndex] as Record<string, unknown> | undefined
      if (typeof entry?.id !== 'number') return
      await cdp.call('Page.navigateToHistoryEntry', { entryId: entry.id })
      return
    }
    case 'click':
      await cdp.call('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: input.x, y: input.y, button: 'left', clickCount: 1,
      })
      await cdp.call('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: input.x, y: input.y, button: 'left', clickCount: 1,
      })
      return
    case 'scroll':
      await cdp.call('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: input.x, y: input.y, deltaX: input.deltaX, deltaY: input.deltaY,
      })
      return
    case 'text':
      await cdp.call('Input.insertText', { text: input.text })
      return
    case 'key': {
      const key = HUMAN_KEY_DETAILS[input.key]
      await cdp.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key })
      await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
      return
    }
  }
}
