import { useState } from 'react'
import { ColumnBrowserItem } from '../../shared/column-browser/ColumnBrowserItem'
import { StatusPill } from '../../primitives/StatusPill'
import {
  useDiscoverMcpEndpoint,
  type McpDiscoveryResultRecord,
  type McpLibraryEntryRecord,
} from '../../../facades/mcp-library/hooks'

/**
 * Left-column content of the "Library" tab: search the public MCP server
 * library (curated + official registry) and the "I only have a link" path —
 * paste any URL and the backend probes it for an MCP endpoint.
 * Presentational apart from the discovery mutation; the page owns selection.
 */

type LibraryPanelProps = {
  entries: McpLibraryEntryRecord[]
  loading: boolean
  registryError: string | null
  search: string
  onSearchChange: (value: string) => void
  selectedKey?: string
  onSelect: (entry: McpLibraryEntryRecord) => void
  onDiscovered: (entry: McpLibraryEntryRecord) => void
}

const inputClass = [
  'admin-input w-full rounded-md border border-[color:var(--sep)]',
  'bg-[var(--scrim)] px-3 py-2 text-sm text-[var(--tx)]',
  'focus:border-[color:var(--accent)] focus:outline-none',
].join(' ')

const hostnameOf = (url: string): string => {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

export const discoveryToLibraryEntry = (
  result: McpDiscoveryResultRecord,
): McpLibraryEntryRecord | null => {
  if (!result.proposal) return null
  const host = hostnameOf(result.proposal.url)
  const name = host.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase()
  return {
    source: 'registry',
    key: `discovered:${result.proposal.url}`,
    name: name || 'discovered-connector',
    label: host,
    description: `Discovered MCP endpoint at ${result.proposal.url}`,
    vendor: null,
    sourceUrl: null,
    url: result.proposal.url,
    transport: result.proposal.transport,
    authMethod: result.proposal.authMethod,
    authHint: result.proposal.note,
  }
}

export const LibraryPanel = ({
  entries,
  loading,
  registryError,
  search,
  onSearchChange,
  selectedKey,
  onSelect,
  onDiscovered,
}: LibraryPanelProps) => {
  const discover = useDiscoverMcpEndpoint()
  const [linkUrl, setLinkUrl] = useState('')
  const [discoverMessage, setDiscoverMessage] = useState<string | null>(null)

  const runDiscovery = async () => {
    const url = linkUrl.trim()
    if (!url) return
    setDiscoverMessage(null)
    try {
      const result = await discover.mutateAsync({ url })
      const entry = discoveryToLibraryEntry(result)
      if (entry) {
        setDiscoverMessage(
          entry.authMethod === 'none'
            ? `Found an MCP endpoint at ${entry.url} — ready to add.`
            : `Found an MCP endpoint at ${entry.url}. It needs a credential — you can add it during install.`,
        )
        onDiscovered(entry)
      } else {
        setDiscoverMessage(
          'No MCP endpoint found at that address. Try searching by service name instead.',
        )
      }
    } catch (error) {
      setDiscoverMessage(error instanceof Error ? error.message : 'Discovery failed')
    }
  }

  return (
    <div className="grid gap-3">
      <input
        className={inputClass}
        onChange={(event) => onSearchChange(event.target.value)}
        placeholder="Search services (notion, stripe, github…)"
        value={search}
      />

      <div className="grid gap-2 rounded-md border border-[color:var(--sep)] p-3">
        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--tx3)]">
          Only have a link?
        </div>
        <div className="flex gap-2">
          <input
            className={inputClass}
            onChange={(event) => setLinkUrl(event.target.value)}
            placeholder="https://mcp.example.com"
            value={linkUrl}
          />
          <button
            className={[
              'admin-button admin-button-primary shrink-0 rounded-md px-3 py-1 text-xs',
              'font-semibold disabled:cursor-not-allowed disabled:opacity-40',
            ].join(' ')}
            disabled={discover.isPending || !linkUrl.trim()}
            onClick={() => void runDiscovery()}
            type="button"
          >
            {discover.isPending ? 'Checking…' : 'Check link'}
          </button>
        </div>
        {discoverMessage ? (
          <div className="text-xs text-[color:var(--tx2)]">{discoverMessage}</div>
        ) : null}
      </div>

      {registryError ? (
        <div className="text-xs text-[color:var(--tx3)]">
          Public registry unavailable — showing the curated library only.
        </div>
      ) : null}

      {loading ? (
        <div className="py-8 text-center text-sm text-[color:var(--tx3)]">Searching…</div>
      ) : entries.length === 0 ? (
        <div className="py-8 text-center text-sm text-[color:var(--tx3)]">
          No connectors match that search. If you have the service&apos;s URL, paste it above.
        </div>
      ) : (
        <div className="grid gap-3">
          {entries.map((entry) => (
            <ColumnBrowserItem
              caption={
                entry.vendor
                  ? `${entry.transport.toUpperCase()} · ${entry.vendor}`
                  : entry.transport.toUpperCase()
              }
              isSelected={entry.key === selectedKey}
              key={entry.key}
              meta={
                <StatusPill tone={entry.source === 'curated' ? 'success' : 'muted'}>
                  {entry.source === 'curated' ? 'verified' : 'registry'}
                </StatusPill>
              }
              onClick={() => onSelect(entry)}
              subtitle={
                entry.authMethod === 'none' ? 'no key needed' : `auth: ${entry.authMethod}`
              }
              title={entry.label}
            >
              {entry.description || entry.name}
            </ColumnBrowserItem>
          ))}
        </div>
      )}
    </div>
  )
}
