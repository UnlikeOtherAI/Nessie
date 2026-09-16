import { useMemo } from 'react'

import { useAgentIdentityLookup } from '../../providers/AgentIdentityProvider'
import { useUsers } from '../../facades/users/hooks'

/**
 * Who did this, in words.
 *
 * The two governance surfaces — `/approvals` ("which agent is asking") and
 * `/audit` ("which agent did this") — were the only screens in the admin that
 * answered with an id. Approvals printed `Agent: a0000000` and the audit log
 * `agent:a0000000 → email_message`, while the roster, the agents table, the
 * channel agent panel and the chat feed all showed the agent's name. An
 * unreadable id defeats the one thing both screens exist for, so the name is
 * resolved here, once, for both.
 *
 * Two hazards this is written around:
 *
 * - `GET /api/agents` deliberately omits system-managed agents, so an
 *   `agentMap` built from it leaves the Personal Assistant — the agent almost
 *   every person talks to — unnamed. Agents resolve through
 *   {@link useAgentIdentityLookup}, the directory that exists for exactly that
 *   hole, and never through a second list of the admin's own.
 * - An agent or a person may have been deleted since the row was written. The
 *   id is the fallback, never a blank or a generic "Agent": an audit row whose
 *   actor cannot be named must still say *which* actor it was.
 */

/** The `AuditLog.actorType` vocabulary. Approvals only ever ask about `agent`. */
export type ActorKind = 'user' | 'agent' | 'service' | 'system'

/**
 * The word printed beside the name. A name alone cannot tell the person who
 * approved something from the agent that asked for it, and accountability is
 * the whole point of both screens. `user` reads as "person": the audit log is
 * about people and agents, not about rows in a users table.
 */
const KIND_WORDS: Record<string, string> = {
  agent: 'agent',
  service: 'service',
  system: 'system',
  user: 'person',
}

/** An `actorType` the client does not know yet still describes itself. */
export const actorKindWord = (actorType: string): string => KIND_WORDS[actorType] ?? actorType

export type ResolvedActor = {
  /** The exact id, for the `title`. The trail's value depends on reaching it. */
  id: string
  /** The raw `actorType`, verbatim. */
  kind: string
  /** What to print: a display name, or the short id when nothing can name it. */
  name: string
  /** False when no directory could name this actor — a deleted agent, a stale row. */
  named: boolean
}

export type ResolveActor = (actorType: string, actorId: string) => ResolvedActor

/** The first eight characters — what both screens showed for every actor. */
export const shortId = (id: string): string => id.slice(0, 8)

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Resolves an audit or approval actor to a name.
 *
 * `people` is false for a screen with no human actors on it: `/approvals`
 * names agents only, and must not fetch the organisation roster to do it.
 */
export const useActorNames = ({ people = true }: { people?: boolean } = {}): ResolveActor => {
  const lookupAgent = useAgentIdentityLookup()
  const { data: users } = useUsers(people)

  return useMemo(() => {
    const peopleById = new Map((users ?? []).map((user) => [user.id, user.displayName]))

    return (actorType, actorId) => {
      const found = (name: string): ResolvedActor => ({
        id: actorId,
        kind: actorType,
        name,
        named: true,
      })

      if (actorType === 'user') {
        const displayName = peopleById.get(actorId)
        if (displayName) return found(displayName)
      } else {
        const agent = lookupAgent(actorId)
        if (agent) return found(agent.name)
        // A service actor is frequently an agent wearing a different hat —
        // inbound agent email writes `service` with the agent's own id — and a
        // person's id reaches the same rows through the knowledge-base service
        // actor. Ask both directories before giving up on the id.
        const displayName = peopleById.get(actorId)
        if (displayName) return found(displayName)
        // `system` and `service` rows are also written by named components
        // ('automatic-membership', 'public'). Those ids are already the answer.
        if (!UUID.test(actorId)) return found(actorId)
      }

      return { id: actorId, kind: actorType, name: shortId(actorId), named: false }
    }
  }, [lookupAgent, users])
}

/**
 * One actor, named. The exact id stays on the element's `title` whether or not
 * a directory could name it, so an audit row can always be tied to its subject.
 */
export const ActorName = ({ actor }: { actor: ResolvedActor }) => (
  <span title={`${actor.kind} ${actor.id}`}>
    {/* The name carries the row; the kind word stays in the subtitle's own
        muted tone so "Sales Assistant" reads first and "agent" qualifies it. */}
    <span className="text-[color:var(--tx2)]">{actor.name}</span>
    {` · ${actorKindWord(actor.kind)}`}
  </span>
)
