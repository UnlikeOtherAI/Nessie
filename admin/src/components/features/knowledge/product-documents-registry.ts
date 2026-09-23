import type { ComponentType } from 'react'
import { DeepWaterResearchView } from './DeepWaterResearchView'

export type ProductDocumentsViewProps = { view: string }

// Registry of concrete product Documents views, keyed by the manifest
// `documents_section` view id. Slice A ships the generic host; DeepWater's
// Research view is registered here — the viewer's own research list, whose rows
// are the research card's body — with no sidebar or team change required.
export const productDocumentsViewComponents: Record<
  string,
  ComponentType<ProductDocumentsViewProps>
> = {
  'deep-water-research': DeepWaterResearchView,
}
