// Spike D prototype of the overlay's touch range selection
// (admin-ui.md §"Phone and desktop").
//
// IronCalc's own `usePointer` returns early from `onPointerMove` for any
// pointer that is not a mouse, so a touch drag only ever scrolls. This hook
// adds the missing capability from outside the library: a long press enters
// selection mode, the drag that follows writes `setSelectedRange`, and two
// Sheets-style corner handles resize the range afterwards. A plain tap and a
// plain drag never reach this code, so IronCalc keeps its own behaviour.
import type { Model } from '@ironcalc/wasm'

// WorksheetCanvas.getCoordinatesByCell: the row header is 28px tall and the
// column header 30px wide (dist/ironcalc.js, `getCellByCoordinates`).
const HEADER_HEIGHT = 28
const HEADER_WIDTH = 30
const LONG_PRESS_MS = 350
const SLOP_PX = 10

export interface TouchSelectionOptions {
  model: Model
  redraw: () => void
  onModeChange?: (selecting: boolean) => void
}

const cellFromPoint = (model: Model, x: number, y: number): [number, number] => {
  const sheet = model.getSelectedSheet()
  const view = model.getSelectedView()
  let column = Math.max(view.left_column - 1, 0)
  let width = HEADER_WIDTH
  while (width <= x && column < 16384) { column += 1; width += model.getColumnWidth(sheet, column) }
  let row = Math.max(view.top_row - 1, 0)
  let height = HEADER_HEIGHT
  while (height <= y && row < 1048576) { row += 1; height += model.getRowHeight(sheet, row) }
  return [Math.max(row, 1), Math.max(column, 1)]
}

const cellOrigin = (model: Model, row: number, column: number): [number, number] => {
  const sheet = model.getSelectedSheet()
  const view = model.getSelectedView()
  let x = HEADER_WIDTH
  for (let c = view.left_column; c < column; c += 1) x += model.getColumnWidth(sheet, c)
  let y = HEADER_HEIGHT
  for (let r = view.top_row; r < row; r += 1) y += model.getRowHeight(sheet, r)
  return [x, y]
}

const handleElement = (): HTMLDivElement => {
  const node = document.createElement('div')
  node.className = 'spike-touch-handle'
  node.dataset.spikeTouchHandle = 'true'
  node.style.cssText = [
    'position:absolute', 'width:14px', 'height:14px', 'margin:-7px 0 0 -7px',
    'border-radius:50%', 'border:2px solid var(--palette-common-white, #fff)',
    'background:var(--palette-sheet-outline-color, #2563eb)',
    'z-index:900', 'pointer-events:auto', 'touch-action:none',
  ].join(';')
  return node
}

export const attachTouchSelection = (
  container: HTMLElement,
  options: TouchSelectionOptions,
): () => void => {
  const { model, redraw } = options
  const canvas = container.querySelector('canvas')
  if (!canvas) return () => {}
  const start = handleElement()
  const end = handleElement()
  container.append(start, end)

  let timer: ReturnType<typeof setTimeout> | undefined
  let selecting = false
  let anchor: [number, number] | undefined
  let origin: { x: number, y: number } | undefined
  let draggingHandle: 'end' | 'start' | undefined

  const point = (event: PointerEvent): [number, number] => {
    const rect = canvas.getBoundingClientRect()
    return [event.clientX - rect.left, event.clientY - rect.top]
  }

  const paintHandles = (): void => {
    const [r1, c1, r2, c2] = model.getSelectedView().range
    const [top, left] = [Math.min(r1, r2), Math.min(c1, c2)]
    const [bottom, right] = [Math.max(r1, r2), Math.max(c1, c2)]
    const sheet = model.getSelectedSheet()
    const [x1, y1] = cellOrigin(model, top, left)
    const [x2, y2] = cellOrigin(model, bottom, right)
    const visible = top !== bottom || left !== right
    for (const [node, x, y] of [
      [start, x1, y1],
      [end, x2 + model.getColumnWidth(sheet, right), y2 + model.getRowHeight(sheet, bottom)],
    ] as const) {
      node.style.display = visible ? 'block' : 'none'
      node.style.left = `${x}px`
      node.style.top = `${y}px`
    }
  }

  const setMode = (next: boolean): void => {
    if (selecting === next) return
    selecting = next
    // Suppressing the scroll must happen before the gesture commits. A long
    // press has not moved, so the wrapper has not started scrolling yet and
    // `touch-action: none` plus preventDefault still bind.
    container.style.touchAction = next ? 'none' : ''
    container.dataset.spikeSelecting = next ? 'true' : 'false'
    options.onModeChange?.(next)
  }

  const extendTo = (x: number, y: number): void => {
    if (!anchor) return
    const [row, column] = cellFromPoint(model, x, y)
    model.setSelectedRange(anchor[0], anchor[1], row, column)
    redraw()
    paintHandles()
  }

  const onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType !== 'touch') return
    const handle = (event.target as HTMLElement | null)?.dataset?.spikeTouchHandle
    if (handle) {
      const [r1, c1, r2, c2] = model.getSelectedView().range
      draggingHandle = event.target === start ? 'start' : 'end'
      anchor = draggingHandle === 'start' ? [Math.max(r1, r2), Math.max(c1, c2)] : [Math.min(r1, r2), Math.min(c1, c2)]
      setMode(true)
      ;(event.target as HTMLElement).setPointerCapture(event.pointerId)
      event.preventDefault()
      return
    }
    const [x, y] = point(event)
    origin = { x, y }
    timer = setTimeout(() => {
      anchor = cellFromPoint(model, x, y)
      setMode(true)
      model.setSelectedCell(anchor[0], anchor[1])
      redraw()
      paintHandles()
      container.setPointerCapture(event.pointerId)
    }, LONG_PRESS_MS)
  }

  const onPointerMove = (event: PointerEvent): void => {
    if (event.pointerType !== 'touch') return
    const [x, y] = point(event)
    if (!selecting) {
      if (origin && Math.hypot(x - origin.x, y - origin.y) > SLOP_PX) clearTimeout(timer)
      return
    }
    event.preventDefault()
    extendTo(x, y)
  }

  const onPointerUp = (): void => {
    clearTimeout(timer)
    origin = undefined
    draggingHandle = undefined
    if (selecting) { setMode(false); paintHandles() }
  }

  // A non-passive touchmove is the only thing Safari honours once a finger is
  // down; `touch-action` alone is read at gesture start.
  const onTouchMove = (event: TouchEvent): void => { if (selecting) event.preventDefault() }

  container.addEventListener('pointerdown', onPointerDown)
  container.addEventListener('pointermove', onPointerMove)
  container.addEventListener('pointerup', onPointerUp)
  container.addEventListener('pointercancel', onPointerUp)
  container.addEventListener('touchmove', onTouchMove, { passive: false })
  paintHandles()

  return () => {
    clearTimeout(timer)
    container.removeEventListener('pointerdown', onPointerDown)
    container.removeEventListener('pointermove', onPointerMove)
    container.removeEventListener('pointerup', onPointerUp)
    container.removeEventListener('pointercancel', onPointerUp)
    container.removeEventListener('touchmove', onTouchMove)
    start.remove()
    end.remove()
  }
}
