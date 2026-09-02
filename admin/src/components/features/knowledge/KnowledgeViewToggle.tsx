import {
  faColumns,
  faList,
  faSitemap,
  type IconDefinition,
} from '@fortawesome/free-solid-svg-icons'

export const KNOWLEDGE_VIEW_MODES = ['full', 'column', 'tree'] as const

export type KnowledgeViewMode = (typeof KNOWLEDGE_VIEW_MODES)[number]

export const knowledgeViewOptions: Array<{
  icon: IconDefinition
  label: string
  title: string
  value: KnowledgeViewMode
}> = [
  {
    icon: faList,
    label: 'Full page',
    title: 'Show one full-width folder at a time',
    value: 'full',
  },
  {
    icon: faColumns,
    label: 'Column',
    title: 'Show folders in sliding columns',
    value: 'column',
  },
  {
    icon: faSitemap,
    label: 'Tree',
    title: 'Show the full page tree',
    value: 'tree',
  },
]

export const isKnowledgeViewMode = (value: string | null): value is KnowledgeViewMode =>
  KNOWLEDGE_VIEW_MODES.some((mode) => mode === value)
