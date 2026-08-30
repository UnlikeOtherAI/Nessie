import { Pill } from '../../primitives/Pill'
import { SectionLabel } from '../../primitives/SectionLabel'
import type { McpLibraryEntryRecord } from '../../../facades/mcp-library/hooks'

/**
 * Middle-column detail for a selected library entry (or discovered endpoint):
 * what it is, where it connects, what credential it expects — plus the single
 * "Add connector" action that opens the guided install dialog.
 */

type LibraryDetailPanelProps = {
  entry: McpLibraryEntryRecord
  onAdd: () => void
}


export const LibraryDetailPanel = ({ entry, onAdd }: LibraryDetailPanelProps) => (
  <div className="grid gap-4">
    <div className="flex items-center gap-2">
      <Pill tone={entry.source === 'curated' ? 'success' : 'muted'}>
        {entry.source === 'curated' ? 'verified' : 'registry'}
      </Pill>
      <Pill tone={entry.authMethod === 'none' ? 'success' : 'warning'}>
        {entry.authMethod === 'none' ? 'no key needed' : `auth: ${entry.authMethod}`}
      </Pill>
    </div>

    {entry.description ? (
      <p className="text-sm text-[color:var(--tx2)]">{entry.description}</p>
    ) : null}

    <div className="grid gap-3">
      <div>
        <SectionLabel size="2xs">Endpoint</SectionLabel>
        <div className="break-all text-sm text-[color:var(--tx)]">{entry.url}</div>
      </div>
      <div>
        <SectionLabel size="2xs">Transport</SectionLabel>
        <div className="text-sm text-[color:var(--tx)]">{entry.transport.toUpperCase()}</div>
      </div>
      {entry.vendor ? (
        <div>
          <SectionLabel size="2xs">Vendor</SectionLabel>
          <div className="text-sm text-[color:var(--tx)]">{entry.vendor}</div>
        </div>
      ) : null}
      {entry.authHint ? (
        <div>
          <SectionLabel size="2xs">Credential</SectionLabel>
          <div className="text-sm text-[color:var(--tx2)]">{entry.authHint}</div>
        </div>
      ) : null}
      {entry.sourceUrl ? (
        <div>
          <SectionLabel size="2xs">Docs</SectionLabel>
          <a
            className="break-all text-sm text-[color:var(--accent)] hover:underline"
            href={entry.sourceUrl}
            rel="noreferrer"
            target="_blank"
          >
            {entry.sourceUrl}
          </a>
        </div>
      ) : null}
    </div>

    <div>
      <button
        className={[
          'admin-button admin-button-primary',
          'text-sm font-semibold',
        ].join(' ')}
        onClick={onAdd}
        type="button"
      >
        Add connector
      </button>
    </div>
  </div>
)
