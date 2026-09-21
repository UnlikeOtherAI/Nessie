import type { TaskSetOutput } from '@nessie/schemas'
import { FormField } from '../../shared/FormField'
import { Select, Textarea } from '../../shared/FormControls'
import { TaskSetDocumentPicker } from './TaskSetDocumentPicker'

export const TaskSetOutputFields = ({ value, onChange, columnsText, onColumnsTextChange }: {
  columnsText: string
  onColumnsTextChange: (text: string) => void
  value: TaskSetOutput
  onChange: (output: TaskSetOutput) => void
}) => (
  <div className="grid gap-4">
    <FormField label="Save results as">
      <Select onChange={(event) => {
        const kind = event.target.value
        if (kind === 'journal') onChange({ kind })
        if (kind === 'documents') onChange({ kind, spaceId: '', format: 'text' })
        if (kind === 'spreadsheet') onChange({ kind, spaceId: '', fields: {} })
      }} value={value.kind}>
        <option value="journal">Results in this task set</option>
        <option value="documents">Files in Documents</option>
        <option value="spreadsheet">A new Excel spreadsheet</option>
      </Select>
    </FormField>
    {value.kind !== 'journal' ? <TaskSetDocumentPicker label="Output folder" mode="folder"
      onSelect={({ spaceId, page }) => onChange({ ...value, spaceId, parentId: page?.id })}
      selectedId={value.parentId} selectedSpaceId={value.spaceId} /> : null}
    {value.kind === 'documents' ? <FormField label="File format">
      <Select onChange={(event) => onChange({ ...value, format: event.target.value as 'text' | 'jsonl' })}
        value={value.format}>
        <option value="text">Text</option>
        <option value="jsonl">JSON Lines</option>
      </Select>
    </FormField> : null}
    {value.kind === 'spreadsheet' ? <FormField help="One output column per line: column name = result field. The processor must return these fields."
      label="Result columns">
      <Textarea onChange={(event) => onColumnsTextChange(event.target.value)}
        placeholder={'Summary = summary\nWebsite = website'} rows={4} value={columnsText} />
    </FormField> : null}
    <p className="text-xs text-[color:var(--tx3)]">
      Each result is retained here before it is saved to the destination.
    </p>
  </div>
)
