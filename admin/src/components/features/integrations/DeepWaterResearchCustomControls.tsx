import type { DeepWaterResearchDepth } from '../../../lib/api-client'
import {
  deepWaterResearchLanguages,
  type DeepWaterResearchFormValues,
} from './deep-water-research-options'

const depthOptions: Array<{ label: string; value: DeepWaterResearchDepth }> = [
  { label: 'Light', value: 'light' },
  { label: 'Standard', value: 'standard' },
  { label: 'Deep', value: 'deep' },
  { label: 'Heavy', value: 'heavy' },
  { label: 'Thesis', value: 'thesis' },
  { label: 'Dissertation', value: 'dissertation' },
]

type DeepWaterResearchCustomControlsProps = {
  onChange: <Key extends keyof DeepWaterResearchFormValues>(
    key: Key,
    value: DeepWaterResearchFormValues[Key],
  ) => void
  values: DeepWaterResearchFormValues
}

/**
 * Every control the launcher has ever offered, unchanged, shown only under
 * Custom. Split out of the launcher so the preset path stays readable and so
 * the multi-select search-language control has one obvious home once Ledger's
 * MCP `research_start` accepts a typed `languages` set (today it accepts only
 * query, context, depth, and recency, so a language *set* would be a control
 * for something the API cannot receive).
 */
export const DeepWaterResearchCustomControls = ({
  onChange,
  values,
}: DeepWaterResearchCustomControlsProps) => (
  <>
    <div>
      <div className="mb-2 text-sm font-semibold text-[var(--tx2)]">Depth</div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {depthOptions.map((option) => (
          <button
            aria-pressed={values.depth === option.value}
            className={[
              'h-9 rounded border px-2 text-xs font-semibold',
              values.depth === option.value
                ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--thinking)]'
                : 'border-[var(--sep)] text-[var(--tx2)] hover:bg-[var(--overlay)]',
            ].join(' ')}
            key={option.value}
            onClick={() => onChange('depth', option.value)}
            type="button"
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>

    <div className="grid gap-3 md:grid-cols-2">
      <label className="grid gap-1 text-sm">
        <span className="font-semibold text-[var(--tx2)]">Chapter detail</span>
        <select
          className="admin-input"
          onChange={(event) =>
            onChange(
              'chapterDepth',
              event.target.value as DeepWaterResearchFormValues['chapterDepth'],
            )
          }
          value={values.chapterDepth}
        >
          <option value="brief">Brief</option>
          <option value="standard">Standard</option>
          <option value="detailed">Detailed</option>
          <option value="exhaustive">Exhaustive</option>
        </select>
      </label>
      <label className="grid gap-1 text-sm">
        <span className="font-semibold text-[var(--tx2)]">Output</span>
        <select
          className="admin-input"
          onChange={(event) =>
            onChange('outputTier', event.target.value as DeepWaterResearchFormValues['outputTier'])
          }
          value={values.outputTier}
        >
          <option value="full">Full report</option>
          <option value="summary">Summary</option>
        </select>
      </label>
      <label className="grid gap-1 text-sm">
        <span className="font-semibold text-[var(--tx2)]">Search quality</span>
        <select
          className="admin-input"
          onChange={(event) =>
            onChange(
              'searchQuality',
              event.target.value as DeepWaterResearchFormValues['searchQuality'],
            )
          }
          value={values.searchQuality}
        >
          <option value="standard">Standard</option>
          <option value="premium">Premium</option>
        </select>
      </label>
      <label className="grid gap-1 text-sm">
        <span className="font-semibold text-[var(--tx2)]">Recency</span>
        <select
          className="admin-input"
          onChange={(event) =>
            onChange('recency', event.target.value as DeepWaterResearchFormValues['recency'])
          }
          value={values.recency}
        >
          <option value="any">Any time</option>
          <option value="day">Last day</option>
          <option value="week">Last week</option>
          <option value="month">Last month</option>
          <option value="year">Last year</option>
        </select>
      </label>
      <label className="grid gap-1 text-sm">
        <span className="font-semibold text-[var(--tx2)]">Sections</span>
        <input
          className="admin-input"
          max={20}
          min={3}
          onChange={(event) => onChange('sections', Number(event.target.value))}
          type="number"
          value={values.sections}
        />
      </label>
      <label className="grid gap-1 text-sm">
        <span className="font-semibold text-[var(--tx2)]">Searches per pillar</span>
        <input
          className="admin-input"
          max={20}
          min={1}
          onChange={(event) => onChange('searchesPerPillar', Number(event.target.value))}
          type="number"
          value={values.searchesPerPillar}
        />
      </label>
      <label className="grid gap-1 text-sm">
        <span className="font-semibold text-[var(--tx2)]">Output language</span>
        <select
          className="admin-input"
          onChange={(event) => onChange('outputLanguage', event.target.value)}
          value={values.outputLanguage}
        >
          {deepWaterResearchLanguages.map((language) => (
            <option key={language.code} value={language.code}>
              {language.label} ({language.code})
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-sm">
        <span className="font-semibold text-[var(--tx2)]">Destination</span>
        <select
          className="admin-input"
          onChange={(event) =>
            onChange(
              'artifactDestination',
              event.target.value as DeepWaterResearchFormValues['artifactDestination'],
            )
          }
          value={values.artifactDestination}
        >
          <option value="knowledge_draft">Knowledge draft</option>
          <option value="chat_only">Chat only</option>
        </select>
      </label>
    </div>
  </>
)
