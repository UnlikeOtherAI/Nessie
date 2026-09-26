import { useMemo, useState } from 'react'
import { ChoiceGroup } from '../../shared/ChoiceGroup'
import type {
  KnowledgePageRecord,
  KnowledgeVersionRecord,
} from '../../../facades/knowledge/hooks'
import { buildVersionDiff, type VersionDiffOperation } from './version-history-diff'

type VersionHistoryProps = {
  canRestore: boolean
  onDownload: (versionId: string) => void
  onRestore: (versionId: string) => void
  page: KnowledgePageRecord
  pending?: boolean
  versions: KnowledgeVersionRecord[]
}

const changeTone: Record<VersionDiffOperation['change'], { old: string; current: string }> = {
  same: { old: 'text-[color:var(--tx2)]', current: 'text-[color:var(--tx2)]' },
  removed: {
    old: 'bg-[color:var(--danger-soft)] text-[color:var(--danger-text)]',
    current: '',
  },
  added: {
    old: '',
    current: 'bg-[color:var(--success-soft)] text-[color:var(--success-text)]',
  },
  format: {
    old: 'bg-[color:var(--accent-soft)] text-[color:var(--accent)]',
    current: 'bg-[color:var(--accent-soft)] text-[color:var(--accent)]',
  },
}

const marksClass = (marks: string) => {
  const classes: string[] = []
  if (marks.includes('bold')) classes.push('font-semibold')
  if (marks.includes('italic')) classes.push('italic')
  if (marks.includes('underline')) classes.push('underline')
  if (marks.includes('strike')) classes.push('line-through')
  if (marks.includes('code')) classes.push('rounded bg-[color:var(--overlay-weak)] px-1 font-mono text-[0.9em]')
  if (marks.includes('heading-')) classes.push('font-semibold text-[1.15em]')
  return classes.join(' ')
}

const renderSide = (diff: VersionDiffOperation[], side: 'old' | 'current') => (
  <div className="min-h-28 whitespace-pre-wrap break-words px-3 py-3 text-sm leading-7">
    {diff.map((operation, index) => {
      const token = side === 'old' ? operation.oldToken : operation.newToken
      if (!token) return null
      const tone = changeTone[operation.change][side]
      const marks = marksClass(token.marks)
      return (
        <span className={`${tone} ${marks}`} key={`${index}-${side}`}>
          {token.text}
        </span>
      )
    })}
  </div>
)

export const VersionHistory = ({
  canRestore,
  onDownload,
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
    () => buildVersionDiff(selectedBody, currentBody),
    [currentBody, selectedBody],
  )

  return (
    <div className="flex min-h-0 flex-col">
      <div className="border-b border-[color:var(--sep)] p-4">
        <ChoiceGroup
          label="Versions"
          onChange={setSelectedVersionId}
          options={versions.map((version) => ({
            label: `v${version.versionNumber}`,
            value: version.id,
          }))}
          value={selectedVersion?.id ?? ''}
          variant="inline"
        />
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
            <div className="mt-3 flex flex-wrap gap-2">
              {page.kind === 'file' && selectedVersion.attachmentId ? (
                <button
                  className="admin-button admin-button-secondary"
                  onClick={() => onDownload(selectedVersion.id)}
                  type="button"
                >
                  Download this version
                </button>
              ) : null}
              {canRestore ? (
                <button
                  className="admin-button admin-button-secondary"
                  disabled={pending || selectedVersion.id === page.latestVersion?.id}
                  onClick={() => onRestore(selectedVersion.id)}
                  type="button"
                >
                  Restore as new version
                </button>
              ) : null}
            </div>
          </div>
          {page.kind !== 'file' ? (
            <div className="min-h-0 overflow-auto p-4">
              <div className="grid min-w-[520px] grid-cols-2 overflow-hidden rounded border border-[color:var(--sep)]">
                <div className="border-b border-r border-[color:var(--sep)] px-3 py-2 text-xs text-[color:var(--tx3)]">
                  Selected
                </div>
                <div className="border-b border-[color:var(--sep)] px-3 py-2 text-xs text-[color:var(--tx3)]">
                  Current
                </div>
                <div className="border-r border-[color:var(--sep)]">
                  {renderSide(diff, 'old')}
                </div>
                {renderSide(diff, 'current')}
              </div>
              <p className="mt-3 text-xs text-[color:var(--tx3)]">
                <span className="mr-3 text-[color:var(--danger-text)]">Removed</span>
                <span className="mr-3 text-[color:var(--success-text)]">Added</span>
                <span className="text-[color:var(--accent)]">Formatting changed</span>
              </p>
            </div>
          ) : null}
        </>
      ) : (
        <div className="p-4 text-sm text-[color:var(--tx3)]">No versions yet</div>
      )}
    </div>
  )
}
