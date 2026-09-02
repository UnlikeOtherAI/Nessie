import { AgentsList } from '../components/features/agents/AgentsList'

// The Agents root's header is the list's own `ScreenHeader` — the section
// title, the scope tabs and the create action are one header, not a phone-only
// section bar over a hero. That pairing used to render two `h1`s on a phone.
export const AgentsPage = () => (
  <div className="flex h-full flex-col">
    <AgentsList />
  </div>
)
