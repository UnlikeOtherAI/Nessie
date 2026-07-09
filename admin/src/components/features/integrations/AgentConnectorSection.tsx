import { Link } from 'react-router-dom'
import type { IntegratedProductResponse } from '../../../lib/api-client'

type ProductMcpInstallation = NonNullable<IntegratedProductResponse['mcpInstallation']>

const lifecycleLabels: Record<ProductMcpInstallation['lifecycleState'], string> = {
  active: 'Active',
  error: 'Error',
  paused: 'Paused',
  pending_setup: 'Needs setup',
}

const scopeLabels: Record<ProductMcpInstallation['scopeType'], string> = {
  channel: 'Channel',
  organization: 'Organization',
  project: 'Project',
  system: 'System',
  team: 'Team',
  user: 'User',
}

export const mcpConnectorLabel = (product: IntegratedProductResponse): string => {
  if (!product.mcpCatalogEntryId) return 'No MCP catalog'
  if (!product.mcpInstallation) return 'MCP not installed'
  return `MCP ${lifecycleLabels[product.mcpInstallation.lifecycleState] ?? 'Unknown'}`
}

export const mcpConnectorClass = (product: IntegratedProductResponse): string =>
  [
    'rounded px-2 py-0.5 text-[11px]',
    !product.mcpCatalogEntryId
      ? 'bg-[var(--overlay)] text-[var(--tx2)]'
      : product.mcpInstallation?.lifecycleState === 'active'
        ? 'bg-[var(--success-soft)] text-[var(--success-text)]'
        : product.mcpInstallation
          ? 'bg-[var(--warning-soft)] text-[var(--warning-text)]'
          : 'bg-[var(--overlay)] text-[var(--tx2)]',
  ].join(' ')

export const mcpCatalogHref = (product: IntegratedProductResponse): string =>
  product.mcpCatalogEntryId
    ? `/mcp-app-store?catalogEntryId=${product.mcpCatalogEntryId}`
    : '/mcp-app-store'

export const mcpInstallHref = (product: IntegratedProductResponse): string =>
  product.mcpCatalogEntryId
    ? `/mcp-app-store?catalogEntryId=${product.mcpCatalogEntryId}&action=install`
    : '/mcp-app-store'

const mcpActionHref = (product: IntegratedProductResponse): string =>
  product.mcpCatalogEntryId && !product.mcpInstallation
    ? mcpInstallHref(product)
    : mcpCatalogHref(product)

const mcpActionLabel = (product: IntegratedProductResponse): string =>
  product.mcpCatalogEntryId && !product.mcpInstallation
    ? 'Install connector'
    : 'MCP store'

const mcpActionClass = (product: IntegratedProductResponse): string =>
  product.mcpCatalogEntryId && !product.mcpInstallation
    ? 'admin-button admin-button-primary text-xs'
    : 'admin-button admin-button-secondary text-xs'

export const AgentConnectorSection = ({
  product,
}: {
  product: IntegratedProductResponse
}) => {
  const installation = product.mcpInstallation

  return (
    <section className="border-t border-[var(--sep)] pt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-[var(--tx)]">Agent connector</h3>
          <p className="mt-1 text-sm leading-6 text-[var(--tx2)]">
            {installation
              ? `Installed at ${(scopeLabels[installation.scopeType] ?? 'Shared').toLowerCase()} scope.`
              : product.mcpCatalogEntryId
                ? 'No shared MCP connector is installed for this team yet.'
                : 'This product has no MCP connector contract yet.'}
          </p>
        </div>
        {product.mcpCatalogEntryId ? (
          <Link className={mcpActionClass(product)} to={mcpActionHref(product)}>
            {mcpActionLabel(product)}
          </Link>
        ) : (
          <span className="rounded border border-[var(--sep)] px-3 py-2 text-xs text-[var(--tx3)]">
            Contract pending
          </span>
        )}
      </div>

      {installation ? (
        <div className="mt-3 grid gap-2 sm:grid-cols-4">
          <div className="rounded border border-[var(--sep)] px-3 py-2">
            <div className="text-[11px] font-semibold uppercase text-[var(--tx3)]">Status</div>
            <div className="mt-1 text-sm text-[var(--tx)]">
              {lifecycleLabels[installation.lifecycleState] ?? 'Unknown'}
            </div>
          </div>
          <div className="rounded border border-[var(--sep)] px-3 py-2">
            <div className="text-[11px] font-semibold uppercase text-[var(--tx3)]">Scope</div>
            <div className="mt-1 text-sm text-[var(--tx)]">
              {scopeLabels[installation.scopeType] ?? 'Shared'}
            </div>
          </div>
          <div className="rounded border border-[var(--sep)] px-3 py-2">
            <div className="text-[11px] font-semibold uppercase text-[var(--tx3)]">Tools</div>
            <div className="mt-1 text-sm text-[var(--tx)]">{installation.toolCount}</div>
          </div>
          <div className="rounded border border-[var(--sep)] px-3 py-2">
            <div className="text-[11px] font-semibold uppercase text-[var(--tx3)]">Failures</div>
            <div className="mt-1 text-sm text-[var(--tx)]">
              {installation.healthFailureCount}
            </div>
          </div>
        </div>
      ) : null}

      {installation?.lastError ? (
        <p className="mt-2 text-xs text-[var(--danger-text)]">{installation.lastError}</p>
      ) : null}
    </section>
  )
}
