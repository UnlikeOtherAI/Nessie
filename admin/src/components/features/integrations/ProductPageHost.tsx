import type { ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useProductSurfaces } from '../../../facades/integrations/useProductSurfaces'
import { MobileSectionHeader } from '../../../layouts/admin-shell/MobileSectionHeader'
import { productPageComponents } from './product-page-registry'

// Generic host for product `nav_page` surfaces. It resolves the active surface
// for the current route from the registry, then either renders the concrete
// page component (registered by a later slice) or a placeholder that proves the
// route is wired and gated. A route that is not currently an active surface —
// product not linked/enabled — renders a "not available" state rather than the
// page, so surfaces stay gated on live activation.
export const ProductPageHost = () => {
  const location = useLocation()
  const { navPages, isLoading } = useProductSurfaces()
  const surface = navPages.find((page) => page.route === location.pathname)

  const frame = (title: string, body: ReactNode) => (
    <div className="flex h-full flex-col">
      <MobileSectionHeader title={title} />
      <div className="min-h-0 flex-1 overflow-y-auto">{body}</div>
    </div>
  )

  if (isLoading) {
    return frame(
      'Loading',
      <div className="py-16 text-center text-sm text-[color:var(--tx3)]">Loading…</div>,
    )
  }

  if (!surface) {
    return frame(
      'Not available',
      <div className="mx-auto max-w-md px-6 py-16 text-center">
        <p className="text-sm text-[color:var(--tx2)]">
          This page isn’t available. Activate the product from Integrations to unlock it.
        </p>
        <Link
          className="admin-button admin-button-primary mt-4 inline-flex text-xs"
          to="/integrations"
        >
          Open Integrations
        </Link>
      </div>,
    )
  }

  const Component = productPageComponents[surface.route]
  if (Component) {
    return <Component surface={surface} />
  }

  return frame(
    surface.label,
    <div className="mx-auto max-w-md px-6 py-16 text-center">
      <div
        className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl text-lg font-bold text-[color:var(--on-accent)]"
        style={{ background: 'linear-gradient(135deg,var(--accent-strong),var(--accent))' }}
      >
        {(surface.iconGlyph ?? surface.label.slice(0, 1)).toUpperCase()}
      </div>
      <h2 className="text-base font-semibold text-[color:var(--tx)]">{surface.label}</h2>
      <p className="mt-2 text-sm leading-6 text-[color:var(--tx3)]">
        This is where the {surface.label} page for {surface.productName} will appear.
      </p>
    </div>,
  )
}
