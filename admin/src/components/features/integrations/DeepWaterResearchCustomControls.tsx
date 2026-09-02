import type { DeepWaterResearchDepth } from '../../../lib/api-client'
import { ChoiceGroup } from '../../shared/ChoiceGroup'
import { FormField } from '../../shared/FormField'
import { Input, Select } from '../../shared/FormControls'
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
    <ChoiceGroup
      label="Depth"
      onChange={(value) => onChange('depth', value)}
      options={depthOptions}
      value={values.depth}
    />

    <div className="grid gap-3 md:grid-cols-2">
      <FormField label="Chapter detail">
        <Select
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
        </Select>
      </FormField>
      <FormField label="Output">
        <Select
          onChange={(event) =>
            onChange('outputTier', event.target.value as DeepWaterResearchFormValues['outputTier'])
          }
          value={values.outputTier}
        >
          <option value="full">Full report</option>
          <option value="summary">Summary</option>
        </Select>
      </FormField>
      <FormField label="Search quality">
        <Select
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
        </Select>
      </FormField>
      <FormField label="Recency">
        <Select
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
        </Select>
      </FormField>
      <FormField label="Sections">
        <Input
          max={20}
          min={3}
          onChange={(event) => onChange('sections', Number(event.target.value))}
          type="number"
          value={values.sections}
        />
      </FormField>
      <FormField label="Searches per pillar">
        <Input
          max={20}
          min={1}
          onChange={(event) => onChange('searchesPerPillar', Number(event.target.value))}
          type="number"
          value={values.searchesPerPillar}
        />
      </FormField>
      <FormField label="Output language">
        <Select
          onChange={(event) => onChange('outputLanguage', event.target.value)}
          value={values.outputLanguage}
        >
          {deepWaterResearchLanguages.map((language) => (
            <option key={language.code} value={language.code}>
              {language.label} ({language.code})
            </option>
          ))}
        </Select>
      </FormField>
      <FormField label="Destination">
        <Select
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
        </Select>
      </FormField>
    </div>
  </>
)
