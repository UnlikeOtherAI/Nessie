import { useEffect, useRef, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core'
import { Input } from '../../../shared/FormControls'

/**
 * Renaming in place — the row itself, with a field where its name was
 * (menus-and-dialogs.md §2, "Rename `F2`").
 *
 * It is `NewFolderRow`'s behaviour on an existing name: Enter commits, Escape
 * reverts, a blur with a changed name commits, and a guard makes either fire
 * at most once. Two differences, both because the row already exists:
 *
 * - the field opens with the current name selected up to its extension, so
 *   typing replaces the name and not the `.pdf` — the Finder gesture people
 *   have in their fingers;
 * - committing the same name is a no-op rather than a PATCH, because a rename
 *   that changes nothing still burns a revision and can lose a race with
 *   somebody else's edit.
 *
 * It renders its own `<li>` because it stands *in* the list where the row was:
 * a `<div>` between `<li>`s is reparented by the browser, which moves it.
 */

/** Everything before the last dot, when there is a name in front of it. */
const stemLength = (title: string): number => {
  const dot = title.lastIndexOf('.')
  return dot > 0 ? dot : title.length
}

export type FinderRowRename = {
  /** Disables the field while the write is in flight. */
  pending?: boolean
  onCancel: () => void
  onSubmit: (title: string) => void
}

export const RenameRow = ({
  icon,
  iconTone = '--tx3',
  onCancel,
  onSubmit,
  pending = false,
  title,
}: FinderRowRename & { icon?: IconDefinition; iconTone?: string; title: string }) => {
  const [name, setName] = useState(title)
  const doneRef = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const input = inputRef.current
    if (!input) return
    // Not `autoFocus`: the browser's own initial focus scrolls whatever box it
    // lands in (docs/navigation/overview.md §2).
    input.focus({ preventScroll: true })
    input.setSelectionRange(0, stemLength(title))
  }, [title])

  const finish = (action: () => void) => {
    if (doneRef.current) return
    doneRef.current = true
    action()
  }
  const submit = () => {
    const trimmed = name.trim()
    finish(() => (trimmed && trimmed !== title ? onSubmit(trimmed) : onCancel()))
  }

  return (
    <li className="finder-row-item">
      <div className="finder-row flex w-full items-center gap-1.5 px-2" data-finder-rename={title}>
        {icon ? (
          <span className="finder-row-icon flex shrink-0 items-center">
            <FontAwesomeIcon
              className="h-3.5 w-3.5"
              fixedWidth
              icon={icon}
              style={{ color: `var(${iconTone})` }}
            />
          </span>
        ) : null}
        <Input
          aria-label="Name"
          className="min-w-0 flex-1"
          disabled={pending}
          onBlur={submit}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            // The column's key table is listening above this field; a rename
            // must not also walk the selection or open the row.
            event.stopPropagation()
            if (event.key === 'Enter') {
              event.preventDefault()
              submit()
            } else if (event.key === 'Escape') {
              event.preventDefault()
              finish(onCancel)
            }
          }}
          ref={inputRef}
          size="compact"
          value={name}
        />
      </div>
    </li>
  )
}
