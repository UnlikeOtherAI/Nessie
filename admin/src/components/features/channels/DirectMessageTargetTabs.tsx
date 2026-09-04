import { TabBar, type TabBarItem } from '../../primitives/TabBar'

export type DirectMessageTarget = 'people' | 'agents'

const TARGETS: ReadonlyArray<TabBarItem<DirectMessageTarget>> = [
  { label: 'People', value: 'people' },
  { label: 'Agents', value: 'agents' },
]
export const DIRECT_MESSAGE_TARGET_VALUES = TARGETS.map((target) => target.value)

type DirectMessageTargetTabsProps = {
  onChange: (target: DirectMessageTarget) => void
  value: DirectMessageTarget
}

export const DirectMessageTargetTabs = ({ onChange, value }: DirectMessageTargetTabsProps) => (
  <div className="flex-shrink-0 border-b border-[color:var(--sep)] px-[var(--page-gutter)] py-2.5">
    <div className="mx-auto w-full max-w-md">
      <TabBar
        ariaLabel="Direct message recipient type"
        fullWidth
        idPrefix="direct-message-target"
        items={TARGETS}
        onChange={onChange}
        value={value}
      />
    </div>
  </div>
)
