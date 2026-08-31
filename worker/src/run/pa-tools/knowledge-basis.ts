import { scopeForVisibility } from '@nessie/memory'
import type { KnowledgeSpaceRecord } from '@nessie/knowledge'
import type { BuiltinToolRuntimeContext } from '../tool-types.js'
import { subtractImpliedScopes, type BasisScope } from '../execute/disclosure-basis.js'

// The database default for `KnowledgeSpace.visibility`. The record type makes
// the field optional, so a space that did not project it is treated as what the
// column would hold rather than as unscoped.
const DEFAULT_SPACE_VISIBILITY = 'project'

/**
 * Record a knowledge-base read as run provenance.
 *
 * Recall already feeds the run's consumed-source sink, and the transcript does
 * too, but knowledge-base reads did not — so an agent could read a page from a
 * space only some people can reach, answer from it, and have the reply stamped
 * with an empty basis, which means published to the whole room. The read gate on
 * the tool decides whether the *agent* may see the page; this decides whether
 * what the agent then says is privileged.
 *
 * Ordinary spaces express their scope as `visibility` plus the tenant chain,
 * the same shape a thought's audience takes, so their resolution remains the
 * shared `scopeForVisibility` rather than a second mapping. Agent-owned spaces
 * instead record `agent:<ownerAgentId>`, whose audience is exactly the people
 * whose disclosure viewer can see that agent. The viewer carries those keys,
 * so the existing set-containment predicate understands this scope without a
 * special case.
 *
 * `privateToAgentId` remains untranslated. It is a machine-reader restriction,
 * not an audience of people; `ownerAgentId` is different because it explicitly
 * denotes the live human audience "whoever can see this agent".
 *
 * Silent when the run carries no sink — sub-agent and utility paths construct a
 * runtime context without one, and they materialise no message of their own.
 */
export const recordKnowledgeSpaceRead = (
  context: Pick<BuiltinToolRuntimeContext, 'consumedSources'>,
  spaces: readonly Pick<
    KnowledgeSpaceRecord,
    | 'organizationId'
    | 'ownerAgentId'
    | 'projectId'
    | 'teamId'
    | 'channelId'
    | 'userId'
    | 'visibility'
  >[],
): void => {
  const sink = context.consumedSources
  if (!sink || spaces.length === 0) {
    return
  }

  for (const space of spaces) {
    // A hand-enumerated mapper or partial Prisma projection can defeat a TypeScript
    // Pick through a cast. Fail loudly here: treating omission as null recreates
    // the empty-basis publication bug this bridge exists to prevent.
    if (!Object.hasOwn(space, 'ownerAgentId')) {
      throw new Error('Knowledge space disclosure projection omitted ownerAgentId.')
    }
    if (space.ownerAgentId) {
      sink.add({ scopeId: space.ownerAgentId, scopeType: 'agent' })
      continue
    }
    const scope = scopeForVisibility({
      channelId: space.channelId ?? null,
      organizationId: space.organizationId,
      projectId: space.projectId,
      teamId: space.teamId ?? null,
      userId: space.userId ?? null,
      visibility: space.visibility ?? DEFAULT_SPACE_VISIBILITY,
    })
    if (scope) {
      sink.add(scope)
    }
  }
}

/**
 * Sources a proposed agent-owned document would disclose beyond its own exact
 * audience. This intentionally does not use a channel destination: a document
 * persists independently of the room where it was written.
 */
export const sourcesOutsideAgentDocumentAudience = (
  context: Pick<BuiltinToolRuntimeContext, 'consumedSources'>,
  audience: { organizationId: string; ownerAgentId: string },
): BasisScope[] =>
  subtractImpliedScopes(
    context.consumedSources?.list() ?? [],
    [
      { scopeId: audience.ownerAgentId, scopeType: 'agent' },
      // An agent-document reader is always a live member of this organization:
      // the agent visibility predicate is organization-scoped, and autonomous
      // viewers have no live membership. Project and team are deliberately not
      // implied: an agent can be visible through another bound channel or its
      // steward, neither of which grants a particular project or team.
      { scopeId: audience.organizationId, scopeType: 'organization' },
    ],
  )
