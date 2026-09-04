import type { AgentVisibility } from '@nessie/schemas'

import { AgentVisibilityPicker } from '../agents/AgentVisibilityPicker'

type DirectMessageAgentCreatorProps = {
  onContinue: () => void
  onVisibilityChange: (visibility: AgentVisibility) => void
  visibility: AgentVisibility
}

export const DirectMessageAgentCreator = ({
  onContinue,
  onVisibilityChange,
  visibility,
}: DirectMessageAgentCreatorProps) => (
  <section
    aria-labelledby="new-agent-heading"
    className="mb-5 grid gap-4 border-b border-[color:var(--sep)] pb-5"
  >
    <div>
      <h2 className="text-base font-semibold text-[color:var(--tx)]" id="new-agent-heading">
        Create a new agent
      </h2>
      <p className="mt-1 text-sm text-[color:var(--tx3)]">
        Choose who can reach it, then continue to the Agent Designer.
      </p>
    </div>
    <AgentVisibilityPicker onChange={onVisibilityChange} value={visibility} />
    <div>
      <button className="admin-button admin-button-primary" onClick={onContinue} type="button">
        Continue to Agent Designer
      </button>
    </div>
  </section>
)
