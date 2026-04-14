import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ColumnBrowserColumn } from '../components/shared/column-browser/ColumnBrowserColumn'
import { ColumnBrowserItem } from '../components/shared/column-browser/ColumnBrowserItem'
import { ColumnBrowserViewport } from '../components/shared/column-browser/ColumnBrowserViewport'
import { StatusPill } from '../components/primitives/StatusPill'
import { useTools } from '../facades/tools/hooks'
import type { ToolDescriptor } from '../lib/api-client'

const serializeFlag = (value?: boolean) => (value ? 'Yes' : 'No')

const formatToolStatus = (tool: ToolDescriptor) => {
  if (tool.enabled === false) return 'disabled'
  if (tool.builtin) return 'builtin'
  return 'available'
}

const getToolStatusTone = (tool: ToolDescriptor) => {
  if (tool.enabled === false) return 'muted' as const
  if (tool.safe) return 'success' as const
  return 'warning' as const
}

export const ToolsPage = () => {
  const navigate = useNavigate()
  const { data: tools = [] } = useTools()
  const [selectedToolId, setSelectedToolId] = useState<string | undefined>(
    undefined,
  )

  const sortedTools = useMemo(
    () => [...tools].sort((left, right) => left.label.localeCompare(right.label)),
    [tools],
  )

  const effectiveToolId = selectedToolId ?? sortedTools[0]?.id
  const selectedTool = useMemo(
    () => sortedTools.find((tool) => tool.id === effectiveToolId),
    [effectiveToolId, sortedTools],
  )

  const columns = [
    <ColumnBrowserColumn
      headerAction={
        <button
          className="admin-button admin-button-primary"
          onClick={() => void navigate('/settings#tools')}
          type="button"
        >
          Manage tools
        </button>
      }
      key="tools"
      title="All tools"
    >
      {sortedTools.length === 0 ? (
        <div className="py-8 text-center text-sm text-[color:var(--tx3)]">
          No tools available.
        </div>
      ) : (
        <div className="grid gap-3">
          {sortedTools.map((tool) => (
            <ColumnBrowserItem
              caption={`ID ${tool.id}`}
              isSelected={tool.id === effectiveToolId}
              key={tool.id}
              meta={<StatusPill tone={getToolStatusTone(tool)}>{formatToolStatus(tool)}</StatusPill>}
              onClick={() => setSelectedToolId(tool.id)}
              subtitle={tool.handlerKind ?? (tool.safe ? 'safe tool' : 'restricted tool')}
              title={tool.label}
            >
              {tool.description}
            </ColumnBrowserItem>
          ))}
        </div>
      )}
    </ColumnBrowserColumn>,
  ]

  if (selectedTool) {
    columns.push(
      <ColumnBrowserColumn
        key={`tool-${selectedTool.id}`}
        title={selectedTool.label}
      >
        <div className="grid gap-4">
          <div className="rounded-xl border border-[color:var(--sep)] bg-black/10 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="min-w-0 flex-1 text-xl font-semibold text-white">
                {selectedTool.label}
              </h2>
              <StatusPill tone={selectedTool.safe ? 'success' : 'warning'}>
                {selectedTool.safe ? 'safe' : 'restricted'}
              </StatusPill>
            </div>
            <div className="mt-3 text-sm text-[color:var(--tx2)]">
              {selectedTool.description}
            </div>
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            {[
              ['Handler', selectedTool.handlerKind ?? 'Not specified'],
              ['Built in', serializeFlag(selectedTool.builtin)],
              ['Enabled', serializeFlag(selectedTool.enabled ?? true)],
              ['ID', selectedTool.id],
            ].map(([label, value]) => (
              <div
                className="rounded-xl border border-[color:var(--sep)] bg-black/10 p-3"
                key={label}
              >
                <div className="text-[11px] uppercase tracking-[0.16em] text-[color:var(--tx3)]">
                  {label}
                </div>
                <div className="mt-2 text-sm text-white">{value}</div>
              </div>
            ))}
          </div>
        </div>
      </ColumnBrowserColumn>,
    )
  }

  return (
    <div className="h-full w-full">
      <ColumnBrowserViewport
        activeColumn={selectedToolId && selectedTool ? 1 : 0}
        columns={columns}
      />
    </div>
  )
}
