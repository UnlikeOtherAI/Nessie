import type { ComponentType } from 'react'
import type { ResolvedNavPageSurface } from '../../../facades/integrations/useProductSurfaces'

export type ProductPageProps = { surface: ResolvedNavPageSurface }

// Registry of concrete product pages, keyed by the manifest `nav_page` route.
// Slice A ships the generic host + registry with no concrete pages yet; slice B
// registers the DeepSignal Signals page here (e.g. `'/signals': SignalsPage`)
// with no router or shell change required. Until a route is registered the host
// renders a placeholder so the plumbing is testable now.
export const productPageComponents: Record<string, ComponentType<ProductPageProps>> = {}
