import type { ComponentType } from 'react'
import { DeepWaterResearchView } from './DeepWaterResearchView'

export type ProductDocumentsViewProps = { view: string }

// Registry of concrete product Documents views, keyed by the manifest
// `documents_section` view id. Slice A ships the generic host; slice C
// registers the DeepWater Research view here — reusing the existing run-history
// component + service — with no sidebar or team change required.
export const productDocumentsViewComponents: Record<
  string,
  ComponentType<ProductDocumentsViewProps>
> = {
  'deep-water-research': DeepWaterResearchView,
}
