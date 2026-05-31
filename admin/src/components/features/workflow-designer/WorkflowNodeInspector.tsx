import { nodeThemes, sectionLabelClass } from '../../../lib/workflow-designer/constants'
import type { WorkflowCanvasNode } from '../../../lib/workflow-designer/types'

type NodeSourceOption = {
  label: string
  meta?: string
  sourceId: string
}

type WorkflowNodeInspectorProps = {
  selectedNode?: WorkflowCanvasNode
  selectedNodeSource?: NodeSourceOption
  selectedNodeSourceOptions: NodeSourceOption[]
  selectedNodeConfigDraft: string
  selectedNodeConfigError: string | null
  onLabelChange: (value: string) => void
  onSourceChange: (sourceId: string) => void
  onConfigChange: (value: string) => void
}

export const WorkflowNodeInspector = ({
  selectedNode,
  selectedNodeSource,
  selectedNodeSourceOptions,
  selectedNodeConfigDraft,
  selectedNodeConfigError,
  onLabelChange,
  onSourceChange,
  onConfigChange,
}: WorkflowNodeInspectorProps) => {
  return (
    <aside className="hidden w-[352px] shrink-0 border-l border-black/8 bg-[#fbf9fd] lg:flex lg:flex-col">
      <div className="border-b border-black/8 px-4 py-3">
        <div className={sectionLabelClass}>Node inspector</div>
        <div className="mt-1 text-sm text-[#5f4e67]">
          Edit the selected trigger, tool, or agent node.
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {selectedNode ? (
          <div className="grid gap-4">
            <div className="rounded-2xl border border-black/8 bg-white p-4 shadow-[0_12px_24px_rgba(31,22,38,0.04)]">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[11px] uppercase tracking-[0.16em] text-[#8b7a93]">
                    Selected node
                  </div>
                  <div className="mt-1 text-base font-semibold text-[#2f2237]">
                    {selectedNode.label}
                  </div>
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

              <div className="mt-4 grid gap-3">
                <label className="grid gap-1.5 text-sm text-[#433349]">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8b7a93]">
                    Label
                  </span>
                  <input
                    className="admin-input"
                    onChange={(event) => onLabelChange(event.target.value)}
                    value={selectedNode.label}
                  />
                </label>

                <label className="grid gap-1.5 text-sm text-[#433349]">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8b7a93]">
                    Source
                  </span>
                  <select
                    className="admin-input"
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

                <div className="grid gap-1.5 text-sm text-[#433349]">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8b7a93]">
                    Config
                  </span>
                  <textarea
                    className="admin-input min-h-56 resize-y font-mono text-xs"
                    onChange={(event) =>
                      onConfigChange(event.target.value)
                    }
                    spellCheck={false}
                    value={selectedNodeConfigDraft}
                  />
                  {selectedNodeConfigError ? (
                    <div className="text-xs text-rose-500">
                      {selectedNodeConfigError}
                    </div>
                  ) : null}
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-black/8 bg-white p-4 shadow-[0_12px_24px_rgba(31,22,38,0.04)]">
              <div className={sectionLabelClass}>Node metadata</div>
              <div className="mt-3 grid gap-3 text-sm">
                {[
                  ['Node ID', selectedNode.id],
                  ['Source ID', selectedNode.sourceId],
                  ['Type', selectedNode.type],
                  ['Position', `${Math.round(selectedNode.x)}, ${Math.round(selectedNode.y)}`],
                ].map(([label, value]) => (
                  <div
                    className="rounded-xl border border-black/8 bg-[#faf8fc] px-3 py-2"
                    key={label}
                  >
                    <div className="text-[11px] uppercase tracking-[0.14em] text-[#8b7a93]">
                      {label}
                    </div>
                    <div className="mt-1 break-all text-[#2f2237]">{value}</div>
                  </div>
                ))}
                {selectedNodeSource ? (
                  <div className="rounded-xl border border-black/8 bg-[#faf8fc] px-3 py-2">
                    <div className="text-[11px] uppercase tracking-[0.14em] text-[#8b7a93]">
                      Resolved source
                    </div>
                    <div className="mt-1 text-[#2f2237]">{selectedNodeSource.label}</div>
                    {selectedNodeSource.meta ? (
                      <div className="mt-1 text-xs text-[#6f5b77]">
                        {selectedNodeSource.meta}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        ) : (
          <div className="rounded-2xl border border-dashed border-[#d6cbe0] bg-white px-5 py-6 text-center text-sm text-[#6f5b77]">
            Select a node to edit its source and config.
          </div>
        )}
      </div>
    </aside>
  )
}
