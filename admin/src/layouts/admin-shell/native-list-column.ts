import { useEffect, type RefObject } from 'react'
import { isReactNativeWebView } from '../../lib/native-shell'
import {
  nativeChromeSuspended,
  subscribeNativeChromeSuspended,
} from '../../navigation/full-bleed-layers'
import type { SidebarSection } from './ResizableSidebar'

type RnWindow = Window & {
  ReactNativeWebView?: { postMessage: (data: string) => void }
}

export const LIST_COLUMN_MESSAGE_TYPE = 'nessie:list-column'

/**
 * Where the pinned secondary navigation column stands, and which section it
 * belongs to. `left`/`right` are viewport coordinates, which inside the native
 * WebView are the shell's own points, so the shell can place native chrome
 * over the column without a second copy of its width.
 *
 * A `section` of null says there is no pinned column at all — a phone stack,
 * or a route that has none — and retires whatever the shell drew over it.
 */
export type ListColumnMessage = {
  left: number
  right: number
  section: SidebarSection | null
}

// Sub-pixel jitter from a percentage width is not a move worth a message.
const samePosition = (left: ListColumnMessage | null, right: ListColumnMessage): boolean =>
  left !== null
  && left.section === right.section
  && Math.round(left.left) === Math.round(right.left)
  && Math.round(left.right) === Math.round(right.right)

export const describeListColumn = (
  section: SidebarSection,
  rect: { left: number, right: number },
): ListColumnMessage => ({
  left: Math.round(rect.left),
  right: Math.round(rect.right),
  section,
})

export const RETIRED_LIST_COLUMN: ListColumnMessage = { left: 0, right: 0, section: null }

const post = (message: ListColumnMessage): void => {
  ;(window as RnWindow).ReactNativeWebView?.postMessage(
    JSON.stringify({ ...message, type: LIST_COLUMN_MESSAGE_TYPE }),
  )
}

/**
 * Report the column's geometry to the native shell for as long as it is
 * mounted, and retire it on the way out. The column is resizable and its width
 * is a per-section preference, so the shell cannot derive any of this: only the
 * document knows where the column ended up.
 */
export const useNativeListColumnBridge = (
  columnRef: RefObject<HTMLElement | null>,
  section: SidebarSection,
): void => {
  useEffect(() => {
    const column = columnRef.current
    if (!isReactNativeWebView() || !column) return undefined

    let posted: ListColumnMessage | null = null
    const report = (): void => {
      // A full-bleed layer hides the column without unmounting it. Reporting
      // its geometry anyway left the shell drawing the creation control over
      // the top of a full-screen browser — a `+` for a list nobody could see.
      const next = nativeChromeSuspended()
        ? RETIRED_LIST_COLUMN
        : describeListColumn(section, column.getBoundingClientRect())
      if (samePosition(posted, next)) return
      posted = next
      post(next)
    }
    report()
    const observer = new ResizeObserver(report)
    observer.observe(column)
    window.addEventListener('resize', report)
    const unsubscribe = subscribeNativeChromeSuspended(report)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', report)
      unsubscribe()
      post(RETIRED_LIST_COLUMN)
    }
  }, [columnRef, section])
}
