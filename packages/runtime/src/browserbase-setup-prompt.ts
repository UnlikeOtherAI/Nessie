/**
 * Server-authored facts for any agent that may need a cloud browser. Whether
 * the current work benefits from one is deliberately the model's judgement;
 * this only states the truthful setup and authorization path.
 */
export type BrowserbaseSetupPromptFacts = {
  hasCardTool: boolean
  hasAccountConnectionsTool?: boolean
  hasBrowserLoginRequestTool?: boolean
  /**
   * True when this agent holds `agent_tool_access_set`, which grants another
   * agent the browser tools with the requesting person's own authority. Without
   * it the owner surface is the only truthful path; with it, sending an owner
   * to Agents → Tools is a refusal to do work the agent is holding the tool
   * for. It never covers this agent's own toolset, which the deployment fixes.
   */
  canGrantBrowserTools?: boolean
  /**
   * True for a global specialist such as Agent Designer, whose toolset the
   * deployment fixes: nobody, owners included,
   * can add `browser_login_request` to it, so "the owner must enable it at
   * Agents → Tools" is a door that does not exist. The Designer relayed that
   * sentence about ITS OWN toolset to a person asking about the agent it was
   * building, for which the tool is an ordinary grant.
   */
  ownToolsetFixed?: boolean
}

const loginRequestLine = (facts: BrowserbaseSetupPromptFacts): string => {
  if (facts.hasBrowserLoginRequestTool) {
    return 'Only `browser_login_request` can request temporary personal browser access. It names exact selected '
      + 'HTTPS origins for one task, expires within fifteen minutes, and is available only in an owner-private '
      + 'agent home or a system agent\'s exact personal home. It opens a fresh browser with no saved context; '
      + 'a person may sign in privately, including through identity-provider redirects, but that never widens '
      + 'the agent\'s approved origins.'
  }
  if (facts.ownToolsetFixed) {
    return 'Temporary personal browser access is not yours to request: `browser_login_request` is not in your '
      + 'toolset, and your toolset is fixed by the deployment, so nobody can enable it for you. For an agent a '
      + 'person builds it is an ordinary browser tool, '
      + (facts.canGrantBrowserTools
        ? 'granted with `agent_tool_access_set` like the rest. '
        : 'granted from that agent\'s Tools tab like the rest. ')
      + 'Do not substitute card_post, prose, or a fabricated permission card.'
  }
  return 'Temporary personal browser access is unavailable because `browser_login_request` is not in your toolset. '
    + 'Explain that the owner must explicitly enable `browser_login_request` at Agents → Tools '
    + '(`/agents/tools`). Do not substitute card_post, prose, or a fabricated permission card.'
}

export const buildBrowserbaseSetupPrompt = (facts: BrowserbaseSetupPromptFacts): string => [
  'Cloud browser setup:',
  facts.hasAccountConnectionsTool
    ? 'Before saying Browserbase or a personal model plan is missing, call `account_connections_list`. '
      + 'It reads saved accounts and health, including team Browserbase connections and personal Kimi plans. '
      + 'Do not infer connection state from your toolset, a connector search, or an earlier conversation. '
      + 'An unreadable inventory is unknown, never proof that nothing is linked. '
      + 'For a linked model plan, acknowledge it and ask whether to use it on the ordinary agent they own '
      + 'unless they already chose it. The Personal Assistant hands model changes to Agent Designer.'
    : 'Your browser toolset does not tell you whether an account is connected. '
      + 'Without an account-status read, say you cannot check instead of claiming no account exists.',
  'When an account is already connected, acknowledge its scope and offer to grant the named agent '
    + 'the browser tools if the person has not agreed yet. An accepted design containing browsing '
    + 'already authorizes that grant; do not ask again. Never ask them to enter a saved key again. '
    + 'A connection needing attention needs repair, not another tool grant. A team connection applies '
    + 'to that team; discovering it does not promise it will power a run in another team.',

  'If a cloud browser would materially help the work, explain that it uses a Browserbase account. '
    + 'A saved private browser context and a temporary personal browser grant are separate: never attach '
    + 'a person\'s sign-in to a shared or team agent browser.',
  'For a personal Browserbase account, go to Settings → Agents (`/settings/account?tab=agents`). '
    + 'An owner can set up a shared organisation account at Settings → Organization → Agents '
    + '(`/settings/organization?tab=agents`). Do not send people to Apps.',
  facts.hasCardTool
    ? 'You can ask for a Browserbase API key only through a masked card secret field with '
      + '`destination.kind` `browserbase_connection`; never ask for it in prose or receive it yourself. '
      + 'Keep that internal destination name out of user-facing text.'
    : 'You cannot collect a Browserbase API key in this conversation because card_post is unavailable. '
      + 'Explain the Browserbase setup path without claiming you can submit it here.',
  loginRequestLine(facts),
  'A `card_post` card or chat text cannot grant browser access or stand in for `browser_login_request`.',
  facts.hasCardTool
    ? 'Before a website reveals a service-issued API key, pause and use the existing personal '
      + '`vault_secret` form. The person copies it into the masked form; the resumed run receives only an opaque '
      + 'secret handle. Ending browser access does not revoke the service-issued key.'
    : 'Never ask for or receive a service-issued API key in chat. Without card_post, explain that the existing '
      + 'personal secret form is required before the key is revealed.',
  facts.canGrantBrowserTools
    ? 'A Browserbase account connection is separate from cloud-browser access for an agent. '
      + 'A missing account connection is theirs to make through the masked card or settings surface above; the browser tools '
      + 'themselves you grant to the named agent with `agent_tool_access_set`, which is refused '
      + 'unless the person asking is an organisation owner. The grant does not wait for the account: '
      + 'grant the tools now and they work the moment an account is connected — say so, rather than '
      + 'holding the agent back for a key. Do not send an owner to Agents → Tools '
      + 'for that grant, and never claim it is done before the tool returns.'
    : 'A Browserbase account connection is separate from cloud-browser access for an agent. '
      + 'An owner must explicitly grant the named agent the browser tools at Agents → Tools '
      + '(`/agents/tools`); the Personal Assistant can offer an `agent_handoff` to Agent Designer '
      + 'to arrange the grant, including for the Personal Assistant itself. '
      + 'Never enable or imply that grant yourself.',
].join('\n')
