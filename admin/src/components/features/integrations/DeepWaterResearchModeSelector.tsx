import {
  deepWaterResearchModes,
  type DeepWaterResearchMode,
} from './deep-water-research-options'

type DeepWaterResearchModeSelectorProps = {
  mode: DeepWaterResearchMode
  onSelect: (mode: DeepWaterResearchMode) => void
}

// Not `ChoiceGroup`'s `card` variant: that renders one description line, and
// this needs a summary plus a separate detail line — a real second field
// `ChoiceGroup`'s `ChoiceOption` does not carry. Flagged as a kit gap rather
// than forced into a shape it does not fit.
const cardClass = (selected: boolean): string => [
  'flex h-full flex-col gap-1 rounded-[var(--radius-md)] border px-3 py-2 text-left transition-colors',
  selected
    ? 'border-[color:var(--accent)] bg-[color:var(--accent-soft)]'
    : 'border-[color:var(--sep)] hover:bg-[color:var(--overlay)]',
].join(' ')

const labelClass = (selected: boolean): string => [
  'text-sm font-semibold',
  selected ? 'text-[color:var(--thinking)]' : 'text-[color:var(--tx)]',
].join(' ')

/**
 * The one decision most launches need: how much research to buy. Each preset
 * states what it assumes, so a person can choose without opening anything;
 * Custom is the escape hatch that reveals the full control set.
 */
export const DeepWaterResearchModeSelector = ({
  mode,
  onSelect,
}: DeepWaterResearchModeSelectorProps) => (
  <div>
    <div className="mb-2 text-sm font-semibold text-[color:var(--tx2)]">Research depth</div>
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
      {deepWaterResearchModes.map((option) => (
        <button
          aria-pressed={mode === option.id}
          className={cardClass(mode === option.id)}
          key={option.id}
          onClick={() => onSelect(option.id)}
          type="button"
        >
          <span className={labelClass(mode === option.id)}>{option.label}</span>
          <span className="text-xs leading-5 text-[color:var(--tx2)]">{option.summary}</span>
          <span className="mt-auto text-[11px] leading-4 text-[color:var(--tx3)]">{option.detail}</span>
        </button>
      ))}
      <button
        aria-pressed={mode === 'custom'}
        className={cardClass(mode === 'custom')}
        onClick={() => onSelect('custom')}
        type="button"
      >
        <span className={labelClass(mode === 'custom')}>Custom</span>
        <span className="text-xs leading-5 text-[color:var(--tx2)]">Set every option yourself.</span>
        <span className="mt-auto text-[11px] leading-4 text-[color:var(--tx3)]">
          Depth, chapters, sources, output, destination
        </span>
      </button>
    </div>
  </div>
)
