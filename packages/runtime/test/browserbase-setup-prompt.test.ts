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
  assert.match(prompt, /enable `browser_login_request` at Agents → Tools/)
  assert.match(prompt, /Do not substitute card_post, prose, or a fabricated permission card/)
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
