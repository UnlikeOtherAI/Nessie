import { useState } from 'react'
import { TabBar } from '../../components/primitives/TabBar'
import { ColoursPanel } from './appearance/ColoursPanel'
import { TypePanel } from './appearance/TypePanel'
import { SettingsPanel } from './settings-shared'

type AppearanceTab = 'colours' | 'type'

const TABS: ReadonlyArray<{ label: string; value: AppearanceTab }> = [
  { label: 'Colours', value: 'colours' },
  { label: 'Text size', value: 'type' },
]

const PANELS: Record<AppearanceTab, () => React.JSX.Element> = {
  colours: ColoursPanel,
  type: TypePanel,
}

export const AppearancePage = () => {
  const [activeTab, setActiveTab] = useState<AppearanceTab>('colours')
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
