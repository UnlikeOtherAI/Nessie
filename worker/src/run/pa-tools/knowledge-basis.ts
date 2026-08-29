import { scopeForVisibility } from '@nessie/memory'
import type { KnowledgeSpaceRecord } from '@nessie/knowledge'
import type { BuiltinToolRuntimeContext } from '../tool-types.js'

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
 * A space expresses its scope as `visibility` plus the tenant chain, the same
 * shape a thought's audience takes, so the resolution is the shared
 * `scopeForVisibility` rather than a second mapping. `privateToAgentId` is
 * deliberately not translated into a scope: the basis vocabulary describes
 * audiences of people, the per-agent restriction is enforced by the tool's own
 * read gate, and inventing a scope type the disclosure predicate does not
 * understand would be worse than the gap it closes.
 *
 * Silent when the run carries no sink — sub-agent and utility paths construct a
 * runtime context without one, and they materialise no message of their own.
 */
export const recordKnowledgeSpaceRead = (
  context: Pick<BuiltinToolRuntimeContext, 'consumedSources'>,
  spaces: readonly Pick<
    KnowledgeSpaceRecord,
    'organizationId' | 'projectId' | 'teamId' | 'channelId' | 'userId' | 'visibility'
  >[],
): void => {
  const sink = context.consumedSources
  if (!sink || spaces.length === 0) {
    return
  }

  for (const space of spaces) {
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
