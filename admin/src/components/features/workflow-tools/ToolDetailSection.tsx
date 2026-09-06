import { ToolBadge } from '../../shared/ToolBadge'
import { ToolPermissionPill } from '../../shared/ToolPermissionPill'
import { ToolTransportPill } from '../../shared/ToolTransportPill'
import type { McpToolRegistryRecord } from '../../../facades/tool-grants/hooks'

/**
 * Read-only per-tool config drawer. Surfaces the JSON schemas + transport
 * config (collapsed by default) so admins can audit what they're about to
 * grant without leaving the page.
 */

type ToolDetailDrawerProps = {
  tool: McpToolRegistryRecord
}

const summaryClass = [
  'cursor-pointer select-none text-[11px] font-semibold uppercase',
  'tracking-[0.18em] text-[color:var(--tx3)] hover:text-[color:var(--tx2)]',
].join(' ')

const codeBlockClass = [
  'mt-2 max-h-64 overflow-auto rounded-md border border-[color:var(--sep)]',
  'bg-[var(--scrim-strong)] p-3 text-xs text-[color:var(--tx2)]',
].join(' ')

const renderJson = (value: unknown) => JSON.stringify(value, null, 2)

const JsonSection = ({
  defaultOpen = false,
  title,
  value,
}: {
  defaultOpen?: boolean
  title: string
  value: unknown
}) => (
  <details open={defaultOpen}>
    <summary className={summaryClass}>{title}</summary>
    <pre className={codeBlockClass}>{renderJson(value)}</pre>
  </details>
)

export const ToolDetailSection = ({ tool }: ToolDetailDrawerProps) => (
  <div className="grid gap-4">
    <div className="rounded-xl border border-[color:var(--sep)] bg-[var(--scrim-weak)] p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="min-w-0 flex-1 text-lg font-semibold text-[var(--tx)]">
          {tool.label}
        </h2>
        <ToolBadge label={tool.source} source={tool.source} />
        <ToolTransportPill transport={tool.transport} />
        <ToolPermissionPill status={tool.status} />
      </div>
      <div className="mt-2 text-sm text-[color:var(--tx2)]">{tool.description}</div>
      <dl className="mt-3 grid grid-cols-2 gap-y-1 text-xs">
        <dt className="text-[color:var(--tx3)]">Tool ID</dt>
        <dd className="text-[var(--tx)]">{tool.toolId}</dd>
        <dt className="text-[color:var(--tx3)]">Scope key</dt>
        <dd className="text-[var(--tx)]">{tool.scopeKey}</dd>
        <dt className="text-[color:var(--tx3)]">Version</dt>
        <dd className="text-[var(--tx)]">{tool.version}</dd>
        <dt className="text-[color:var(--tx3)]">Enabled</dt>
        <dd className="text-[var(--tx)]">{tool.enabled ? 'Yes' : 'No'}</dd>
        <dt className="text-[color:var(--tx3)]">Tags</dt>
        <dd className="text-[var(--tx)]">{tool.tags.length > 0 ? tool.tags.join(', ') : '—'}</dd>
        <dt className="text-[color:var(--tx3)]">Bundle</dt>
        <dd className="text-[var(--tx)]">{tool.bundleId ?? '—'}</dd>
        <dt className="text-[color:var(--tx3)]">MCP instance</dt>
        <dd className="text-[var(--tx)]">{tool.mcpInstanceId ?? '—'}</dd>
      </dl>
    </div>

    <div className="grid gap-3">
      <JsonSection title="Input schema" value={tool.inputSchema} />
      {tool.outputSchema ? (
        <JsonSection title="Output schema" value={tool.outputSchema} />
      ) : null}
      <JsonSection title="Transport config" value={tool.transportConfig} />
    </div>
  </div>
)
