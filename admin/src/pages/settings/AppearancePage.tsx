import { ColoursPanel } from './appearance/ColoursPanel'
import { SettingsPanel, type SettingsTabHostProps } from '../../components/shared/SettingsPanel'
import { TypePanel } from './appearance/TypePanel'

/**
 * Colours and text size are stacked rather than sub-tabbed. Appearance is
 * itself one tab of the account settings screen now, and a second tab strip
 * inside the first would both read as nesting and fight over the `tab` URL
 * parameter the parent already owns.
 */
export const AppearancePage = ({ tabs }: SettingsTabHostProps) => (
  <SettingsPanel eyebrow="User" title="Appearance">
    {tabs}
    <div className="grid gap-4">
      <ColoursPanel />
      <TypePanel />
    </div>
  </SettingsPanel>
)
