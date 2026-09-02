import { CloudBrowserPanel } from '../../components/features/browser-cloud/CloudBrowserPanel'
import { MyBrowserLoginsPanel } from '../../components/features/browser-cloud/MyBrowserLoginsPanel'
import { SettingsPanel, type SettingsTabHostProps } from './settings-shared'

/**
 * What your agents may use on your behalf. The cloud browser lives here rather
 * than under Connected accounts because it is not an account you connect — it
 * is a capability your agents borrow, and the logins it holds are yours.
 */
export const UserAgentsPage = ({ tabs }: SettingsTabHostProps) => (
  <SettingsPanel eyebrow="Account" title="Agents">
    {tabs}
    <div className="grid gap-4">
      <CloudBrowserPanel scope="user" />
      <MyBrowserLoginsPanel />
    </div>
  </SettingsPanel>
)
