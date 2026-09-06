import { CloudBrowserPanel } from '../../components/features/browser-cloud/CloudBrowserPanel'
import { MyBrowserLoginsPanel } from '../../components/features/browser-cloud/MyBrowserLoginsPanel'
import { SettingsPanel, type SettingsTabHostProps } from '../../components/shared/SettingsPanel'
import { useAuthSession } from '../../providers/AuthSessionProvider'

/**
 * What your agents may use on your behalf. The cloud browser lives here rather
 * than under Connected accounts because it is not an account you connect — it
 * is a capability your agents borrow, and the logins it holds are yours.
 *
 * The session's team is passed down so a lock set by the team — not only one
 * set by the organisation — greys the control and says so. Without it the
 * cascade's middle level would be invisible here, and a person could connect
 * an account their team's work would then never use.
 */
export const UserAgentsPage = ({ tabs }: SettingsTabHostProps) => {
  const { me } = useAuthSession()

  return (
    <SettingsPanel eyebrow="User" title="Agents">
      {tabs}
      <div className="grid gap-4">
        <CloudBrowserPanel scope="user" teamId={me?.context.teamId ?? null} />
        <MyBrowserLoginsPanel />
      </div>
    </SettingsPanel>
  )
}
