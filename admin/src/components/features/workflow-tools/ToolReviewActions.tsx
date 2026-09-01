import { useSetToolRegistryStatus } from '../../../facades/tool-grants/hooks'
import type { McpToolRegistryRecord } from '../../../facades/tool-grants/hooks'

/**
 * Owner review verdict on one discovered MCP tool.
 *
 * A connector installed at a shared scope projects its tools at
 * `pending_review`, and the worker only exposes `active` ones — so until
 * somebody approves here, the connector is installed but inert. Built-in tools
 * and first-party integration bundles are managed elsewhere and render
 * nothing.
 */

type ToolReviewActionsProps = {
  tool: McpToolRegistryRecord
}

export const ToolReviewActions = ({ tool }: ToolReviewActionsProps) => {
  const setStatus = useSetToolRegistryStatus()

  if (tool.builtin || tool.mcpInstanceId === null) return null
  // First-party products own their projections through Integrations; the API
  // refuses these ids, so offering the buttons would only produce a 409.
  if (tool.managedProductSlug !== null) return null

  const apply = (status: 'active' | 'disabled') => {
    setStatus.mutate({ status, toolRegistryEntryIds: [tool.id] })
  }

  return (
    <section className="rounded-xl border border-[color:var(--sep)] bg-[color:var(--panel)] p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-[color:var(--tx)]">Review</h3>
          <p className="mt-0.5 text-xs text-[color:var(--tx3)]">
            {tool.status === 'pending_review'
              ? 'Awaiting review — agents cannot call this tool until it is approved.'
              : tool.status === 'active'
                ? 'Approved. Agents granted this tool below can call it.'
                : 'Disabled. No agent can call this tool.'}
          </p>
        </div>
        <div className="flex flex-shrink-0 gap-2">
          <button
            className="admin-button-primary"
            disabled={setStatus.isPending || tool.status === 'active'}
            onClick={() => apply('active')}
            type="button"
          >
            Approve
          </button>
          <button
            className="admin-button"
            disabled={setStatus.isPending || tool.status === 'disabled'}
            onClick={() => apply('disabled')}
            type="button"
          >
            Disable
          </button>
        </div>
      </div>
      {setStatus.isError ? (
        <p className="mt-2 text-xs text-[color:var(--danger-text)]">
          Could not update this tool. Try again.
        </p>
      ) : null}
    </section>
  )
}
