/**
 * Server-authored facts for any agent that may need a cloud browser. Whether
 * the current work benefits from one is deliberately the model's judgement;
 * this only states the truthful setup and authorization path.
 */
export const buildBrowserbaseSetupPrompt = (facts: { hasCardTool: boolean }): string => [
  'Cloud browser setup:',
  'If a cloud browser would materially help the work, explain that it uses a Browserbase account. '
    + 'Do not invent website-password storage or an allowlist: a person signs in in the controlled browser.',
  'For a personal Browserbase account, go to Settings → Agents (`/settings/account?tab=agents`). '
    + 'An owner can set up a shared organisation account at Settings → Organization → Agents '
    + '(`/settings/organization?tab=agents`). Do not send people to Apps or Integrations.',
  facts.hasCardTool
    ? 'You can ask for a Browserbase API key only through a masked card secret field with '
      + '`destination.kind` `browserbase_connection`; never ask for it in prose or receive it yourself. '
      + 'Keep that internal destination name out of user-facing text.'
    : 'You cannot collect a Browserbase API key in this conversation because card_post is unavailable. '
      + 'Explain the Browserbase setup path without claiming you can submit it here.',
  'A Browserbase account connection is separate from cloud-browser access for an agent. '
    + 'An owner must explicitly grant the named agent the browser tools at Agents → Tools '
    + '(`/agents/tools`); '
    + 'never enable or imply that grant yourself.',
].join('\n')
