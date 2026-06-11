import { useState } from 'react'
import type { KnowledgeSpaceRecord } from '../../../facades/knowledge/hooks'

type SpaceSwitcherProps = {
  creating?: boolean
  onCreateSpace: (name: string) => Promise<void> | void
  onSelect: (spaceId: string) => void
  selectedSpace: KnowledgeSpaceRecord | null
  spaces: KnowledgeSpaceRecord[]
}

export const SpaceSwitcher = ({
  creating,
  onCreateSpace,
  onSelect,
  selectedSpace,
  spaces,
}: SpaceSwitcherProps) => {
  const [open, setOpen] = useState(false)
  const [addingSpace, setAddingSpace] = useState(false)
  const [name, setName] = useState('')

  const submit = async () => {
    if (!name.trim()) return
    await onCreateSpace(name.trim())
    setName('')
    setAddingSpace(false)
    setOpen(false)
  }

  return (
    <div className="relative px-2 pt-2">
      <button
        className={[
          'flex w-full items-center justify-between gap-2 rounded-md border px-3 py-2 text-left',
          'border-[color:var(--sep)] bg-[color:var(--main)] hover:bg-[var(--overlay-weak)]',
        ].join(' ')}
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <span className="min-w-0 truncate text-sm font-semibold text-[color:var(--tx)]">
          {selectedSpace?.name ?? 'Select a space'}
        </span>
        <svg
          className={[
            'h-4 w-4 flex-shrink-0 text-[color:var(--tx3)] transition-transform',
            open ? 'rotate-180' : '',
          ].join(' ')}
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          viewBox="0 0 24 24"
        >
          <path d="M19 9l-7 7-7-7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open ? (
        <div
          className={[
            'absolute left-2 right-2 z-20 mt-1 rounded-md border p-1 shadow-lg',
            'border-[color:var(--sep)] bg-[color:var(--sb)]',
          ].join(' ')}
        >
          {spaces.map((space) => (
            <button
              className={[
                'flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm',
                space.id === selectedSpace?.id
                  ? 'bg-[color:var(--accent)] text-[var(--on-accent)]'
                  : 'text-[color:var(--tx2)] hover:bg-[var(--overlay-weak)] hover:text-[var(--tx)]',
              ].join(' ')}
              key={space.id}
              onClick={() => {
                onSelect(space.id)
                setOpen(false)
              }}
              type="button"
            >
              <span className="min-w-0 truncate">{space.name}</span>
              <span className="text-[10px] uppercase tracking-[0.14em] opacity-70">
                {space.visibility}
              </span>
            </button>
          ))}
          {spaces.length === 0 ? (
            <div className="px-2 py-2 text-xs text-[color:var(--tx3)]">No spaces yet</div>
          ) : null}

          <div className="my-1 border-t border-[color:var(--sep)]" />

          {addingSpace ? (
            <div className="flex gap-1 p-1">
              <input
                autoFocus
                className="admin-input min-w-0 flex-1"
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void submit()
                }}
                placeholder="Space name"
                value={name}
              />
              <button
                className="admin-button admin-button-secondary"
                disabled={creating}
                onClick={() => void submit()}
                type="button"
              >
                Add
              </button>
            </div>
          ) : (
            <button
              className={[
                'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm',
                'text-[color:var(--tx2)] hover:bg-[var(--overlay-weak)] hover:text-[var(--tx)]',
              ].join(' ')}
              onClick={() => setAddingSpace(true)}
              type="button"
            >
              <span className="text-base leading-none">+</span> New space
            </button>
          )}
        </div>
      ) : null}
    </div>
  )
}
