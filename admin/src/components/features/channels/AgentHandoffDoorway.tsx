import { Link } from 'react-router-dom'
import {
  AgentHandoffDoorwayMetadataSchema,
  type AgentHandoffDoorwayMetadata,
} from '@nessie/schemas'

const readDoorway = (
  metadata: Record<string, unknown> | undefined,
): AgentHandoffDoorwayMetadata | null => {
  const parsed = AgentHandoffDoorwayMetadataSchema.safeParse(metadata?.agentHandoffDoorway)
  return parsed.success ? parsed.data : null
}

/**
 * The way back into a conversation an agent handed to a specialist.
 *
 * Deliberately a navigation affordance on an ordinary message rather than an
 * interactive card: card `link` blocks require an absolute https URL, card
 * actions carry no navigation at all, and a pressable card belonging to a run
 * that has ended would re-enter the wake machinery. The metadata is
 * server-authored (the `documentRef` precedent — never written from model
 * output), so the destination is a real DM the viewer is the only member of.
 */
export const AgentHandoffDoorway = ({
  metadata,
}: {
  metadata: Record<string, unknown> | undefined
}) => {
  const doorway = readDoorway(metadata)
  if (!doorway) {
    return null
  }

  return (
    <div className="mt-2">
      <Link
        className={[
          'inline-flex max-w-full items-center gap-2 rounded-lg border border-[color:var(--sep)]',
          'bg-[var(--overlay-weak)] px-3 py-1.5 text-xs text-[color:var(--tx2)]',
          'transition-colors hover:bg-[color:var(--main-hover)]',
        ].join(' ')}
        data-testid="agent-handoff-doorway"
        to={`/channels/${encodeURIComponent(doorway.channelId)}`}
      >
        <span aria-hidden="true">↪</span>
        <span className="min-w-0 truncate font-semibold text-[var(--tx)]">
          {doorway.targetName}
        </span>
        <span className="flex-shrink-0 text-[color:var(--tx3)]">Continue there</span>
      </Link>
    </div>
  )
}
