import { Link } from 'react-router-dom'
import type { TaskSetSource } from '@nessie/schemas'
import { useKnowledgePage } from '../../../facades/knowledge/hooks'
import { FormField } from '../../shared/FormField'
import { Input, Select, Textarea } from '../../shared/FormControls'
import { TaskSetDocumentPicker } from './TaskSetDocumentPicker'
import { taskSetDocumentPath } from './presentation'

const formats: TaskSetSource['format'][] = ['csv', 'tsv', 'xlsx', 'sqlite', 'json', 'jsonl']

export const TaskSetSourceFields = ({ value, onChange, fieldsText, onFieldsTextChange }: {
  fieldsText: string
  onFieldsTextChange: (text: string) => void
  value: TaskSetSource | null
  onChange: (source: TaskSetSource | null) => void
}) => {
  const sourcePage = useKnowledgePage(value?.pageId)
  const title = sourcePage.data?.id === value?.pageId ? sourcePage.data?.title : undefined
  const selection = value?.selection ?? {}
  const setSelection = (patch: Partial<TaskSetSource['selection']>) => {
    if (value) onChange({ ...value, selection: { ...selection, ...patch } })
  }
  return (
    <div className="grid gap-4">
      <p className="text-sm text-[color:var(--tx2)]">
        Add individual tasks after creating the set, or select a file to process its records in order.
      </p>
      <TaskSetDocumentPicker label="Input file" mode="file" onSelect={({ page }) => {
        if (!page?.latestVersion) return
        const extension = page.title.split('.').pop()?.toLowerCase()
        const format = formats.find((candidate) => candidate === extension) ?? 'csv'
        onChange({ kind: 'document', pageId: page.id, versionId: page.latestVersion.id, format, selection: {} })
      }} selectedId={value?.pageId}
        selectedSpaceId={sourcePage.data?.id === value?.pageId ? sourcePage.data?.spaceId : undefined} />
      {value ? <>
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <Link className="text-[color:var(--accent)] underline" to={taskSetDocumentPath(value.pageId)}>
            {title ?? 'Open input file'}
          </Link>
          <button className="admin-button admin-button-secondary" onClick={() => onChange(null)} type="button">
            Use manual tasks
          </button>
        </div>
        <p className="text-xs text-[color:var(--tx3)]">This set uses the selected version even if the file is later edited.</p>
        <FormField label="File format">
          <Select onChange={(event) => onChange({ ...value, format: event.target.value as TaskSetSource['format'] })}
            value={value.format}>
            {formats.map((format) => <option key={format} value={format}>{format.toUpperCase()}</option>)}
          </Select>
        </FormField>
        {value.format === 'xlsx' ? <FormField help="Enter the worksheet name in the source file." label="Worksheet">
          <Input onChange={(event) => setSelection({ sheet: event.target.value || undefined })} value={selection.sheet ?? ''} />
        </FormField> : null}
        {value.format === 'sqlite' ? <FormField label="Table" required>
          <Input onChange={(event) => setSelection({ table: event.target.value || undefined })} value={selection.table ?? ''} />
        </FormField> : null}
        {value.format === 'json' ? <FormField help="Leave blank for a top-level array." label="Record path">
          <Input onChange={(event) => setSelection({ recordPath: event.target.value || undefined })}
            placeholder="companies" value={selection.recordPath ?? ''} />
        </FormField> : null}
        {['csv', 'tsv', 'xlsx'].includes(value.format) ? <FormField label="Header row"
          help="Leave blank to use the first row as field names.">
          <Input min={1} onChange={(event) => {
            setSelection({ headerRow: event.target.value ? Number(event.target.value) : undefined })
          }} type="number" value={selection.headerRow ?? ''} />
        </FormField> : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField help="Leave blank to start with the first data record." label="First row">
            <Input min={1} onChange={(event) => {
              setSelection({ firstRow: event.target.value ? Number(event.target.value) : undefined })
            }}
              type="number" value={selection.firstRow ?? ''} />
          </FormField>
          <FormField help="Leave blank to process through the end." label="Last row">
            <Input min={1} onChange={(event) => {
              setSelection({ lastRow: event.target.value ? Number(event.target.value) : undefined })
            }}
              type="number" value={selection.lastRow ?? ''} />
          </FormField>
        </div>
        <FormField help="Optional stable record identifier, such as company_id." label="Key field">
          <Input onChange={(event) => setSelection({ keyField: event.target.value || undefined })} value={selection.keyField ?? ''} />
        </FormField>
        <FormField help="One field per line: input name = source field or column number. Leave blank to include all fields."
          label="Input fields">
          <Textarea onChange={(event) => onFieldsTextChange(event.target.value)} rows={3} value={fieldsText} />
        </FormField>
      </> : <Link className="text-sm text-[color:var(--accent)] underline" to="/knowledge-base">
        Upload a source file in Documents
      </Link>}
    </div>
  )
}
