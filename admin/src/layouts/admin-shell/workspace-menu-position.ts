const MENU_GUTTER = 8
const MENU_GAP = 8
const MENU_WIDTH = 260

export type WorkspaceMenuPosition = {
  left: number
  top: number
  maxHeight: number
}

export const resolveWorkspaceMenuPosition = (
  anchor: Pick<DOMRect, 'right' | 'top'>,
  viewport: { width: number; height: number },
): WorkspaceMenuPosition => {
  const maxLeft = Math.max(MENU_GUTTER, viewport.width - MENU_WIDTH - MENU_GUTTER)
  const left = Math.max(MENU_GUTTER, Math.min(anchor.right + MENU_GAP, maxLeft))
  const top = Math.max(MENU_GUTTER, Math.min(anchor.top, viewport.height - MENU_GUTTER))
  const availableHeight = Math.max(0, viewport.height - top - MENU_GUTTER)

  return {
    left,
    top,
    maxHeight: Math.min(viewport.height * 0.7, availableHeight),
  }
}
