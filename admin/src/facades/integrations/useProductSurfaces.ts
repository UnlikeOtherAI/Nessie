import { useMemo } from 'react'
import { useQueries } from '@tanstack/react-query'
import type {
  ChatAssistantSurface,
  DocumentsSectionSurface,
  IntegratedProductResponse,
  IntegrationPluginManifest,
  ProductSurface,
  ProductSurfaceRequirement,
} from '@nessie/schemas'
import { integrationManifestKey } from '../../lib/query-keys'
import { useApiClient } from '../../providers/ApiClientProvider'
import { useIntegratedProducts } from './hooks'

// A surface resolved against a live product record, carrying the product's
// identity so the shell can render + navigate without re-joining data.
type ResolvedBase = { productSlug: string; productName: string }
export type ResolvedChatAssistantSurface = ResolvedBase &
  Omit<ChatAssistantSurface, 'type' | 'requires'>
export type ResolvedDocumentsSectionSurface = ResolvedBase &
  Omit<DocumentsSectionSurface, 'type' | 'requires'>

export type ProductSurfaceRegistry = {
  chatAssistants: ResolvedChatAssistantSurface[]
  documentsSections: ResolvedDocumentsSectionSurface[]
  isLoading: boolean
}

// Evaluate a surface's `requires` against the live product record. Every clause
// is ANDed; an omitted clause is not checked. This is the single gate that
// makes a surface appear only for an activated product.
export const meetsRequirements = (
  product: IntegratedProductResponse,
  requires: ProductSurfaceRequirement,
): boolean => {
  if (requires.linked && product.accountLink?.status !== 'linked') return false
  if (requires.teamEnabled && !product.teamEnablement?.enabled) return false
  if (requires.capability && !product.capabilities.includes(requires.capability)) return false
  if (requires.connectorActive && product.mcpInstallation?.lifecycleState !== 'active') {
    return false
  }
  return true
}

const collect = (
  products: IntegratedProductResponse[],
  manifestBySlug: Map<string, IntegrationPluginManifest>,
): Omit<ProductSurfaceRegistry, 'isLoading'> => {
  const chatAssistants: ResolvedChatAssistantSurface[] = []
  const documentsSections: ResolvedDocumentsSectionSurface[] = []

  for (const product of products) {
    const manifest = manifestBySlug.get(product.slug)
    const surfaces: ProductSurface[] = manifest?.surfaces ?? []
    for (const surface of surfaces) {
      if (!meetsRequirements(product, surface.requires)) continue
      const base = { productSlug: product.slug, productName: product.name }
      if (surface.type === 'chat_assistant') {
        chatAssistants.push({
          ...base,
          channelKind: surface.channelKind,
          productSlug: surface.productSlug,
          label: surface.label,
          iconGlyph: surface.iconGlyph,
        })
      } else {
        documentsSections.push({
          ...base,
          id: surface.id,
          label: surface.label,
          view: surface.view,
          iconGlyph: surface.iconGlyph,
        })
      }
    }
  }

  return { chatAssistants, documentsSections }
}

// The single seam the shell reads to know which product surfaces are live.
// Joins the integrated-products list (activation state) with each product's
// plugin manifest (declared surfaces), gates each surface by `requires`, and
// returns the resolved surfaces grouped by where they mount.
export const useProductSurfaces = (): ProductSurfaceRegistry => {
  const apiClient = useApiClient()
  const productsQuery = useIntegratedProducts()
  const products = useMemo(() => productsQuery.data ?? [], [productsQuery.data])

  const manifestQueries = useQueries({
    queries: products.map((product) => ({
      queryKey: integrationManifestKey(product.slug),
      queryFn: () =>
        apiClient.get<IntegrationPluginManifest>(
          `/api/integrations/products/${product.slug}/manifest`,
        ),
      staleTime: 5 * 60_000,
    })),
  })

  const manifestSignature = manifestQueries
    .map((query) => query.data?.manifestRef ?? '')
    .join('|')
  const manifestsLoading = manifestQueries.some((query) => query.isLoading)

  return useMemo(() => {
    const manifestBySlug = new Map<string, IntegrationPluginManifest>()
    for (const query of manifestQueries) {
      if (query.data) manifestBySlug.set(query.data.productSlug, query.data)
    }
    return {
      ...collect(products, manifestBySlug),
      isLoading: productsQuery.isLoading || manifestsLoading,
    }
    // Keyed on `manifestSignature` (stable manifest content) rather than the
    // per-render `manifestQueries` identity, plus the loading flags.
  }, [products, manifestSignature, manifestsLoading, productsQuery.isLoading])
}
