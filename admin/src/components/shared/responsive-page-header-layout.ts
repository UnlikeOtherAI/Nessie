export type PageHeaderActionLayout = {
  id: string
  primary?: boolean
  priority: number
  width: number
}

type PageHeaderActionPartition = {
  overflowIds: string[]
  visibleIds: string[]
}

const actionRowWidth = (
  actions: PageHeaderActionLayout[],
  gap: number,
  moreWidth: number,
  includesOverflow: boolean,
): number => {
  const actionWidth = actions.reduce((total, action) => total + action.width, 0)
  const itemCount = actions.length + (includesOverflow ? 1 : 0)
  return actionWidth + (includesOverflow ? moreWidth : 0) + Math.max(0, itemCount - 1) * gap
}

// Keep the highest-priority actions visible, then add the overflow trigger to
// the same width budget. This stays separate from the React component so every
// header gets the exact same responsive policy and it can be tested without a
// DOM layout engine.
export const partitionPageHeaderActions = (
  actions: PageHeaderActionLayout[],
  availableWidth: number,
  moreWidth: number,
  gap = 8,
): PageHeaderActionPartition => {
  const visible = [...actions]
  const overflow = new Set<string>()

  while (actionRowWidth(visible, gap, moreWidth, overflow.size > 0) > availableWidth) {
    const next = visible
      .filter((action) => !action.primary)
      .sort((left, right) => left.priority - right.priority)[0]
    if (!next) break
    overflow.add(next.id)
    visible.splice(visible.findIndex((action) => action.id === next.id), 1)
  }

  return {
    visibleIds: actions.filter((action) => !overflow.has(action.id)).map((action) => action.id),
    overflowIds: actions.filter((action) => overflow.has(action.id)).map((action) => action.id),
  }
}
