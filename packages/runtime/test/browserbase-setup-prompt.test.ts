import assert from 'node:assert/strict'
import test from 'node:test'

import { buildBrowserbaseSetupPrompt } from '../src/index.js'

test('browser login requests describe the bounded personal-access grant', () => {
  const prompt = buildBrowserbaseSetupPrompt({
    hasBrowserLoginRequestTool: true,
    hasCardTool: true,
  })

  assert.match(prompt, /Only `browser_login_request` can request temporary personal browser access/)
  assert.match(prompt, /exact selected HTTPS origins for one task/)
  assert.match(prompt, /expires within fifteen minutes/)
  assert.match(prompt, /fresh browser with no saved context/)
  assert.match(prompt, /owner-private agent home or a system agent's exact personal home/)
  assert.match(prompt, /card_post` card or chat text cannot grant browser access/)
})

test('a missing login-request tool cannot be replaced by a generic card', () => {
  const prompt = buildBrowserbaseSetupPrompt({ hasCardTool: true })

  assert.match(prompt, /`browser_login_request` is not in your toolset/)
  assert.match(prompt, /enable `browser_login_request` at Admin › Advanced › Tool registry/)
  assert.match(prompt, /\(`\/admin\/advanced\/tools`\)/)
  assert.doesNotMatch(prompt, /\/agents\/tools/)
  assert.match(prompt, /Do not substitute card_post, prose, or a fabricated permission card/)
})

// Where the prompt sent people before the admin moved: a personal account's
// page, the organisation's page and the tool list. They resolve to nothing, so
// one printed beside the current address would still send a person nowhere.
const RETIRED_SETUP_ADDRESSES = [
  /\/settings\/account\?tab=agents/,
  /\/settings\/organization\?tab=agents/,
  /\/agents\/tools/,
]

test('every variant names the current setup pages and none of the retired addresses', () => {
  const variants = [
    { hasCardTool: false },
    { hasCardTool: true },
    { hasBrowserLoginRequestTool: true, hasCardTool: true },
    { canGrantBrowserTools: true, hasCardTool: true },
    { canGrantBrowserTools: true, hasCardTool: true, ownToolsetFixed: true },
    { hasCardTool: true, ownToolsetFixed: true },
  ]
  for (const facts of variants) {
    const prompt = buildBrowserbaseSetupPrompt(facts)
    const label = JSON.stringify(facts)
    assert.match(prompt, /Your settings › Connected accounts › Browsers \(`\/settings\/accounts\?tab=browsers`\)/, label)
    assert.match(prompt, /Admin › Company connections \(`\/admin\/connections`\)/, label)
    for (const retired of RETIRED_SETUP_ADDRESSES) assert.doesNotMatch(prompt, retired, label)
  }
})

test('service keys use the personal secret form before reveal', () => {
  const withCard = buildBrowserbaseSetupPrompt({ hasCardTool: true })
  assert.match(withCard, /Before a website reveals a service-issued API key, pause/)
  assert.match(withCard, /existing personal `vault_secret` form/)
  assert.match(withCard, /only an opaque secret handle/)
  assert.match(withCard, /does not revoke the service-issued key/)

  const withoutCard = buildBrowserbaseSetupPrompt({ hasCardTool: false })
  assert.match(withoutCard, /Never ask for or receive a service-issued API key in chat/)
})

test('an agent holding the grant verb is not told to send owners to the Access tab', () => {
  // The Agent Designer quoted this exact sentence back to an owner while
  // holding `agent_tool_access_set` for the agent it had just built.
  const prompt = buildBrowserbaseSetupPrompt({
    canGrantBrowserTools: true,
    hasCardTool: true,
  })

  assert.match(prompt, /you grant to the named agent with `agent_tool_access_set`/)
  assert.match(prompt, /refused unless the person asking is an organisation owner/)
  // The account connection is a masked credential the person supplies; that
  // half never became the agent's to do.
  assert.match(prompt, /account connection is theirs to make/)
  assert.doesNotMatch(prompt, /An owner must explicitly grant the named agent the browser tools/)
})

test('without the grant verb the owner surface stays the only truthful path', () => {
  const prompt = buildBrowserbaseSetupPrompt({ hasCardTool: true })

  assert.match(prompt, /An owner must explicitly grant the named agent the browser tools/)
  assert.doesNotMatch(prompt, /you grant to the named agent with `agent_tool_access_set`/)
})

test('a grant never waits for the account', () => {
  // "Just set up the permissions, I'll add the tokens later" was refused:
  // the grant is written by `setAgentToolPolicyForRegistryEntry`, which never
  // reads a Browserbase connection; only USING a browser needs one.
  const prompt = buildBrowserbaseSetupPrompt({ canGrantBrowserTools: true, hasCardTool: true })
  assert.match(prompt, /The grant does not wait for the account/)
  assert.match(prompt, /they work the moment an account is connected/)
})

test('an agent whose toolset is fixed is not sent to enable a tool on itself', () => {
  // The Designer quoted "the owner must enable `browser_login_request` at
  // the Tool registry" — about its OWN toolset, which no owner can change — to a
  // person asking about the agent it was building.
  const fixed = buildBrowserbaseSetupPrompt({
    canGrantBrowserTools: true,
    hasCardTool: true,
    ownToolsetFixed: true,
  })
  assert.match(fixed, /not yours to request/)
  assert.match(fixed, /your toolset is fixed by the deployment, so nobody can enable it for you/)
  assert.match(
    fixed,
    /For an agent a person builds it is an ordinary browser tool, granted with `agent_tool_access_set`/,
  )
  assert.doesNotMatch(fixed, /enable `browser_login_request` at Admin › Advanced › Tool registry/)
  assert.match(fixed, /Do not substitute card_post, prose, or a fabricated permission card/)

  // The Personal Assistant: same fixed toolset, no grant verb of its own.
  const assistant = buildBrowserbaseSetupPrompt({ hasCardTool: true, ownToolsetFixed: true })
  assert.match(assistant, /granted from that agent's Access tab like the rest/)
  assert.doesNotMatch(assistant, /enable `browser_login_request` at Admin › Advanced › Tool registry/)

  // An ordinary agent's owner CAN enable it, so that door is still named.
  const ordinary = buildBrowserbaseSetupPrompt({ hasCardTool: true })
  assert.match(ordinary, /enable `browser_login_request` at Admin › Advanced › Tool registry/)
})
