import type { AgentAccessScope } from '@prisma/client'

/**
 * The scope gate.
 *
 * Scopes exist so a person lending an agent their account can lend a slice of
 * it. They only ever narrow: a tool that passes this check still runs against
 * the same service functions the HTTP routes call, with the same authorization,
 * so the granting human's own entitlements remain the ceiling.
 *
 * A missing scope is reported as a refusal the agent can act on — it names the
 * scope to ask for — rather than as an empty result, which would read as
 * "there is nothing there".
 */
export class McpScopeError extends Error {
  constructor(readonly required: AgentAccessScope) {
    super(
      `This agent credential does not carry the \`${required}\` scope. `
      + 'Ask the person who approved it to re-pair with that scope granted.',
    )
    this.name = 'McpScopeError'
  }
}

export const requireScope = (
  held: AgentAccessScope[],
  required: AgentAccessScope,
): void => {
  if (!held.includes(required)) {
    throw new McpScopeError(required)
  }
}
