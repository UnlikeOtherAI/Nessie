import { useCallback, useRef, useState } from 'react'
import type { DragEvent } from 'react'

const hasFiles = (event: DragEvent): boolean =>
  Array.from(event.dataTransfer?.types ?? []).includes('Files')

// Native HTML5 file drag-and-drop state for a host element. Tracks a nesting
// depth so child elements don't flicker the overlay, and only the first dropped
// file is forwarded (single-file uploads).
export const useFileDrop = (onDropFile: (file: File) => void, disabled = false) => {
  const [isDragging, setIsDragging] = useState(false)
  const depth = useRef(0)

  const onDragEnter = useCallback(
    (event: DragEvent) => {
      if (disabled || !hasFiles(event)) return
      event.preventDefault()
      depth.current += 1
      setIsDragging(true)
    },
    [disabled],
  )

  const onDragOver = useCallback(
    (event: DragEvent) => {
      if (disabled || !hasFiles(event)) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
    },
    [disabled],
  )

  const onDragLeave = useCallback(() => {
    if (disabled) return
    depth.current -= 1
    if (depth.current <= 0) {
      depth.current = 0
      setIsDragging(false)
    }
  }, [disabled])

  const onDrop = useCallback(
    (event: DragEvent) => {
      if (disabled) return
      event.preventDefault()
      depth.current = 0
      setIsDragging(false)
      const file = event.dataTransfer?.files?.[0]
      if (file) onDropFile(file)
    },
    [disabled, onDropFile],
  )

  return {
    isDragging,
    dropHandlers: { onDragEnter, onDragOver, onDragLeave, onDrop },
  }
}
