import { AppIconPanel } from './appearance/AppIconPanel'
import { ColoursPanel } from './appearance/ColoursPanel'
import { SettingsPanel } from '../../components/shared/SettingsPanel'
import { TypePanel } from './appearance/TypePanel'

/**
 * Colours and text size are stacked rather than sub-tabbed: each is one short
 * group of choices, and a page with fewer than three concerns has sections,
 * not tabs.
 */
export const AppearancePage = () => (
  <SettingsPanel eyebrow="Your settings" title="Appearance">
    <div className="grid gap-4">
      <ColoursPanel />
      <TypePanel />
      <AppIconPanel />
    </div>
  </SettingsPanel>
)
