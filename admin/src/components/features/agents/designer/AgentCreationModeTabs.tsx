import { TabBar, type TabBarItem } from '../../../primitives/TabBar'

export type CreationMode = 'create' | 'configure'

const CREATION_MODES: ReadonlyArray<TabBarItem<CreationMode>> = [
  {
    label: 'Create',
    title: 'Describe the agent and let the Agent Designer build the draft',
    value: 'create',
  },
  {
    label: 'Configure',
    title: 'Set every agent option yourself',
    value: 'configure',
  },
]

export const CREATION_MODE_VALUES = CREATION_MODES.map((mode) => mode.value)

type AgentCreationModeTabsProps = {
  onChange: (mode: CreationMode) => void
  value: CreationMode
}

export const AgentCreationModeTabs = ({
  onChange,
  value,
}: AgentCreationModeTabsProps) => (
  <div className="flex-shrink-0 border-b border-[color:var(--sep)] px-[var(--page-gutter)] py-2.5">
    <div className="mx-auto w-full max-w-md">
      <TabBar
        ariaLabel="Agent creation method"
        fullWidth
        idPrefix="agent-creation-mode"
        items={CREATION_MODES}
        onChange={onChange}
        value={value}
      />
    </div>
  </div>
)
