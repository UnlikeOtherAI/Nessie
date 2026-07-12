import type { ComponentType } from 'react'
import type { ResolvedNavPageSurface } from '../../../facades/integrations/useProductSurfaces'
import { SignalsPage } from '../../../pages/SignalsPage'

export type ProductPageProps = { surface: ResolvedNavPageSurface }

// Registry of concrete product pages, keyed by the manifest `nav_page` route.
// Slice A ships the generic host + registry; slice B registers the DeepSignal
// Signals page here, so the generic `ProductPageHost` renders it for `/signals`
// with no router or shell change. A route with no entry falls back to the host's
// gated placeholder.
export const productPageComponents: Record<string, ComponentType<ProductPageProps>> = {
  '/signals': SignalsPage,
}
