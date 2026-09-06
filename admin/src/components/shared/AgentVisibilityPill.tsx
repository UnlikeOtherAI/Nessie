import { faLock } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import type { AgentVisibility } from '@nessie/schemas'

import { Pill } from '../primitives/Pill'

type Props = {
  visibility: AgentVisibility
}

export const agentVisibilityLabel = (visibility: AgentVisibility): 'Private' | 'Public' =>
  visibility === 'private' ? 'Private' : 'Public'

/** Text fallback for native selects, which cannot render the shared pill. */
export const agentSelectionLabel = (name: string, visibility: AgentVisibility): string =>
  `${name} — ${agentVisibilityLabel(visibility)}`

/** One visual identity marker everywhere an agent is selected by a person. */
export const AgentVisibilityPill = ({ visibility }: Props) => (
  <Pill radius="chip" size="sm" uppercase={false}>
    {visibility === 'private' ? (
      <FontAwesomeIcon className="mr-1" icon={faLock} />
    ) : null}
    {agentVisibilityLabel(visibility)}
  </Pill>
)
