import { useCallback, useRef, useState } from 'react'
import type { DragEvent } from 'react'

const hasFiles = (event: DragEvent): boolean =>
  Array.from(event.dataTransfer?.types ?? []).includes('Files')

// Adapter for hosts that upload one file at a time (KB file nodes, page
// attachments, file versions): a multi-file drop keeps only the first entry.
export const firstFileOnly =
  (handle: (file: File) => void) =>
  (files: File[]): void => {
    const [file] = files
    if (file) handle(file)
  }

// Native HTML5 file drag-and-drop state for a host element. Tracks a nesting
// depth so child elements don't flicker the overlay, and forwards every dropped
// file — single-file hosts take the first entry.
export const useFileDrop = (onDropFiles: (files: File[]) => void, disabled = false) => {
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
      const files = Array.from(event.dataTransfer?.files ?? [])
      if (files.length > 0) onDropFiles(files)
    },
    [disabled, onDropFiles],
  )

  return {
    isDragging,
    dropHandlers: { onDragEnter, onDragOver, onDragLeave, onDrop },
  }
}
