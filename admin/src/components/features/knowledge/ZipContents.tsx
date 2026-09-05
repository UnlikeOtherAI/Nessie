import { Fragment, useState } from 'react'
import { faFolder } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { useZipEntries, useZipEntryText } from '../../../facades/knowledge/file-hooks'
import { SectionLabel } from '../../primitives/SectionLabel'
import { QueryState } from '../../shared/QueryState'
import { Row, RowList } from '../../shared/RowList'
import { iconForFilename } from '../../shared/file-icons'

const formatBytes = (n: number): string => {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

const depthOf = (name: string): number => name.replace(/\/$/, '').split('/').length - 1
const leafName = (name: string): string => name.replace(/\/$/, '').split('/').pop() || name

type ZipContentsProps = { pageId: string; versionId: string }

// Browse a zip's entries (listed from its central directory, no server-side
// extraction). Text entries can be peeked inline.
export const ZipContents = ({ pageId, versionId }: ZipContentsProps) => {
  const listing = useZipEntries(pageId, versionId)
  const [openPath, setOpenPath] = useState<string | null>(null)
  const entryText = useZipEntryText(pageId, versionId, openPath)

  return (
    <div className="overflow-hidden rounded-lg border border-[color:var(--sep)]">
      <QueryState
        className="py-12"
        emptyLabel={listing.data?.tooLarge
          ? 'This archive is too large to list inline — download it to inspect.'
          : undefined}
        errorLabel="Could not read this archive."
        isEmpty={Boolean(listing.data?.tooLarge)}
        loadingLabel="Reading archive…"
        query={{
          isError: listing.isError || (!listing.isLoading && !listing.data),
          isLoading: listing.isLoading,
          refetch: listing.refetch,
        }}
      >
        {() => {
          // QueryState only calls this once `isError` is false, and `isError`
          // above already covers "not loading and no data" — so this is
          // unreachable in practice, but `data` still needs narrowing here.
          if (!listing.data) return null
          const entries = [...listing.data.entries].sort((a, b) => {
            if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
            return a.name.localeCompare(b.name)
          })
          const fileCount = entries.filter((entry) => !entry.isDirectory).length

          return (
            <>
              <div className="border-b border-[color:var(--sep)] px-4 py-2">
                <SectionLabel size="2xs">
                  {fileCount} {fileCount === 1 ? 'file' : 'files'} in archive
                </SectionLabel>
              </div>
              <div className="max-h-[60vh] overflow-auto">
                <RowList>
                  {entries.map((entry) => {
                    const isOpen = openPath === entry.name
                    return (
                      <Fragment key={entry.name}>
                        <Row
                          depth={depthOf(entry.name)}
                          leading={
                            <FontAwesomeIcon
                              className="h-3.5 w-3.5 text-[color:var(--tx3)]"
                              fixedWidth
                              icon={entry.isDirectory ? faFolder : iconForFilename(entry.name)}
                            />
                          }
                          onClick={entry.isText ? () => setOpenPath(isOpen ? null : entry.name) : undefined}
                          title={leafName(entry.name)}
                          trailing={
                            !entry.isDirectory ? (
                              <span className="text-xs text-[color:var(--tx3)]">
                                {formatBytes(entry.size)}
                              </span>
                            ) : undefined
                          }
                        />
                        {isOpen ? (
                          <li className="border-b border-[color:var(--sep)] px-4 pb-3">
                            <QueryState
                              className="py-0"
                              errorLabel="Preview unavailable."
                              loadingLabel="Loading…"
                              query={entryText}
                            >
                              {() => (
                                <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border border-[color:var(--sep)] bg-[color:var(--sb)] p-3 font-mono text-xs leading-relaxed text-[color:var(--tx)]">
                                  {entryText.data?.text}
                                  {entryText.data?.truncated ? '\n\n…truncated.' : ''}
                                </pre>
                              )}
                            </QueryState>
                          </li>
                        ) : null}
                      </Fragment>
                    )
                  })}
                </RowList>
              </div>
            </>
          )
        }}
      </QueryState>
    </div>
  )
}
