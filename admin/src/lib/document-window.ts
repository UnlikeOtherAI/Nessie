import { invoke } from '@tauri-apps/api/core'
import { isDesktopApp } from './desktop'
import { getDesktopLanguage } from './desktop-language'

/**
 * A document in a window of its own — the desktop shell's answer to the
 * double-tap the Finder gives back there (browser-ui.md §7).
 *
 * The route is a real admin route, not a shell-only address: the window is an
 * ordinary webview loading `/documents/<spaceId>/<pageId>` on the same origin
 * the main window is already signed in to, which is why it arrives
 * authenticated and why the same URL opens in a browser tab for anyone
 * debugging it.
 */
export const documentWindowPath = (spaceId: string, pageId: string): string =>
  `/documents/${encodeURIComponent(spaceId)}/${encodeURIComponent(pageId)}`

/**
 * Whether opening a document means a second window rather than the pane beside
 * the browser. The desktop shell is the whole condition: a browser tab and the
 * mobile WebView have no window to make, and both keep one-tap open.
 */
export const opensDocumentsInTheirOwnWindow = (): boolean => isDesktopApp()

/**
 * Ask the shell for the window. It answers `false` rather than throwing when
 * there is no shell to ask, when the shell predates the command, or when it
 * refuses the ids — every caller falls back to opening the document in place,
 * because a double-tap that does nothing at all is the one outcome worse than
 * opening it the old way.
 */
export const openDocumentWindow = async (input: {
  pageId: string
  spaceId: string
  title: string
}): Promise<boolean> => {
  if (!isDesktopApp()) return false
  try {
    await invoke('desktop_open_document_window', {
      pageId: input.pageId,
      spaceId: input.spaceId,
      title: input.title,
      language: getDesktopLanguage(),
    })
    return true
  } catch {
    return false
  }
}
