/**
 * Add a widget: pick the question, pick the source, fill the slots.
 *
 * The catalogue leads with the QUESTION each kind answers rather than its name,
 * because "what is the number now?" is how someone actually chooses, and it is
 * the same framing the agent tool descriptions use — one vocabulary whether you
 * click or ask.
 *
 * Every control here is bounded by the contract: the kind list is the closed
 * enum, the field pickers only offer columns the chosen source declares with a
 * type the slot accepts, and tone is a role rather than a colour. A person
 * cannot express a widget an agent could not, or vice versa.
 */

import { useMemo, useState } from 'react'
import type { DashboardTone, DashboardWidgetKind } from '@nessie/schemas'
import { useApiClient } from '../../../providers/ApiClientProvider'
import { useDashboardSources, type DashboardSourceRecord } from '../../../facades/dashboards/hooks'

const CATALOGUE: { kind: DashboardWidgetKind; question: string; label: string }[] = [
  { kind: 'stat', label: 'Stat', question: 'What is the number now?' },
  { kind: 'timeseries', label: 'Trend', question: 'How has it moved over time?' },
  { kind: 'bar', label: 'Breakdown', question: 'How does it split across categories?' },
  { kind: 'table', label: 'Table', question: 'What are the actual records?' },
  { kind: 'status', label: 'Status', question: 'Is it ok, warning, or failing?' },
]

const TONES: DashboardTone[] = ['neutral', 'accent', 'info', 'success', 'warning', 'danger']

type Column = { key: string; label: string; type: string }

const columnsOf = (source: DashboardSourceRecord | undefined): Column[] =>
  (source?.outputColumns as Column[] | undefined) ?? []

/** Which column types each slot will accept — the same rule the server applies. */
const numeric = (columns: Column[]) => columns.filter((column) => column.type === 'number')
const temporal = (columns: Column[]) =>
  columns.filter((column) => ['datetime', 'string', 'number'].includes(column.type))
const categorical = (columns: Column[]) =>
  columns.filter((column) => ['string', 'boolean', 'number'].includes(column.type))

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <label className="flex flex-col gap-1">
    <span className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--tx3)' }}>
      {label}
    </span>
    {children}
  </label>
)

const selectStyle = {
  background: 'var(--panel)',
  borderColor: 'var(--sep)',
  color: 'var(--tx)',
} as const

export const AddWidgetPanel = ({
  dashboardId,
  onClose,
  onAdded,
}: {
  dashboardId: string
  onClose: () => void
  onAdded: () => void
}) => {
  const client = useApiClient()
  const { data: sources } = useDashboardSources()

  const [kind, setKind] = useState<DashboardWidgetKind | null>(null)
  const [sourceId, setSourceId] = useState('')
  const [title, setTitle] = useState('')
  const [tone, setTone] = useState<DashboardTone>('neutral')
  const [primary, setPrimary] = useState('')
  const [secondary, setSecondary] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const source = useMemo(
    () => sources?.find((candidate) => candidate.id === sourceId),
    [sources, sourceId],
  )
  const columns = columnsOf(source)

  /** Builds the same definition shape an agent emits. */
  const buildDefinition = (): unknown => {
    const presentation = { title: title.trim() || 'Untitled', tone }
    const base = { schemaVersion: 1 as const, sourceId, presentation }
    switch (kind) {
      case 'stat':
        return { ...base, kind, binding: { value: primary, higherIsBetter: true } }
      case 'timeseries':
        return {
          ...base,
          kind,
          presentation: { ...presentation, legend: 'bottom' as const },
          binding: {
            x: secondary,
            series: [{ key: primary, label: columns.find((c) => c.key === primary)?.label ?? primary }],
          },
        }
      case 'bar':
        return {
          ...base,
          kind,
          binding: {
            category: secondary,
            series: [{ key: primary, label: columns.find((c) => c.key === primary)?.label ?? primary }],
          },
        }
      case 'table':
        return {
          ...base,
          kind,
          binding: {
            columns: columns.slice(0, 6).map((column) => ({ key: column.key, label: column.label })),
          },
        }
      case 'status':
        return {
          ...base,
          kind,
          binding: { state: primary, stateMap: {} },
        }
      default:
        return null
    }
  }

  const canSave = Boolean(kind && sourceId && title.trim()
    && (kind === 'table' || primary)
    && (kind !== 'timeseries' && kind !== 'bar' ? true : Boolean(secondary)))

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      await client.post(`/api/dashboards/${dashboardId}/widgets`, buildDefinition())
      onAdded()
      onClose()
    } catch (caught) {
      // The API returns a 400 naming the field, so show it rather than a
      // generic failure — the point of that error is that it is actionable.
      setError(caught instanceof Error ? caught.message : 'Could not add the widget.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <aside
      className="flex w-80 shrink-0 flex-col border-l"
      style={{ borderColor: 'var(--sep)', background: 'var(--panel)' }}
      data-testid="add-widget-panel"
    >
      <header
        className="flex items-center gap-2 border-b px-3 py-2.5"
        style={{ borderColor: 'var(--sep)' }}
      >
        <h2 className="text-sm font-semibold" style={{ color: 'var(--tx)' }}>
          Add a widget
        </h2>
        <button
          className="ml-auto rounded px-1.5 text-sm"
          onClick={onClose}
          style={{ color: 'var(--tx3)' }}
          type="button"
        >
          ✕
        </button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3">
        {!kind ? (
          <ul className="flex flex-col gap-1.5">
            {CATALOGUE.map((entry) => (
              <li key={entry.kind}>
                <button
                  className="w-full rounded border px-3 py-2 text-left"
                  onClick={() => setKind(entry.kind)}
                  style={{ borderColor: 'var(--sep)', background: 'var(--overlay-weak)' }}
                  type="button"
                  data-testid={`widget-kind-${entry.kind}`}
                >
                  <div className="text-sm font-medium" style={{ color: 'var(--tx)' }}>
                    {entry.label}
                  </div>
                  <div className="text-xs" style={{ color: 'var(--tx3)' }}>
                    {entry.question}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <>
            <button
              className="w-fit text-xs underline"
              onClick={() => setKind(null)}
              style={{ color: 'var(--tx3)' }}
              type="button"
            >
              ← choose a different kind
            </button>

            <Field label="Title">
              <input
                className="rounded border px-2 py-1.5 text-sm"
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Requests per day"
                style={selectStyle}
                value={title}
              />
            </Field>

            <Field label="Data source">
              <select
                className="rounded border px-2 py-1.5 text-sm"
                onChange={(event) => {
                  setSourceId(event.target.value)
                  setPrimary('')
                  setSecondary('')
                }}
                style={selectStyle}
                value={sourceId}
              >
                <option value="">Choose a source…</option>
                {(sources ?? []).map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </option>
                ))}
              </select>
            </Field>

            {sourceId && kind !== 'table' ? (
              <Field label={kind === 'status' ? 'State column' : 'Value'}>
                <select
                  className="rounded border px-2 py-1.5 text-sm"
                  onChange={(event) => setPrimary(event.target.value)}
                  style={selectStyle}
                  value={primary}
                >
                  <option value="">Choose a column…</option>
                  {(kind === 'status' ? categorical(columns) : numeric(columns)).map((column) => (
                    <option key={column.key} value={column.key}>
                      {column.label} ({column.type})
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}

            {sourceId && (kind === 'timeseries' || kind === 'bar') ? (
              <Field label={kind === 'timeseries' ? 'Time axis' : 'Category'}>
                <select
                  className="rounded border px-2 py-1.5 text-sm"
                  onChange={(event) => setSecondary(event.target.value)}
                  style={selectStyle}
                  value={secondary}
                >
                  <option value="">Choose a column…</option>
                  {(kind === 'timeseries' ? temporal(columns) : categorical(columns)).map((column) => (
                    <option key={column.key} value={column.key}>
                      {column.label} ({column.type})
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}

            <Field label="Tone">
              <div className="flex flex-wrap gap-1">
                {TONES.map((candidate) => (
                  <button
                    className="rounded px-2 py-1 text-[11px] capitalize"
                    key={candidate}
                    onClick={() => setTone(candidate)}
                    style={{
                      background: tone === candidate ? 'var(--accent)' : 'var(--overlay-weak)',
                      color: tone === candidate ? 'var(--on-accent, #fff)' : 'var(--tx2)',
                    }}
                    type="button"
                  >
                    {candidate}
                  </button>
                ))}
              </div>
            </Field>

            {error ? (
              <p className="text-xs" style={{ color: 'var(--danger-text)' }}>
                {error}
              </p>
            ) : null}

            <button
              className="mt-1 rounded px-3 py-1.5 text-sm font-medium disabled:opacity-50"
              disabled={!canSave || saving}
              onClick={() => void save()}
              style={{ background: 'var(--accent)', color: 'var(--on-accent, #fff)' }}
              type="button"
              data-testid="add-widget-save"
            >
              {saving ? 'Adding…' : 'Add widget'}
            </button>
          </>
        )}
      </div>
    </aside>
  )
}
