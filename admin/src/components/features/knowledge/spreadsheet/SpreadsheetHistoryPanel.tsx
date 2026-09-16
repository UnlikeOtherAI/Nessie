import { useState } from 'react'
import { faDownload, faRobot } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import type { KnowledgeVersionRecord } from '../../../../facades/knowledge/hooks'
import { ConfirmDialog } from '../../../shared/ConfirmDialog'
import { EmptyState } from '../../../shared/EmptyState'
import { Pill } from '../../../primitives/Pill'

/**
 * A spreadsheet's versions, and Restore.
 *
 * **Why not `VersionHistory.tsx`.** That component's whole body is a two-column
 * line diff of the markdown body. A workbook's `body` is a tab-separated text
 * projection written for search and embedding, so diffing it line-by-line shows
 * a reader a wall of tabs and calls it a comparison. The version *list* — the
 * part that carries author, comment and Restore — is what a spreadsheet needs,
 * so this is that list without the diff. Everything below the list header is
 * deliberately kind-specific.
 *
 * **Restore is first-class, in three places** (admin-ui.md §"Rule zero"):
 * every row carries its own Restore, the selected version carries the large
 * one, and the pane's pre-destructive notice
 * (`SpreadsheetVersionSavedNotice`) carries a third that restores the version
 * taken immediately before the action. Versioning is the safety net this
 * feature ships *instead of* an approval gate, so reaching it must never be a
 * hunt — and there is no retention policy to make a version expire.
 */

type SpreadsheetHistoryPanelProps = {
  canRestore: boolean
  /** Serves the xlsx rendition of that version. */
  onDownload: (versionId: string) => void
  onRestore: (versionId: string) => void
  pending?: boolean
  versions: KnowledgeVersionRecord[]
}

const authorLine = (version: KnowledgeVersionRecord): string =>
  `${new Date(version.createdAt).toLocaleString()}`

export const SpreadsheetHistoryPanel = ({
  canRestore,
  onDownload,
  onRestore,
  pending = false,
  versions,
}: SpreadsheetHistoryPanelProps) => {
  const [confirming, setConfirming] = useState<KnowledgeVersionRecord | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = versions.find((version) => version.id === selectedId) ?? versions[0] ?? null

  if (versions.length === 0) {
    return (
      <div className="p-4">
        <EmptyState>
          No versions yet. “Save version” takes one you can come back to; one is
          also taken automatically before anything destructive.
        </EmptyState>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="spreadsheet-history">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {versions.map((version) => (
          <div
            className={[
              'flex items-start gap-3 border-b border-[color:var(--sep)] px-4 py-3',
              version.id === selected?.id ? 'bg-[color:var(--sb)]' : '',
            ].join(' ')}
            data-testid={`spreadsheet-version-${version.versionNumber}`}
            key={version.id}
          >
            <button
              className="min-w-0 flex-1 text-left"
              onClick={() => setSelectedId(version.id)}
              type="button"
            >
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-[color:var(--tx)]">
                  v{version.versionNumber}
                </span>
                {version.authorType === 'agent' ? (
                  <Pill size="sm" tone="info">
                    {/* The glyph and the word need an explicit gap: `Pill`
                        uppercases and letter-spaces its label, and a literal
                        space between two JSX children collapses against that. */}
                    <span className="inline-flex items-center gap-1">
                      <FontAwesomeIcon icon={faRobot} />
                      agent
                    </span>
                  </Pill>
                ) : null}
              </div>
              <div className="text-xs text-[color:var(--tx3)]">{authorLine(version)}</div>
              {version.changeComment ? (
                <div className="mt-1 text-sm text-[color:var(--tx2)]">{version.changeComment}</div>
              ) : null}
            </button>
            <div className="flex shrink-0 gap-1.5">
              <button
                aria-label={`Download v${version.versionNumber} as xlsx`}
                className="admin-button admin-button-secondary admin-button-compact"
                onClick={() => onDownload(version.id)}
                title="Download this version as an xlsx"
                type="button"
              >
                <FontAwesomeIcon icon={faDownload} />
              </button>
              {canRestore ? (
                <button
                  className="admin-button admin-button-secondary admin-button-compact"
                  data-testid={`spreadsheet-restore-${version.versionNumber}`}
                  disabled={pending}
                  onClick={() => setConfirming(version)}
                  type="button"
                >
                  Restore
                </button>
              ) : null}
            </div>
          </div>
        ))}
      </div>

      {selected && canRestore ? (
        <div className="border-t border-[color:var(--sep)] p-4">
          <button
            className="admin-button admin-button-primary w-full"
            data-testid="spreadsheet-restore-selected"
            disabled={pending}
            onClick={() => setConfirming(selected)}
            type="button"
          >
            Restore this version (v{selected.versionNumber})
          </button>
          <p className="mt-2 text-xs text-[color:var(--tx3)]">
            The current state is saved as its own version first, so restoring is
            never the end of anything.
          </p>
        </div>
      ) : null}

      <ConfirmDialog
        blocking
        body={
          confirming
            ? `Everyone in this spreadsheet sees v${confirming.versionNumber} as it was. `
              + 'The current state is saved as a version of its own first.'
            : undefined
        }
        cancelLabel="Cancel"
        confirmLabel="Restore"
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          if (confirming) onRestore(confirming.id)
          setConfirming(null)
        }}
        open={confirming !== null}
        pending={pending}
        title={confirming ? `Restore v${confirming.versionNumber}?` : 'Restore'}
      />
    </div>
  )
}
