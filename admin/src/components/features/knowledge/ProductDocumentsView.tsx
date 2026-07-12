import { useProductSurfaces } from '../../../facades/integrations/useProductSurfaces'
import { KnowledgePane } from './KnowledgePane'
import { productDocumentsViewComponents } from './product-documents-registry'

// Generic host for product `documents_section` surfaces selected in the
// Knowledge sidebar. Renders the concrete product view once a slice registers
// it in product-documents-registry; until then a placeholder proves the
// selection + mount are wired and gated on live activation.
export const ProductDocumentsView = ({ view }: { view: string }) => {
  const { documentsSections } = useProductSurfaces()
  const surface = documentsSections.find((section) => section.view === view)
  const Component = productDocumentsViewComponents[view]

  if (Component) {
    return <Component view={view} />
  }

  const label = surface?.label ?? 'Product view'
  return (
    <KnowledgePane title={label}>
      <div className="mx-auto max-w-md px-6 py-16 text-center">
        <p className="text-sm leading-6 text-[color:var(--tx3)]">
          This is where the {label} view
          {surface ? ` for ${surface.productName}` : ''} will appear.
        </p>
      </div>
    </KnowledgePane>
  )
}
