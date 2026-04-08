import type { ToolDescriptor } from '../../lib/api-client'
import { StatusPill } from '../primitives/StatusPill'

type ToolRowProps = {
  tool: ToolDescriptor
}

export const ToolRow = ({ tool }: ToolRowProps) => (
  <div className="rounded-[1.35rem] border border-[color:var(--line)] bg-white/75 p-4">
    <div className="flex items-center justify-between gap-3">
      <div className="font-medium">{tool.label}</div>
      <StatusPill tone={tool.safe ? 'success' : 'warning'}>
        {tool.safe ? 'safe' : 'restricted'}
      </StatusPill>
    </div>
    <div className="mt-2 text-sm leading-6 text-[color:var(--muted)]">{tool.description}</div>
    <div className="mt-3 font-mono text-xs text-[color:var(--muted)]">{tool.id}</div>
  </div>
)
