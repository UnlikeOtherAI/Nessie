import { useState } from 'react'
import { ColoursPanel } from './appearance/ColoursPanel'
import { LogoPanel } from './appearance/LogoPanel'
import { TypePanel } from './appearance/TypePanel'
import { SettingsPanel } from './settings-shared'

type AppearanceTab = 'colours' | 'type' | 'logo'

const TABS: ReadonlyArray<{ id: AppearanceTab; label: string }> = [
  { id: 'colours', label: 'Colours' },
  { id: 'type', label: 'Text size' },
  { id: 'logo', label: 'Logo' },
]

const PANELS: Record<AppearanceTab, () => React.JSX.Element> = {
  colours: ColoursPanel,
  type: TypePanel,
  logo: LogoPanel,
}

export const AppearancePage = () => {
  const [activeTab, setActiveTab] = useState<AppearanceTab>('colours')
  const ActivePanel = PANELS[activeTab]

  return (
    <SettingsPanel eyebrow="General" title="Appearance">
      <div className="-mt-1 mb-4 flex items-center border-b border-[color:var(--sep)]">
        {TABS.map((tab) => (
          <button
            className={`admin-tab ${activeTab === tab.id ? 'active' : ''}`}
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            type="button"
          >
            {tab.label}
          </button>
        ))}
      </div>

      <ActivePanel />
    </SettingsPanel>
  )
}
