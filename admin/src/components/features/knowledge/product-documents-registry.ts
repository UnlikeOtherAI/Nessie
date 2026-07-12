import type { ComponentType } from 'react'

export type ProductDocumentsViewProps = { view: string }

// Registry of concrete product Documents views, keyed by the manifest
// `documents_section` view id. Slice A ships the generic host with no concrete
// views; slice C registers the DeepWater Research view here (e.g.
// `'deep-water-research': ResearchView`) — reusing the existing run-history
// component + service — with no sidebar or workspace change required.
export const productDocumentsViewComponents: Record<
  string,
  ComponentType<ProductDocumentsViewProps>
> = {}
