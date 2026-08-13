import { useMemo, useState } from 'react'
import type { DocumentStreamTarget } from '@nessie/schemas'
import {
  useKnowledgePages,
  useKnowledgeSpaces,
  type KnowledgePageRecord,
} from '../../../facades/knowledge/hooks'
import {
  isFolderPage,
  sortFilesystemPages,
} from '../knowledge/KnowledgeFilesystemRows'

type DocumentTargetBarProps = {
  disabled: boolean
  fileName: string
  onSelect: (input: { parentPageId: string | null; spaceId: string }) => void
  pending: boolean
  target: DocumentStreamTarget
}

/**
 * The address bar under a streaming document: the visible receipt of where the
 * file will land, and the control that changes it. Clicking it walks the same
 * spaces and folders the knowledge browser shows (through the same facade
 * queries — folders are `isFolderPage`, not a second definition), and picking
 * one re-aims the save before it happens or moves the page after it.
 */
export const DocumentTargetBar = ({
  disabled,
  fileName,
  onSelect,
  pending,
  target,
}: DocumentTargetBarProps) => {
  const [open, setOpen] = useState(false)
  const [browseSpaceId, setBrowseSpaceId] = useState<string | null>(null)
  const [browsePath, setBrowsePath] = useState<string[]>([])
  const spacesQuery = useKnowledgeSpaces()
  const pagesQuery = useKnowledgePages(browseSpaceId ?? undefined)
  const pages = useMemo(() => pagesQuery.data ?? [], [pagesQuery.data])

  const childrenOf = useMemo(() => {
    const byParent = new Map<string, KnowledgePageRecord[]>()
    for (const page of pages) {
      const key = page.parentPageId ?? ''
      const siblings = byParent.get(key)
      if (siblings) {
        siblings.push(page)
      } else {
        byParent.set(key, [page])
      }
    }
    return (parentPageId: string) => byParent.get(parentPageId) ?? []
  }, [pages])

  const currentParentId = browsePath.at(-1) ?? null
  const folders = useMemo(
    () =>
      sortFilesystemPages(
        pages.filter(
          (page) =>
            (page.parentPageId ?? null) === currentParentId &&
            isFolderPage(page, childrenOf),
        ),
        childrenOf,
      ),
    [childrenOf, currentParentId, pages],
  )
  const browseSpace = spacesQuery.data?.find((space) => space.id === browseSpaceId) ?? null
  const pathTitles = browsePath.map(
    (pageId) => pages.find((page) => page.id === pageId)?.title ?? '…',
  )

  const label = [
    target.spaceName ?? (target.spaceId ? 'Space' : 'Choose a location'),
    target.parentTitle ?? null,
    fileName,
  ]
    .filter((part): part is string => Boolean(part))
    .join(' › ')

  const choose = (spaceId: string, parentPageId: string | null) => {
    onSelect({ parentPageId, spaceId })
    setOpen(false)
  }

  return (
    <div className="relative min-w-0 flex-1">
      <button
        aria-expanded={open}
        aria-label="Change where this document is saved"
        className={[
          'flex w-full min-w-0 items-center gap-2 rounded-lg border border-[color:var(--sep)]',
          'bg-[var(--overlay-weak)] px-3 py-2 text-left text-xs text-[color:var(--tx2)]',
          'transition-colors hover:bg-[color:var(--main-hover)]',
          'disabled:cursor-not-allowed disabled:opacity-60',
        ].join(' ')}
        data-testid="document-target-bar"
        disabled={disabled || pending}
        onClick={() => {
          setBrowseSpaceId(target.spaceId ?? null)
          setBrowsePath([])
          setOpen((current) => !current)
        }}
        type="button"
      >
        <span aria-hidden="true">📁</span>
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="flex-shrink-0 text-[color:var(--tx3)]">
          {pending ? 'Moving…' : 'Change'}
        </span>
      </button>

      {open ? (
        <div
          className={[
            'absolute bottom-full left-0 z-10 mb-2 max-h-80 w-full overflow-y-auto rounded-lg',
            'border border-[color:var(--sep)] bg-[var(--panel)] p-2 shadow-2xl',
          ].join(' ')}
          data-testid="document-target-picker"
        >
          {browseSpaceId === null ? (
            <>
              <p className="px-2 py-1 text-[0.6875rem] uppercase text-[color:var(--tx3)]">
                Spaces
              </p>
              {(spacesQuery.data ?? []).map((space) => (
                <button
                  className="block w-full truncate rounded px-2 py-1.5 text-left text-xs text-[var(--tx)] hover:bg-[var(--overlay)]"
                  key={space.id}
                  onClick={() => {
                    setBrowseSpaceId(space.id)
                    setBrowsePath([])
                  }}
                  type="button"
                >
                  {space.name}
                </button>
              ))}
              {spacesQuery.data?.length === 0 ? (
                <p className="px-2 py-2 text-xs text-[color:var(--tx3)]">
                  No spaces you can write to.
                </p>
              ) : null}
            </>
          ) : (
            <>
              <div className="flex items-center gap-1 px-2 py-1 text-[0.6875rem] text-[color:var(--tx3)]">
                <button
                  className="hover:text-[var(--tx)]"
                  onClick={() => {
                    setBrowseSpaceId(null)
                    setBrowsePath([])
                  }}
                  type="button"
                >
                  Spaces
                </button>
                <span aria-hidden="true">›</span>
                <button
                  className="truncate hover:text-[var(--tx)]"
                  onClick={() => setBrowsePath([])}
                  type="button"
                >
                  {browseSpace?.name ?? 'Space'}
                </button>
                {pathTitles.map((title, index) => (
                  <span className="flex items-center gap-1" key={browsePath[index]}>
                    <span aria-hidden="true">›</span>
                    <button
                      className="truncate hover:text-[var(--tx)]"
                      onClick={() => setBrowsePath(browsePath.slice(0, index + 1))}
                      type="button"
                    >
                      {title}
                    </button>
                  </span>
                ))}
              </div>

              {folders.map((folder) => (
                <div className="flex items-center gap-1" key={folder.id}>
                  <button
                    className="min-w-0 flex-1 truncate rounded px-2 py-1.5 text-left text-xs text-[var(--tx)] hover:bg-[var(--overlay)]"
                    onClick={() => setBrowsePath([...browsePath, folder.id])}
                    type="button"
                  >
                    📁 {folder.title}
                  </button>
                  <button
                    className="flex-shrink-0 rounded px-2 py-1 text-[0.6875rem] text-[color:var(--tx3)] hover:bg-[var(--overlay)] hover:text-[var(--tx)]"
                    onClick={() => choose(browseSpaceId, folder.id)}
                    type="button"
                  >
                    Save here
                  </button>
                </div>
              ))}
              {folders.length === 0 && !pagesQuery.isLoading ? (
                <p className="px-2 py-2 text-xs text-[color:var(--tx3)]">
                  No folders here — the document saves at this level.
                </p>
              ) : null}

              <button
                className={[
                  'mt-1 block w-full rounded bg-[var(--accent-soft)] px-2 py-1.5 text-xs',
                  'font-semibold text-[var(--thinking)] hover:bg-[color:var(--main-hover)]',
                ].join(' ')}
                onClick={() => choose(browseSpaceId, currentParentId)}
                type="button"
              >
                Save in {pathTitles.at(-1) ?? browseSpace?.name ?? 'this space'}
              </button>
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}
