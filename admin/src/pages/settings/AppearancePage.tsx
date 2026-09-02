import { TabBar } from '../../components/primitives/TabBar'
import { useTabParam } from '../../navigation/useTabParam'
import { ColoursPanel } from './appearance/ColoursPanel'
import { TypePanel } from './appearance/TypePanel'
import { SettingsPanel } from './settings-shared'

const APPEARANCE_TABS = ['colours', 'type'] as const

type AppearanceTab = (typeof APPEARANCE_TABS)[number]

const TABS: ReadonlyArray<{ label: string; value: AppearanceTab }> = [
  { label: 'Colours', value: 'colours' },
  { label: 'Text size', value: 'type' },
]

const PANELS: Record<AppearanceTab, () => React.JSX.Element> = {
  colours: ColoursPanel,
  type: TypePanel,
}

export const AppearancePage = () => {
  const [activeTab, setActiveTab] = useTabParam('tab', APPEARANCE_TABS, 'colours')
  const ActivePanel = PANELS[activeTab]

  return (
    <SettingsPanel eyebrow="Account" title="Appearance">
      <div className="-mt-1 mb-4 flex items-center">
        <TabBar
          ariaLabel="Appearance sections"
          items={TABS}
          onChange={setActiveTab}
          value={activeTab}
        />
      </div>

      <ActivePanel />
    </SettingsPanel>
  )
}
