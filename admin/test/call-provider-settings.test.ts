import assert from 'node:assert/strict'
import test from 'node:test'

import * as ReactNamespace from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { CallProviderSelect } from '../src/pages/settings/organization/CallProviderSettingsPanel.js'
import type { TeamRecord } from '../src/lib/api-client.js'

// The production Vite transform injects the JSX runtime. Node's lightweight
// tsx loader uses the classic transform for imported TSX modules.
;(globalThis as typeof globalThis & { React: typeof ReactNamespace }).React = ReactNamespace

const team: TeamRecord = {
  callProvider: 'jitsi',
  callProviderAvailability: {
    google_meet: true,
    jitsi: true,
    microsoft_teams: false,
  },
  createdAt: '2026-08-31T12:00:00.000Z',
  id: '11111111-1111-1111-1111-111111111111',
  memberCount: 2,
  name: 'Product',
  projectId: '22222222-2222-2222-2222-222222222222',
}

test('a provider missing from deployment configuration is disabled and explained', () => {
  const html = renderToStaticMarkup(
    createElement(CallProviderSelect, { disabled: false, onChange: () => undefined, team }),
  )

  assert.match(html, /Google Meet/)
  assert.match(html, /Jitsi/)
  assert.match(html, /Microsoft Teams — Microsoft Teams is not configured for this deployment\./)
  assert.match(html, /<option disabled="" value="microsoft_teams">/)
  assert.match(
    html,
    /<p class="text-xs text-\[color:var\(--tx3\)\]">Microsoft Teams is not configured for this deployment\.<\/p>/,
  )
  assert.doesNotMatch(html, /<option disabled="" value="google_meet">/)
  assert.doesNotMatch(html, /<option disabled="" value="jitsi">/)
})
