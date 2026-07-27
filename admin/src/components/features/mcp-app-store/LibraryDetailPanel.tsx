import { StatusPill } from '../../primitives/StatusPill'
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

const fieldLabel = 'text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--tx3)]'

export const LibraryDetailPanel = ({ entry, onAdd }: LibraryDetailPanelProps) => (
  <div className="grid gap-4">
    <div className="flex items-center gap-2">
      <StatusPill tone={entry.source === 'curated' ? 'success' : 'muted'}>
        {entry.source === 'curated' ? 'verified' : 'registry'}
      </StatusPill>
      <StatusPill tone={entry.authMethod === 'none' ? 'success' : 'warning'}>
        {entry.authMethod === 'none' ? 'no key needed' : `auth: ${entry.authMethod}`}
      </StatusPill>
    </div>

    {entry.description ? (
      <p className="text-sm text-[color:var(--tx2)]">{entry.description}</p>
    ) : null}

    <div className="grid gap-3">
      <div>
        <div className={fieldLabel}>Endpoint</div>
        <div className="break-all text-sm text-[color:var(--tx)]">{entry.url}</div>
      </div>
      <div>
        <div className={fieldLabel}>Transport</div>
        <div className="text-sm text-[color:var(--tx)]">{entry.transport.toUpperCase()}</div>
      </div>
      {entry.vendor ? (
        <div>
          <div className={fieldLabel}>Vendor</div>
          <div className="text-sm text-[color:var(--tx)]">{entry.vendor}</div>
        </div>
      ) : null}
      {entry.authHint ? (
        <div>
          <div className={fieldLabel}>Credential</div>
          <div className="text-sm text-[color:var(--tx2)]">{entry.authHint}</div>
        </div>
      ) : null}
      {entry.sourceUrl ? (
        <div>
          <div className={fieldLabel}>Docs</div>
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
