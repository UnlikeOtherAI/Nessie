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
import {
  DASHBOARD_METRIC_ICONS,
  type DashboardMetricIcon,
  type DashboardTone,
  type DashboardWidgetKind,
} from '@nessie/schemas'
import { useApiClient } from '../../../providers/ApiClientProvider'
import { useDashboardSources, type DashboardSourceRecord } from '../../../facades/dashboards/hooks'
import { ChoiceGroup } from '../../shared/ChoiceGroup'
import { SidePanel } from '../../shared/SidePanel'
import { DASHBOARD_METRIC_ICON_LABELS } from './DashboardMetricIcon'

const CATALOGUE: { kind: DashboardWidgetKind; question: string; label: string }[] = [
  { kind: 'stat', label: 'Number card', question: 'What is the number now?' },
  { kind: 'timeseries', label: 'Trend', question: 'How has it moved over time?' },
  { kind: 'bar', label: 'Breakdown', question: 'How does it split across categories?' },
  { kind: 'donut', label: 'Composition', question: 'What share does each category make up?' },
  { kind: 'gauge', label: 'Target', question: 'How close is the current value to its target?' },
  { kind: 'scatter', label: 'Correlation', question: 'How do two measures relate?' },
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
    <span className="text-[11px] uppercase tracking-wide text-[color:var(--tx3)]">
      {label}
    </span>
    {children}
  </label>
)

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
  const [statIcon, setStatIcon] = useState<DashboardMetricIcon | ''>('')
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
        return {
          ...base,
          kind,
          binding: { value: primary, higherIsBetter: true },
          options: statIcon ? { icon: statIcon } : {},
        }
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
      case 'donut':
        return {
          ...base,
          kind,
          presentation: { ...presentation, legend: 'bottom' as const },
          binding: { category: secondary, value: primary },
        }
      case 'gauge':
        return { ...base, kind, binding: { value: primary, target: secondary } }
      case 'scatter':
        return { ...base, kind, binding: { x: secondary, y: primary } }
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
    && (!['timeseries', 'bar', 'donut', 'gauge', 'scatter'].includes(kind) || Boolean(secondary)))

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
    <SidePanel className="shrink-0" onClose={onClose} title="Add a widget">
      <div className="flex flex-col gap-3" data-testid="add-widget-panel">
        {!kind ? (
          <ul className="flex flex-col gap-1.5">
            {CATALOGUE.map((entry) => (
              <li key={entry.kind}>
                <button
                  className="w-full rounded border border-[color:var(--sep)] bg-[color:var(--overlay-weak)] px-3 py-2 text-left"
                  onClick={() => setKind(entry.kind)}
                  type="button"
                  data-testid={`widget-kind-${entry.kind}`}
                >
                  <div className="text-sm font-medium text-[color:var(--tx)]">
                    {entry.label}
                  </div>
                  <div className="text-xs text-[color:var(--tx3)]">
                    {entry.question}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <>
            <button
              className="w-fit text-xs text-[color:var(--tx3)] underline"
              onClick={() => setKind(null)}
              type="button"
            >
              ← choose a different kind
            </button>

            <Field label="Title">
              <input
                className="admin-input"
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Requests per day"
                value={title}
              />
            </Field>

            <Field label="Data source">
              <select
                className="admin-input"
                onChange={(event) => {
                  setSourceId(event.target.value)
                  setPrimary('')
                  setSecondary('')
                }}
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
              <Field label={
                kind === 'status'
                  ? 'State column'
                  : kind === 'scatter'
                    ? 'Y value'
                    : kind === 'gauge'
                      ? 'Current value'
                      : 'Value'
              }>
                <select
                  className="admin-input"
                  onChange={(event) => setPrimary(event.target.value)}
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

            {sourceId && ['timeseries', 'bar', 'donut', 'gauge', 'scatter'].includes(kind) ? (
              <Field label={
                kind === 'timeseries'
                  ? 'Time axis'
                  : kind === 'scatter'
                    ? 'X value'
                    : kind === 'gauge'
                      ? 'Target value'
                      : 'Category'
              }>
                <select
                  className="admin-input"
                  onChange={(event) => setSecondary(event.target.value)}
                  value={secondary}
                >
                  <option value="">Choose a column…</option>
                  {(kind === 'timeseries'
                    ? temporal(columns)
                    : kind === 'gauge' || kind === 'scatter'
                      ? numeric(columns)
                      : categorical(columns)).map((column) => (
                    <option key={column.key} value={column.key}>
                      {column.label} ({column.type})
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}

            {kind === 'stat' ? (
              <Field label="Card icon">
                <select
                  className="admin-input"
                  data-testid="stat-icon-select"
                  onChange={(event) => {
                    const value = event.target.value
                    setStatIcon(
                      DASHBOARD_METRIC_ICONS.includes(value as DashboardMetricIcon)
                        ? value as DashboardMetricIcon
                        : '',
                    )
                  }}
                  value={statIcon}
                >
                  <option value="">No icon</option>
                  {DASHBOARD_METRIC_ICONS.map((icon) => (
                    <option key={icon} value={icon}>
                      {DASHBOARD_METRIC_ICON_LABELS[icon]}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}

            <ChoiceGroup
              label="Tone"
              onChange={setTone}
              options={TONES.map((candidate) => ({
                label: candidate,
                value: candidate,
              }))}
              value={tone}
            />

            {error ? (
              <p className="text-xs text-[color:var(--danger-text)]">
                {error}
              </p>
            ) : null}

            <button
              className="admin-button admin-button-primary mt-1"
              disabled={!canSave || saving}
              onClick={() => void save()}
              type="button"
              data-testid="add-widget-save"
            >
              {saving ? 'Adding…' : 'Add widget'}
            </button>
          </>
        )}
      </div>
    </SidePanel>
  )
}
