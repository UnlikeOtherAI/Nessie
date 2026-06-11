import { AgentColumnBrowser } from '../components/features/agents/AgentColumnBrowser'
import { MobileSectionHeader } from '../layouts/admin-shell/MobileSectionHeader'

export const AgentsPage = () => (
  <div className="flex h-full flex-col">
    <MobileSectionHeader title="Agents" />
    <div className="min-h-0 flex-1">
      <AgentColumnBrowser />
    </div>
  </div>
)
