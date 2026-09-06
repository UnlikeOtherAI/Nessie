import assert from 'node:assert/strict'
import test from 'node:test'

import { ADMIN_NAV } from '../src/layouts/admin-shell/AdminSidebarNav.js'
import {
  NAV_ITEMS,
  activeNavSection,
  matchesAdminRoute,
} from '../src/navigation/nav-items.js'

test('integrations is no longer a top-level rail item', () => {
  assert.equal(NAV_ITEMS.some((item) => item.id === 'integrations'), false)
})

test('integrations is available from settings and selects the admin rail', () => {
  const integrationsItem = ADMIN_NAV
    .flatMap((group) => group.items)
    .find((item) => item.path === '/settings/integrations')

  assert.equal(integrationsItem?.label, 'Integrations')
  assert.equal(matchesAdminRoute('/settings/integrations'), true)
  assert.equal(activeNavSection('/settings/integrations'), 'admin')
})
