import { Notice } from '../../../primitives/Notice'

/**
 * Why nothing on a built-in agent's page can be changed. A lead-in inside the
 * ordinary tabs rather than a screen of its own: the reader sees the same
 * sections everyone else sees, and is told why they are inert.
 */
export const BuiltInAgentNote = () => (
  <Notice size="sm" tone="neutral">
    <span className="font-medium text-[color:var(--tx)]">Provided by Nessie.</span>{' '}
    This agent is the same in every team and changes only when Nessie is updated, so
    nobody changes it here, organisation owners included.
  </Notice>
)
