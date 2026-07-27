import { Link } from 'react-router-dom'
import type {
  IntegratedProductResponse,
  IntegrationPluginManifest,
  ProductSurface,
} from '@nessie/schemas'
import { useChannels } from '../../../facades/channels/hooks'
import { isExternalAgentChannel } from '../../../facades/personal-assistant/hooks'
import { meetsRequirements } from '../../../facades/integrations/useProductSurfaces'

const surfaceTypeLabel: Record<ProductSurface['type'], string> = {
  chat_assistant: 'Chat assistant',
  nav_page: 'Page',
  documents_section: 'Documents',
}

// The registry-driven "Where this appears" panel: for a product it lists the
// surfaces its manifest declares and, using the live product record, renders
// each as a working link when active or a muted "unlocks on activation" hint
// when not. This replaces the inert manifest badge list — the same registry the
// shell reads drives what shows here.
export const ProductSurfacesPanel = ({
  loading = false,
  manifest,
  product,
}: {
  loading?: boolean
  manifest: IntegrationPluginManifest | undefined
  product: IntegratedProductResponse
}) => {
  const { data: channels = [] } = useChannels()

  const heading = (
    <h3 className="text-sm font-semibold text-[var(--tx)]">Where this appears</h3>
  )

  if (loading) {
    return (
      <section className="border-t border-[var(--sep)] pt-4">
        {heading}
        <p className="mt-1 text-sm text-[var(--tx3)]">Loading surfaces…</p>
      </section>
    )
  }

  const surfaces: ProductSurface[] = manifest?.surfaces ?? []
  if (surfaces.length === 0) {
    return (
      <section className="border-t border-[var(--sep)] pt-4">
        {heading}
        <p className="mt-1 text-sm text-[var(--tx3)]">
          This product doesn’t weave any surfaces into the app yet.
        </p>
      </section>
    )
  }

  const resolveTarget = (surface: ProductSurface): string | null => {
    if (surface.type === 'nav_page') return surface.route
    if (surface.type === 'documents_section') return `/knowledge-base?view=${surface.view}`
    const channel = channels.find(
      (candidate) => isExternalAgentChannel(candidate) && candidate.label === product.name,
    )
    return channel ? `/channels/${channel.id}` : null
  }

  const actionLabel = (surface: ProductSurface): string =>
    surface.type === 'chat_assistant' ? `Open ${surface.label} chat` : `Open ${surface.label}`

  return (
    <section className="border-t border-[var(--sep)] pt-4">
      {heading}
      <div className="mt-3 grid gap-2">
        {surfaces.map((surface) => {
          const active = meetsRequirements(product, surface.requires)
          const target = active ? resolveTarget(surface) : null
          const key = `${surface.type}:${surface.label}`
          return (
            <div
              className="flex items-center justify-between gap-3 rounded border border-[var(--sep)] px-3 py-2"
              key={key}
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-[var(--tx)]">{surface.label}</div>
                <div className="text-[11px] uppercase text-[var(--tx3)]">
                  {surfaceTypeLabel[surface.type]}
                </div>
              </div>
              {active && target ? (
                <Link className="admin-button admin-button-secondary admin-button-compact" to={target}>
                  {actionLabel(surface)}
                </Link>
              ) : active ? (
                <span className="text-xs text-[var(--tx3)]">Preparing…</span>
              ) : (
                <span className="rounded bg-[var(--overlay)] px-2 py-1 text-[11px] text-[var(--tx3)]">
                  Unlocks on activation
                </span>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}
