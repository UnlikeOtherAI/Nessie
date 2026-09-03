export type WindowLayout =
  | 'bottom-half'
  | 'fill'
  | 'left-half'
  | 'left-third'
  | 'middle-third'
  | 'right-half'
  | 'right-third'
  | 'top-half'

export type WindowWorkArea = {
  height: number
  width: number
  x: number
  y: number
}

export type WindowLayoutBounds = {
  height: number
  width: number
  x: number
  y: number
}

export type WindowLayoutOption = {
  label: string
  layout: WindowLayout
}

export const windowLayoutSections: ReadonlyArray<{
  label: string
  options: ReadonlyArray<WindowLayoutOption>
}> = [
  {
    label: 'Move & resize',
    options: [
      { label: 'Left half', layout: 'left-half' },
      { label: 'Right half', layout: 'right-half' },
      { label: 'Top half', layout: 'top-half' },
      { label: 'Bottom half', layout: 'bottom-half' },
    ],
  },
  {
    label: 'Fill & arrange',
    options: [
      { label: 'Fill screen', layout: 'fill' },
      { label: 'Left third', layout: 'left-third' },
      { label: 'Middle third', layout: 'middle-third' },
      { label: 'Right third', layout: 'right-third' },
    ],
  },
]

// Tauri exposes monitor work areas in physical pixels. Keeping the sizing
// calculation independent from its native bridge makes every preset exact on
// mixed-DPI Windows and Linux displays as well as straightforward to test.
export const windowLayoutBounds = (
  layout: WindowLayout,
  workArea: WindowWorkArea,
): WindowLayoutBounds => {
  const halfWidth = Math.floor(workArea.width / 2)
  const halfHeight = Math.floor(workArea.height / 2)
  const thirdWidth = Math.floor(workArea.width / 3)

  switch (layout) {
    case 'left-half':
      return { height: workArea.height, width: halfWidth, x: workArea.x, y: workArea.y }
    case 'right-half':
      return {
        height: workArea.height,
        width: workArea.width - halfWidth,
        x: workArea.x + halfWidth,
        y: workArea.y,
      }
    case 'top-half':
      return { height: halfHeight, width: workArea.width, x: workArea.x, y: workArea.y }
    case 'bottom-half':
      return {
        height: workArea.height - halfHeight,
        width: workArea.width,
        x: workArea.x,
        y: workArea.y + halfHeight,
      }
    case 'left-third':
      return { height: workArea.height, width: thirdWidth, x: workArea.x, y: workArea.y }
    case 'middle-third':
      return {
        height: workArea.height,
        width: thirdWidth,
        x: workArea.x + thirdWidth,
        y: workArea.y,
      }
    case 'right-third':
      return {
        height: workArea.height,
        width: workArea.width - (thirdWidth * 2),
        x: workArea.x + (thirdWidth * 2),
        y: workArea.y,
      }
    case 'fill':
      return { height: workArea.height, width: workArea.width, x: workArea.x, y: workArea.y }
  }
}
