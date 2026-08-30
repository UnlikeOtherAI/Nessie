import { useMemo, useState } from 'react'
import { SectionLabel } from '../../primitives/SectionLabel'
import type {
  KnowledgePageRecord,
  KnowledgeVersionRecord,
} from '../../../facades/knowledge/hooks'

type VersionHistoryProps = {
  onRestore: (versionId: string) => void
  page: KnowledgePageRecord
  pending?: boolean
  versions: KnowledgeVersionRecord[]
}

type DiffLine = {
  left: string
  right: string
  state: 'same' | 'changed' | 'added' | 'removed'
}

const buildLineDiff = (leftBody: string, rightBody: string): DiffLine[] => {
  const left = leftBody.split('\n')
  const right = rightBody.split('\n')
  const length = Math.max(left.length, right.length)
  return Array.from({ length }, (_, index) => {
    const leftLine = left[index] ?? ''
    const rightLine = right[index] ?? ''
    if (leftLine === rightLine) {
      return { left: leftLine, right: rightLine, state: 'same' }
    }
    if (left[index] === undefined) {
      return { left: '', right: rightLine, state: 'added' }
    }
    if (right[index] === undefined) {
      return { left: leftLine, right: '', state: 'removed' }
    }
    return { left: leftLine, right: rightLine, state: 'changed' }
  })
}

const lineTone: Record<DiffLine['state'], string> = {
  same: 'text-[color:var(--tx2)]',
  changed: 'bg-[var(--warning-soft)] text-[var(--warning-text)]',
  added: 'bg-[var(--success-soft)] text-[var(--success-text)]',
  removed: 'bg-[var(--danger-soft)] text-[var(--danger-text)]',
}

export const VersionHistory = ({
  onRestore,
  page,
  pending,
  versions,
}: VersionHistoryProps) => {
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null)
  const selectedVersion =
    versions.find((version) => version.id === selectedVersionId) ?? versions[0] ?? null
  const currentBody = page.latestVersion?.body ?? ''
  const selectedBody = selectedVersion?.body ?? ''
  const diff = useMemo(
    () => buildLineDiff(selectedBody, currentBody),
    [currentBody, selectedBody],
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-[color:var(--sep)] p-4">
        <SectionLabel>Versions</SectionLabel>
        <div className="mt-3 flex flex-wrap gap-2">
          {versions.map((version) => (
            <button
              className={[
                'rounded-md border px-2 py-1 text-xs',
                selectedVersion?.id === version.id
                  ? 'border-[color:var(--accent)] bg-[color:var(--accent)] text-[var(--on-accent)]'
                  : 'border-[color:var(--sep)] text-[color:var(--tx2)] hover:bg-[var(--overlay-weak)]',
              ].join(' ')}
              key={version.id}
              onClick={() => setSelectedVersionId(version.id)}
              type="button"
            >
              v{version.versionNumber}
            </button>
          ))}
        </div>
      </div>

      {selectedVersion ? (
        <>
          <div className="border-b border-[color:var(--sep)] p-4 text-sm text-[color:var(--tx2)]">
            <div className="font-semibold text-[var(--tx)]">v{selectedVersion.versionNumber}</div>
            <div className="mt-1">
              {new Date(selectedVersion.createdAt).toLocaleString()} by {selectedVersion.authorType}
            </div>
            {selectedVersion.changeComment ? (
              <div className="mt-2">{selectedVersion.changeComment}</div>
            ) : null}
            <button
              className="admin-button admin-button-secondary mt-3"
              disabled={pending || selectedVersion.id === page.latestVersion?.id}
              onClick={() => onRestore(selectedVersion.id)}
              type="button"
            >
              Restore as new version
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-4">
            <div className="grid min-w-[520px] grid-cols-2 overflow-hidden rounded border border-[color:var(--sep)]">
              <div className="border-b border-r border-[color:var(--sep)] px-3 py-2 text-xs text-[color:var(--tx3)]">
                Selected
              </div>
              <div className="border-b border-[color:var(--sep)] px-3 py-2 text-xs text-[color:var(--tx3)]">
                Current
              </div>
              {diff.map((line, index) => (
                <div className="contents" key={`${index}-${line.state}`}>
                  <pre className={`border-r border-[color:var(--sep)] px-3 py-1 text-xs ${lineTone[line.state]}`}>
                    {line.left || ' '}
                  </pre>
                  <pre className={`px-3 py-1 text-xs ${lineTone[line.state]}`}>
                    {line.right || ' '}
                  </pre>
                </div>
              ))}
            </div>
          </div>
        </>
      ) : (
        <div className="p-4 text-sm text-[color:var(--tx3)]">No versions yet</div>
      )}
    </div>
  )
}
