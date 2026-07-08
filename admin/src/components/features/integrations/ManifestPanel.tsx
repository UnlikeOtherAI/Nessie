import type { IntegrationPluginManifest } from '../../../lib/api-client'

const installModeLabels: Record<IntegrationPluginManifest['install'][number]['mode'], string> = {
  api_key: 'API key',
  hosted_preinstall: 'Hosted',
  link_out: 'Link out',
  local_mcp: 'Local MCP',
  native_data_source: 'Native source',
  remote_mcp_oauth: 'OAuth MCP',
}

const surfaceStatusLabels: Record<IntegrationPluginManifest['ui']['pages'][number]['status'], string> = {
  available: 'Available',
  blocked: 'Blocked',
  planned: 'Planned',
}

const privacyTierLabels: Record<IntegrationPluginManifest['mcp']['tools'][number]['privacyTier'], string> = {
  local_only: 'Local only',
  normal: 'Normal',
  restricted: 'Restricted',
  sensitive: 'Sensitive',
}

export const ManifestPanel = ({
  loading = false,
  manifest,
}: {
  loading?: boolean
  manifest: IntegrationPluginManifest | undefined
}) => {
  if (loading) {
    return (
      <section className="border-t border-[var(--sep)] pt-4">
        <h3 className="text-sm font-semibold text-[var(--tx)]">Plugin manifest</h3>
        <p className="mt-1 text-sm text-[var(--tx3)]">Loading plugin manifest...</p>
      </section>
    )
  }

  if (!manifest) {
    return (
      <section className="border-t border-[var(--sep)] pt-4">
        <h3 className="text-sm font-semibold text-[var(--tx)]">Plugin manifest</h3>
        <p className="mt-1 text-sm text-[var(--tx3)]">No manifest registered.</p>
      </section>
    )
  }

  const visibleTools = manifest.mcp.tools.slice(0, 4)
  const availableSurfaces = [
    ...manifest.ui.pages,
    ...manifest.ui.cards,
    ...manifest.ui.controls,
  ].filter((surface) => surface.status === 'available')

  return (
    <section className="border-t border-[var(--sep)] pt-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-[var(--tx)]">Plugin manifest</h3>
        <span className="rounded bg-[var(--overlay)] px-2 py-0.5 text-[11px] text-[var(--tx2)]">
          {manifest.version}
        </span>
        <span className="rounded bg-[var(--overlay)] px-2 py-0.5 text-[11px] text-[var(--tx2)]">
          {manifest.manifestRef}
        </span>
      </div>

      <div className="mt-3 grid gap-4">
        <div>
          <div className="text-xs font-semibold uppercase text-[var(--tx3)]">Install modes</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {manifest.install.map((install) => (
              <span
                className="rounded border border-[var(--sep)] px-2 py-1 text-xs text-[var(--tx2)]"
                key={`${install.mode}:${install.availability}`}
                title={install.setup}
              >
                {installModeLabels[install.mode]} · {install.availability.replace('_', '-')}
              </span>
            ))}
          </div>
        </div>

        <div>
          <div className="text-xs font-semibold uppercase text-[var(--tx3)]">MCP and tools</div>
          <div className="mt-2 text-sm leading-6 text-[var(--tx2)]">
            {manifest.mcp.catalogTemplate
              ? `${manifest.mcp.catalogTemplate.label} catalog template, ${manifest.mcp.catalogTemplate.protocol}/${manifest.mcp.catalogTemplate.authMethod}`
              : 'No MCP catalog template yet.'}
          </div>
          <div className="mt-2 grid gap-2">
            {visibleTools.map((tool) => (
              <div className="rounded border border-[var(--sep)] px-2 py-1.5" key={tool.name}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-semibold text-[var(--tx)]">{tool.label}</span>
                  <span className="rounded bg-[var(--overlay)] px-1.5 py-0.5 text-[11px] text-[var(--tx3)]">
                    {surfaceStatusLabels[tool.status]}
                  </span>
                  <span className="rounded bg-[var(--overlay)] px-1.5 py-0.5 text-[11px] text-[var(--tx3)]">
                    {privacyTierLabels[tool.privacyTier]}
                  </span>
                </div>
                <p className="mt-1 text-xs leading-5 text-[var(--tx3)]">{tool.description}</p>
              </div>
            ))}
          </div>
        </div>

        <div>
          <div className="text-xs font-semibold uppercase text-[var(--tx3)]">Available surfaces</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {availableSurfaces.length ? availableSurfaces.map((surface) => (
              <span
                className="rounded bg-[var(--overlay)] px-2 py-1 text-xs text-[var(--tx2)]"
                key={`${surface.label}:${surface.status}`}
              >
                {surface.label}
              </span>
            )) : (
              <span className="text-sm text-[var(--tx3)]">None yet</span>
            )}
          </div>
        </div>

        <div>
          <div className="text-xs font-semibold uppercase text-[var(--tx3)]">Privacy boundary</div>
          <p className="mt-1 text-sm leading-6 text-[var(--tx2)]">
            {manifest.privacy.defaultImportPolicy}
          </p>
        </div>
      </div>
    </section>
  )
}
