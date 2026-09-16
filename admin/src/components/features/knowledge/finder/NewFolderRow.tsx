import { useEffect, useRef, useState } from 'react'
import { faFolder } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { Input } from '../../../shared/FormControls'

/**
 * Finder's inline "new folder" row: a folder glyph and an auto-focused name
 * field, in the column the folder will be created in. Enter creates, Escape
 * cancels, and blurring submits a typed name (or cancels when empty). A guard
 * makes submit/cancel fire at most once.
 *
 * Moved here from `KnowledgeFilesystemRows.tsx` with its behaviour intact; the
 * only change is the row height, which is the Finder's 44px.
 */
export const NewFolderRow = ({
  onCancel,
  onSubmit,
  pending,
}: {
  onCancel: () => void
  onSubmit: (name: string) => void
  pending: boolean
}) => {
  const [name, setName] = useState('')
  const doneRef = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // Not `autoFocus`: the browser's own initial focus scrolls whatever box it
  // lands in, which is the sideways bounce docs/navigation/overview.md §2 names.
  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true })
  }, [])

  const finish = (action: () => void) => {
    if (doneRef.current) return
    doneRef.current = true
    action()
  }
  const submit = () => {
    const trimmed = name.trim()
    finish(() => (trimmed ? onSubmit(trimmed) : onCancel()))
  }

  return (
    <div className="flex min-h-11 items-center gap-2.5 px-3" data-finder-new-folder>
      <FontAwesomeIcon
        className="h-4 w-4 flex-shrink-0 text-[color:var(--accent)]"
        fixedWidth
        icon={faFolder}
      />
      <Input
        aria-label="Folder name"
        className="min-w-0 flex-1"
        disabled={pending}
        onBlur={submit}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            submit()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            finish(onCancel)
          }
        }}
        placeholder="Folder name"
        ref={inputRef}
        size="compact"
        value={name}
      />
    </div>
  )
}
