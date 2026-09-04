import { containsDetectedSecret } from '@nessie/schemas'

export class AgentSecretInputError extends Error {
  override readonly name = 'AgentSecretInputError'
}

type AgentPromptInput = {
  name?: string | null
  role?: string | null
  speakingStyle?: string | null
  systemPrompt?: string | null
}

/** Refuse secret-shaped configuration before it can become durable or model input. */
export const assertAgentSecretFreeInput = (input: AgentPromptInput): void => {
  if (
    [input.name, input.role, input.speakingStyle, input.systemPrompt]
      .some((value) => typeof value === 'string' && containsDetectedSecret(value))
  ) {
    throw new AgentSecretInputError(
      'Remove the secret from the agent configuration and save it through Secrets instead.',
    )
  }
}
