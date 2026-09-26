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

/** New agent's two ways in, as the header's one strip. */
export const AgentCreationModeTabs = ({
  onChange,
  value,
}: AgentCreationModeTabsProps) => (
  <TabBar
    ariaLabel="Agent creation method"
    idPrefix="agent-creation-mode"
    items={CREATION_MODES}
    onChange={onChange}
    value={value}
  />
)
