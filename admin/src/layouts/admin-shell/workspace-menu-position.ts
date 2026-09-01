const MENU_GUTTER = 8
const MENU_GAP = 8
const MENU_WIDTH = 260 * 1.5
const MENU_MAX_VIEWPORT_WIDTH_RATIO = 0.8

export type WorkspaceMenuPosition = {
  left: number
  top: number
  maxHeight: number
  width: number
}

export const resolveWorkspaceMenuPosition = (
  anchor: Pick<DOMRect, 'right' | 'top'>,
  viewport: { width: number; height: number },
): WorkspaceMenuPosition => {
  const width = Math.min(MENU_WIDTH, viewport.width * MENU_MAX_VIEWPORT_WIDTH_RATIO)
  const maxLeft = Math.max(MENU_GUTTER, viewport.width - width - MENU_GUTTER)
  const left = Math.max(MENU_GUTTER, Math.min(anchor.right + MENU_GAP, maxLeft))
  const top = Math.max(MENU_GUTTER, Math.min(anchor.top, viewport.height - MENU_GUTTER))
  const availableHeight = Math.max(0, viewport.height - top - MENU_GUTTER)

  return {
    left,
    top,
    maxHeight: Math.min(viewport.height * 0.7, availableHeight),
    width,
  }
}
