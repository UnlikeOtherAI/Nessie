import type { AgentVisibility } from '@nessie/schemas'

import { TabBar, type TabBarItem } from '../../primitives/TabBar'
import { SectionLabel } from '../../primitives/SectionLabel'
import { AgentVisibilityPill } from '../../shared/AgentVisibilityPill'

const VISIBILITY_OPTIONS: ReadonlyArray<TabBarItem<AgentVisibility>> = [
  {
    label: 'Private',
    title: 'Only you can see and message this agent',
    value: 'private',
  },
  {
    label: 'Public',
    title: 'People in your organization can find and invite this agent',
    value: 'team',
  },
]

type AgentVisibilityPickerProps = {
  onChange: (visibility: AgentVisibility) => void
  readOnly?: boolean
  value: AgentVisibility
}

export const AgentVisibilityPicker = ({
  onChange,
  readOnly = false,
  value,
}: AgentVisibilityPickerProps) => (
  <div className="grid gap-2">
    <div className="flex items-center justify-between gap-3">
      <SectionLabel size="sm">Visibility</SectionLabel>
      {readOnly ? <AgentVisibilityPill visibility={value} /> : null}
    </div>
    {readOnly ? null : (
      <TabBar
        ariaLabel="Agent visibility"
        fullWidth
        items={VISIBILITY_OPTIONS}
        onChange={onChange}
        role="radiogroup"
        value={value}
      />
    )}
    <p className="text-sm leading-6 text-[color:var(--tx2)]">
      {value === 'private'
        ? 'Private — only you can see and message this agent.'
        : 'Public — people in your organization can find it and invite it to any channel.'}
    </p>
    {readOnly ? (
      <p className="text-xs leading-5 text-[color:var(--tx3)]">
        Visibility is set when an agent is created and cannot be changed.
      </p>
    ) : null}
  </div>
)
