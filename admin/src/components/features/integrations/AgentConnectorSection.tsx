import { Link } from 'react-router-dom'
import type { IntegratedProductResponse } from '../../../lib/api-client'
import type { PillTone } from '../../primitives/Pill'
import { Pill } from '../../primitives/Pill'
import { StatGrid, StatTile } from '../../shared/StatTile'

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

export const mcpConnectorTone = (product: IntegratedProductResponse): PillTone => {
  if (!product.mcpCatalogEntryId || !product.mcpInstallation) return 'muted'
  return product.mcpInstallation.lifecycleState === 'active' ? 'success' : 'warning'
}

/** Apps is the one destination for finding or connecting a product's app. */
export const appsHref = (_product: IntegratedProductResponse): string => '/apps'

const mcpActionHref = (product: IntegratedProductResponse): string =>
  appsHref(product)

const mcpActionLabel = (product: IntegratedProductResponse): string =>
  product.mcpCatalogEntryId && !product.mcpInstallation
    ? 'Connect app'
    : 'Open apps'

const mcpActionClass = (product: IntegratedProductResponse): string =>
  product.mcpCatalogEntryId && !product.mcpInstallation
    ? 'admin-button admin-button-primary admin-button-compact'
    : 'admin-button admin-button-secondary admin-button-compact'

const failuresTone = (count: number): 'danger' | 'default' => (count > 0 ? 'danger' : 'default')

export const AgentConnectorSection = ({
  product,
}: {
  product: IntegratedProductResponse
}) => {
  const installation = product.mcpInstallation

  return (
    <section className="border-t border-[color:var(--sep)] pt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-[color:var(--tx)]">Agent connector</h3>
          <p className="mt-1 text-sm leading-6 text-[color:var(--tx2)]">
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
          <Pill radius="chip" size="sm" tone="muted" uppercase={false}>
            Contract pending
          </Pill>
        )}
      </div>

      {installation ? (
        <StatGrid className="mt-3">
          <StatTile label="Status" value={lifecycleLabels[installation.lifecycleState] ?? 'Unknown'} />
          <StatTile label="Scope" value={scopeLabels[installation.scopeType] ?? 'Shared'} />
          <StatTile label="Tools" value={installation.toolCount} />
          <StatTile
            label="Failures"
            tone={failuresTone(installation.healthFailureCount)}
            value={installation.healthFailureCount}
          />
        </StatGrid>
      ) : null}

      {installation?.lastError ? (
        <p className="mt-2 text-xs text-[color:var(--danger-text)]">{installation.lastError}</p>
      ) : null}
    </section>
  )
}
