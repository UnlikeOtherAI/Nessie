import {
  faColumns,
  faList,
  faSitemap,
  type IconDefinition,
} from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'

export type KnowledgeViewMode = 'column' | 'full' | 'tree'

const viewOptions: Array<{
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
  value === 'full' || value === 'column' || value === 'tree'

type KnowledgeViewToggleProps = {
  mode: KnowledgeViewMode
  onChange: (mode: KnowledgeViewMode) => void
}

export const KnowledgeViewToggle = ({ mode, onChange }: KnowledgeViewToggleProps) => (
  <div
    aria-label="Knowledge view"
    className={[
      'inline-flex shrink-0 rounded-md border border-[color:var(--sep)]',
      'bg-[color:var(--overlay-weak)] p-0.5',
    ].join(' ')}
    role="group"
  >
    {viewOptions.map((option) => (
      <button
        aria-pressed={mode === option.value}
        className={[
          'flex h-8 items-center gap-1.5 rounded-[6px] px-2.5 text-xs font-medium',
          'transition-colors',
          mode === option.value
            ? 'bg-[color:var(--main)] text-[color:var(--tx)] shadow-sm'
            : 'text-[color:var(--tx3)] hover:text-[color:var(--tx)]',
        ].join(' ')}
        key={option.value}
        onClick={() => onChange(option.value)}
        title={option.title}
        type="button"
      >
        <FontAwesomeIcon className="h-3 w-3" fixedWidth icon={option.icon} />
        <span>{option.label}</span>
      </button>
    ))}
  </div>
)
