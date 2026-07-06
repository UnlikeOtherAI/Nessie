import { nodeThemes, sectionLabelClass } from '../../../lib/workflow-designer/constants'
import type { WorkflowCanvasNode } from '../../../lib/workflow-designer/types'
import type { ChannelRecord } from '../../../lib/api-client'

/**
 * Node inspector. Known node types edit through structured fields (channel
 * picker, prompt, cron, tool arguments); the raw JSON stays available under
 * an "Advanced" disclosure for binding expressions and unusual keys.
 * Configuration the runtime will reject (agent step without a channel, tool
 * step without its main argument) is flagged inline while designing, not
 * discovered when the run fails.
 */

type NodeSourceOption = {
  label: string
  meta?: string
  sourceId: string
}

type WorkflowNodeInspectorProps = {
  channels: ChannelRecord[]
  selectedNode?: WorkflowCanvasNode
  selectedNodeSource?: NodeSourceOption
  selectedNodeSourceOptions: NodeSourceOption[]
  selectedNodeConfigDraft: string
  selectedNodeConfigError: string | null
  selectedNodeUpstreamSteps: WorkflowCanvasNode[]
  onLabelChange: (value: string) => void
  onSourceChange: (sourceId: string) => void
  onConfigChange: (value: string) => void
  onConfigPatch: (patch: Record<string, unknown>) => void
}

const fieldLabelClass =
  'text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--tx3)]'

const inspectorInputClass =
  'w-full rounded-lg border border-black/10 bg-white px-2.5 py-1.5 text-sm text-[#433349] outline-none focus:border-[#7445c7]'

const warningClass =
  'rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-2 text-xs text-amber-800'

const readString = (config: Record<string, unknown>, key: string): string => {
  const value = config[key]
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)
}

/** Primary argument fields per workflow tool, mirroring the worker runtime. */
const TOOL_FIELDS: Record<string, Array<{ key: string; label: string; placeholder: string }>> = {
  change_detect: [
    { key: 'key', label: 'State key', placeholder: 'e.g. last-price' },
    { key: 'value', label: 'Value to compare', placeholder: '{{steps.<id>.output.result}}' },
  ],
  state_get: [{ key: 'key', label: 'State key', placeholder: 'e.g. last-price' }],
  state_put: [
    { key: 'key', label: 'State key', placeholder: 'e.g. last-price' },
    { key: 'value', label: 'Value', placeholder: '{{steps.<id>.output.result}}' },
  ],
  web_fetch: [{ key: 'url', label: 'URL', placeholder: 'https://…' }],
  web_search: [{ key: 'query', label: 'Search query', placeholder: 'what to search for' }],
}

const TextField = ({
  label,
  multiline = false,
  onChange,
  placeholder,
  value,
}: {
  label: string
  multiline?: boolean
  onChange: (value: string) => void
  placeholder?: string
  value: string
}) => (
  <label className="grid gap-1.5">
    <span className={fieldLabelClass}>{label}</span>
    {multiline ? (
      <textarea
        className={`${inspectorInputClass} min-h-24 resize-y`}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        value={value}
      />
    ) : (
      <input
        className={inspectorInputClass}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        value={value}
      />
    )}
  </label>
)

const NodeConfigFields = ({
  channels,
  config,
  node,
  onConfigPatch,
}: {
  channels: ChannelRecord[]
  config: Record<string, unknown>
  node: WorkflowCanvasNode
  onConfigPatch: (patch: Record<string, unknown>) => void
}) => {
  if (node.type === 'agent') {
    const channelId = readString(config, 'channelId')
    return (
      <div className="grid gap-3">
        <label className="grid gap-1.5">
          <span className={fieldLabelClass}>Channel</span>
          <select
            className={inspectorInputClass}
            onChange={(event) => onConfigPatch({ channelId: event.target.value })}
            value={channelId}
          >
            <option value="">Choose a channel…</option>
            {channels.map((channel) => (
              <option key={channel.id} value={channel.id}>
                {channel.label}
              </option>
            ))}
          </select>
        </label>
        {!channelId ? (
          <div className={warningClass}>
            Agent steps need a channel — the run will fail without one.
          </div>
        ) : null}
        <TextField
          label="Instruction"
          multiline
          onChange={(value) => onConfigPatch({ prompt: value })}
          placeholder="What should the agent do in this step?"
          value={readString(config, 'prompt')}
        />
        <TextField
          label="Subject (optional)"
          onChange={(value) => onConfigPatch({ subject: value })}
          placeholder="Thread subject"
          value={readString(config, 'subject')}
        />
      </div>
    )
  }

  if (node.type === 'tool') {
    const toolName = readString(config, 'toolName') || node.sourceId
    const fields = TOOL_FIELDS[toolName] ?? []
    const primaryField = fields[0]
    const missingPrimary =
      primaryField !== undefined && !readString(config, primaryField.key)
    return (
      <div className="grid gap-3">
        {fields.map((field) => (
          <TextField
            key={field.key}
            label={field.label}
            onChange={(value) => onConfigPatch({ [field.key]: value })}
            placeholder={field.placeholder}
            value={readString(config, field.key)}
          />
        ))}
        {missingPrimary && primaryField ? (
          <div className={warningClass}>
            “{primaryField.label}” is required — the run will fail without it.
          </div>
        ) : null}
      </div>
    )
  }

  const triggerType = readString(config, 'type') || node.sourceId
  if (triggerType === 'scheduled') {
    return (
      <div className="grid gap-3">
        <TextField
          label="Cron expression"
          onChange={(value) => onConfigPatch({ cron: value })}
          placeholder="0 9 * * 1-5"
          value={readString(config, 'cron')}
        />
        <TextField
          label="Timezone"
          onChange={(value) => onConfigPatch({ timezone: value })}
          placeholder="Europe/London"
          value={readString(config, 'timezone')}
        />
      </div>
    )
  }
  if (triggerType === 'interval') {
    return (
      <label className="grid gap-1.5">
        <span className={fieldLabelClass}>Every N minutes</span>
        <input
          className={inspectorInputClass}
          min={1}
          onChange={(event) => {
            const parsed = Number.parseInt(event.target.value, 10)
            onConfigPatch({
              interval_minutes: Number.isFinite(parsed) && parsed > 0 ? parsed : undefined,
            })
          }}
          type="number"
          value={
            typeof config.interval_minutes === 'number' ? config.interval_minutes : ''
          }
        />
      </label>
    )
  }
  return (
    <div className="text-xs leading-5 text-[var(--muted)]">
      {triggerType === 'webhook'
        ? 'Installing this workflow creates a webhook trigger; the endpoint and API key appear on the installation.'
        : triggerType === 'event'
          ? 'Fires on internal system events; configure event names in the advanced JSON.'
          : 'Fires only when a run is started manually.'}
    </div>
  )
}

export const WorkflowNodeInspector = ({
  channels,
  selectedNode,
  selectedNodeSource,
  selectedNodeSourceOptions,
  selectedNodeConfigDraft,
  selectedNodeConfigError,
  selectedNodeUpstreamSteps,
  onLabelChange,
  onSourceChange,
  onConfigChange,
  onConfigPatch,
}: WorkflowNodeInspectorProps) => {
  const config =
    selectedNode && typeof selectedNode.config === 'object' && selectedNode.config
      ? (selectedNode.config as Record<string, unknown>)
      : {}

  return (
    <aside className="hidden w-[352px] shrink-0 border-l border-[var(--line)] bg-[var(--surface-inverse)] lg:flex lg:flex-col">
      <div className="border-b border-[var(--line)] px-4 py-3">
        <div className={sectionLabelClass}>Node inspector</div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {selectedNode ? (
          <div className="grid gap-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-base font-semibold text-[var(--ink)]">
                  {selectedNode.label}
                </div>
                {selectedNodeSource?.meta ? (
                  <div className="mt-0.5 text-xs text-[var(--muted)]">
                    {selectedNodeSource.meta}
                  </div>
                ) : null}
              </div>
              <span
                className="rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em]"
                style={{
                  backgroundColor: nodeThemes[selectedNode.type].badgeBackground,
                  color: nodeThemes[selectedNode.type].border,
                }}
              >
                {nodeThemes[selectedNode.type].label}
              </span>
            </div>

            <label className="grid gap-1.5">
              <span className={fieldLabelClass}>Label</span>
              <input
                className={inspectorInputClass}
                onChange={(event) => onLabelChange(event.target.value)}
                value={selectedNode.label}
              />
            </label>

            <label className="grid gap-1.5">
              <span className={fieldLabelClass}>
                {selectedNode.type === 'agent'
                  ? 'Agent'
                  : selectedNode.type === 'tool'
                    ? 'Tool'
                    : 'Trigger type'}
              </span>
              <select
                className={inspectorInputClass}
                onChange={(event) => onSourceChange(event.target.value)}
                value={selectedNode.sourceId}
              >
                {selectedNodeSourceOptions.some(
                  (source) => source.sourceId === selectedNode.sourceId,
                ) ? null : (
                  <option value={selectedNode.sourceId}>
                    {selectedNode.sourceId}
                  </option>
                )}
                {selectedNodeSourceOptions.map((source) => (
                  <option key={source.sourceId} value={source.sourceId}>
                    {source.label}
                    {source.meta ? ` · ${source.meta}` : ''}
                  </option>
                ))}
              </select>
            </label>

            <NodeConfigFields
              channels={channels}
              config={config}
              node={selectedNode}
              onConfigPatch={onConfigPatch}
            />

            {selectedNodeUpstreamSteps.length > 0 ? (
              <div className="rounded-lg border border-black/10 bg-white px-3 py-2.5">
                <div className={fieldLabelClass}>Use earlier step output</div>
                <div className="mt-1.5 grid gap-1 text-xs text-[var(--muted)]">
                  {selectedNodeUpstreamSteps.map((step) => (
                    <div className="truncate" key={step.id}>
                      {step.label}:{' '}
                      <code className="text-[11px]">{`{{steps.${step.id}.output}}`}</code>
                    </div>
                  ))}
                  <div className="mt-1">
                    Paste a token into any field; it resolves when the run executes.
                  </div>
                </div>
              </div>
            ) : null}

            <details>
              <summary
                className={`cursor-pointer select-none ${fieldLabelClass} hover:text-[#433349]`}
              >
                Advanced JSON
              </summary>
              <textarea
                className={`${inspectorInputClass} mt-2 min-h-48 resize-y font-mono text-xs`}
                onChange={(event) => onConfigChange(event.target.value)}
                spellCheck={false}
                value={selectedNodeConfigDraft}
              />
              {selectedNodeConfigError ? (
                <div className="mt-1 text-xs text-[var(--danger)]">
                  {selectedNodeConfigError}
                </div>
              ) : null}
            </details>
          </div>
        ) : (
          <div className="rounded-2xl border border-dashed border-[var(--line)] px-5 py-6 text-center text-sm text-[var(--muted)]">
            Select a node to configure it.
          </div>
        )}
      </div>
    </aside>
  )
}
