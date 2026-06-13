import { useState } from 'react'
import { faFolder } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { useZipEntries, useZipEntryText } from '../../../facades/knowledge/file-hooks'
import { iconForFilename } from './file-icons'

const formatBytes = (n: number): string => {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

const depthOf = (name: string): number => name.replace(/\/$/, '').split('/').length - 1
const leafName = (name: string): string => name.replace(/\/$/, '').split('/').pop() || name

const note = (text: string) => (
  <p className="py-12 text-center text-sm text-[color:var(--tx3)]">{text}</p>
)

type ZipContentsProps = { pageId: string; versionId: string }

// Browse a zip's entries (listed from its central directory, no server-side
// extraction). Text entries can be peeked inline.
export const ZipContents = ({ pageId, versionId }: ZipContentsProps) => {
  const listing = useZipEntries(pageId, versionId)
  const [openPath, setOpenPath] = useState<string | null>(null)
  const entryText = useZipEntryText(pageId, versionId, openPath)

  if (listing.isLoading) return note('Reading archive…')
  if (listing.isError || !listing.data) return note('Could not read this archive.')
  if (listing.data.tooLarge) {
    return note('This archive is too large to list inline — download it to inspect.')
  }

  const entries = [...listing.data.entries].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  const fileCount = entries.filter((entry) => !entry.isDirectory).length

  return (
    <div className="overflow-hidden rounded-lg border border-[color:var(--sep)]">
      <div className="border-b border-[color:var(--sep)] px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-[color:var(--tx3)]">
        {fileCount} {fileCount === 1 ? 'file' : 'files'} in archive
      </div>
      <ul className="max-h-[60vh] divide-y divide-[color:var(--sep)] overflow-auto">
        {entries.map((entry) => {
          const isOpen = openPath === entry.name
          return (
            <li key={entry.name}>
              <button
                className={[
                  'flex w-full items-center gap-2 py-1.5 pr-4 text-left text-sm',
                  entry.isText ? 'hover:bg-[color:var(--overlay-weak)]' : 'cursor-default',
                ].join(' ')}
                disabled={!entry.isText}
                onClick={() => entry.isText && setOpenPath(isOpen ? null : entry.name)}
                style={{ paddingLeft: `${16 + depthOf(entry.name) * 16}px` }}
                type="button"
              >
                <FontAwesomeIcon
                  className="h-3.5 w-3.5 shrink-0 text-[color:var(--tx3)]"
                  fixedWidth
                  icon={entry.isDirectory ? faFolder : iconForFilename(entry.name)}
                />
                <span className="min-w-0 flex-1 truncate text-[color:var(--tx)]">
                  {leafName(entry.name)}
                </span>
                {!entry.isDirectory ? (
                  <span className="shrink-0 text-xs text-[color:var(--tx3)]">{formatBytes(entry.size)}</span>
                ) : null}
              </button>
              {isOpen ? (
                <div className="px-4 pb-3">
                  {entryText.isLoading ? (
                    <p className="text-xs text-[color:var(--tx3)]">Loading…</p>
                  ) : entryText.isError || !entryText.data ? (
                    <p className="text-xs text-[color:var(--tx3)]">Preview unavailable.</p>
                  ) : (
                    <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border border-[color:var(--sep)] bg-[color:var(--sb)] p-3 font-mono text-xs leading-relaxed text-[color:var(--tx)]">
                      {entryText.data.text}
                      {entryText.data.truncated ? '\n\n…truncated.' : ''}
                    </pre>
                  )}
                </div>
              ) : null}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
