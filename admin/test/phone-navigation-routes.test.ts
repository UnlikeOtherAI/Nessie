import assert from 'node:assert/strict'
import test from 'node:test'
import {
  getPhoneNavigationBackTarget,
  getPhoneNavigationDirection,
  getPhoneNavigationScreen,
  getPhoneTabRootPath,
  isPhoneTabRoot,
  phoneRouteHasBackDepth,
  phoneTabRootHasContextualList,
  resolvePhoneNavigationBackAction,
} from '../src/layouts/admin-shell/phone-navigation'

test('URL state never changes the semantic route: search/hash normalize away', () => {
  assert.equal(isPhoneTabRoot('/channels?filter=unread#list'), true)
  assert.equal(isPhoneTabRoot('/search?query=nessie'), true)
  assert.deepEqual(getPhoneNavigationBackTarget('/channels/chan_a?thread=t1'), {
    label: 'Back to Channels',
    pathname: '/channels',
  })
  assert.equal(phoneRouteHasBackDepth('/projects/proj_a?tab=board'), true)
})

test('tab roots are exactly the depth-0 roots; Search has no contextual list', () => {
  assert.deepEqual(
    ['/channels', '/projects', '/knowledge-base', '/settings', '/search'].map(isPhoneTabRoot),
    [true, true, true, true, true],
  )
  // /dashboards is a Knowledge detail, not a tab root.
  assert.equal(isPhoneTabRoot('/dashboards'), false)
  assert.equal(phoneTabRootHasContextualList('/channels'), true)
  assert.equal(phoneTabRootHasContextualList('/projects'), true)
  assert.equal(phoneTabRootHasContextualList('/knowledge-base'), true)
  assert.equal(phoneTabRootHasContextualList('/settings'), true)
  assert.equal(phoneTabRootHasContextualList('/search'), false)
  assert.equal(phoneTabRootHasContextualList('/dashboards'), false)
})

test('Knowledge routes: root depth0, spaces and views depth1', () => {
  assert.equal(getPhoneNavigationScreen('/knowledge-base')?.depth, 0)
  assert.equal(getPhoneNavigationScreen('/knowledge-base/spaces/space_a')?.depth, 1)
  assert.equal(getPhoneNavigationScreen('/knowledge-base/views/view_a')?.depth, 1)
  assert.deepEqual(getPhoneNavigationBackTarget('/knowledge-base/spaces/space_a'), {
    label: 'Back to Knowledge',
    pathname: '/knowledge-base',
  })
  assert.deepEqual(getPhoneNavigationBackTarget('/knowledge-base/views/view_a'), {
    label: 'Back to Knowledge',
    pathname: '/knowledge-base',
  })
})

test('Dashboards are Knowledge-section pages: root depth1, dashboard depth2', () => {
  const root = getPhoneNavigationScreen('/dashboards')
  assert.equal(root?.section, 'knowledge')
  assert.equal(root?.depth, 1)
  assert.deepEqual(getPhoneNavigationBackTarget('/dashboards'), {
    label: 'Back to Knowledge',
    pathname: '/knowledge-base',
  })
  const detail = getPhoneNavigationScreen('/dashboards/dash_a')
  assert.equal(detail?.section, 'knowledge')
  assert.equal(detail?.depth, 2)
  assert.deepEqual(getPhoneNavigationBackTarget('/dashboards/dash_a'), {
    label: 'Back to Dashboards',
    pathname: '/dashboards',
  })
  // The tab that owns every dashboard route is Knowledge.
  assert.equal(getPhoneTabRootPath('/dashboards'), '/knowledge-base')
  assert.equal(getPhoneTabRootPath('/dashboards/dash_a'), '/knowledge-base')
  // Entering Dashboards from Knowledge animates forward; entering a dashboard
  // animates forward from /dashboards and back down to it.
  assert.equal(getPhoneNavigationDirection('/knowledge-base', '/dashboards'), 'forward')
  assert.equal(getPhoneNavigationDirection('/dashboards', '/dashboards/dash_a'), 'forward')
  assert.equal(getPhoneNavigationDirection('/dashboards/dash_a', '/dashboards'), 'back')
})

test('the channel stack gives a reply thread its own screen depth', () => {
  assert.equal(getPhoneNavigationScreen('/channels/chan_a')?.depth, 1)
  assert.equal(
    getPhoneNavigationScreen('/channels/chan_a/threads/thread_a/replies/message_a')?.depth,
    2,
  )
  assert.equal(getPhoneNavigationScreen('/channels/chan_a/info')?.depth, 2)
  assert.equal(getPhoneNavigationScreen('/channels/chan_a/info/members')?.depth, 3)
  assert.equal(getPhoneNavigationScreen('/channels/chan_a/info/members/add')?.depth, 4)
  assert.deepEqual(getPhoneNavigationBackTarget('/channels/chan_a/info'), {
    label: 'Back to conversation',
    pathname: '/channels/chan_a',
  })
  assert.deepEqual(
    getPhoneNavigationBackTarget('/channels/chan_a/threads/thread_a/replies/message_a'),
    {
      label: 'Back to conversation',
      pathname: '/channels/chan_a',
    },
  )
  assert.deepEqual(getPhoneNavigationBackTarget('/channels/chan_a/info/members'), {
    label: 'Back to channel info',
    pathname: '/channels/chan_a/info',
  })
  assert.deepEqual(getPhoneNavigationBackTarget('/channels/chan_a/info/members/add'), {
    label: 'Back to members',
    pathname: '/channels/chan_a/info/members',
  })
  // Each step deeper animates; stepping back reverses.
  assert.equal(
    getPhoneNavigationDirection(
      '/channels/chan_a',
      '/channels/chan_a/threads/thread_a/replies/message_a',
    ),
    'forward',
  )
  assert.equal(
    getPhoneNavigationDirection(
      '/channels/chan_a/threads/thread_a/replies/message_a',
      '/channels/chan_a',
    ),
    'back',
  )
  assert.equal(getPhoneNavigationDirection('/channels/chan_a', '/channels/chan_a/info'), 'forward')
  assert.equal(getPhoneNavigationDirection('/channels/chan_a/info/members/add', '/channels/chan_a/info/members'), 'back')
  assert.equal(getPhoneNavigationDirection('/channels', '/channels/projects/proj_a'), 'forward')
  assert.equal(getPhoneNavigationScreen('/channels/projects/proj_a')?.depth, 1)
})

test('same project tab or sibling item at the same semantic key/depth never animates', () => {
  // The whole channel stack of one channel is one screen identity…
  const conversation = getPhoneNavigationScreen('/channels/chan_a')
  const addMembers = getPhoneNavigationScreen('/channels/chan_a/info/members/add')
  assert.equal(conversation?.key, addMembers?.key)
  // …shared with sibling channels: switching channels swaps content in place.
  assert.equal(conversation?.key, getPhoneNavigationScreen('/channels/chan_b')?.key)
  // Same-depth siblings inside that screen have no direction: no animation.
  assert.equal(getPhoneNavigationDirection('/channels/chan_a', '/channels/chan_b'), null)
  assert.equal(
    getPhoneNavigationDirection('/channels/chan_a/info', '/channels/chan_b/info'),
    null,
  )

  // Project tabs are one screen: board → docs → settings never animates.
  const board = getPhoneNavigationScreen('/projects/proj_a/board')
  assert.equal(board?.key, getPhoneNavigationScreen('/projects/proj_a/docs')?.key)
  assert.equal(board?.key, getPhoneNavigationScreen('/projects/proj_a/settings')?.key)
  assert.equal(getPhoneNavigationDirection('/projects/proj_a/board', '/projects/proj_a/docs'), null)
  // And sibling projects share the identity too.
  assert.equal(board?.key, getPhoneNavigationScreen('/projects/proj_b')?.key)

  // Knowledge spaces keep one identity across spaces; views are per-view.
  const spaceA = getPhoneNavigationScreen('/knowledge-base/spaces/space_a')
  assert.equal(spaceA?.key, getPhoneNavigationScreen('/knowledge-base/spaces/space_b')?.key)
  assert.notEqual(
    getPhoneNavigationScreen('/knowledge-base/views/view_a')?.key,
    getPhoneNavigationScreen('/knowledge-base/views/view_b')?.key,
  )
  // A space ↔ view switch is same-depth: still no route transition.
  assert.equal(
    getPhoneNavigationDirection('/knowledge-base/spaces/space_a', '/knowledge-base/views/view_a'),
    null,
  )
})

test('projects: root depth0 and the project (all tabs) depth1', () => {
  assert.equal(getPhoneNavigationScreen('/projects')?.depth, 0)
  assert.equal(getPhoneNavigationScreen('/projects/proj_a')?.depth, 1)
  assert.equal(getPhoneNavigationScreen('/projects/proj_a/executors')?.depth, 1)
  assert.deepEqual(getPhoneNavigationBackTarget('/projects/proj_a/backlog'), {
    label: 'Back to Projects',
    pathname: '/projects',
  })
})

test('admin: /settings depth0 and every admin page depth1 under it', () => {
  assert.equal(getPhoneNavigationScreen('/settings')?.depth, 0)
  assert.equal(isPhoneTabRoot('/settings'), true)
  assert.equal(getPhoneNavigationScreen('/settings/members')?.depth, 1)
  assert.equal(getPhoneNavigationScreen('/tokens')?.depth, 1)
  assert.equal(getPhoneNavigationScreen('/workflows/wf_a')?.depth, 1)
  assert.deepEqual(getPhoneNavigationBackTarget('/agents'), {
    label: 'Back to Admin',
    pathname: '/settings',
  })
  assert.deepEqual(getPhoneNavigationBackTarget('/settings/security'), {
    label: 'Back to Admin',
    pathname: '/settings',
  })
  assert.equal(getPhoneTabRootPath('/ops/usage'), '/settings')
  // Admin details share one screen identity, so A → B never animates.
  assert.equal(
    getPhoneNavigationScreen('/settings/members')?.key,
    getPhoneNavigationScreen('/tokens')?.key,
  )
  assert.equal(getPhoneNavigationDirection('/settings/members', '/tokens'), null)
  assert.equal(getPhoneNavigationDirection('/settings', '/settings/members'), 'forward')
})

// Apps shipped as a route and a sidebar entry but was left out of
// ADMIN_ROUTE_PREFIXES, so every admin-section question about it fell through
// to the Channels default: the phone tab bar lit Channels while you stood on
// Apps, and Back offered "Back to Channels".
test('Apps belongs to the Admin tab, list and detail alike', () => {
  assert.equal(getPhoneTabRootPath('/apps'), '/settings')
  assert.equal(getPhoneTabRootPath('/apps/deep-water'), '/settings')
  assert.equal(getPhoneNavigationScreen('/apps')?.section, 'admin')
  assert.equal(getPhoneNavigationScreen('/apps/deep-water')?.section, 'admin')
  assert.deepEqual(getPhoneNavigationBackTarget('/apps'), {
    label: 'Back to Admin',
    pathname: '/settings',
  })
  // An app detail is another admin detail, so opening one from the list is a
  // content swap rather than a route-level transition.
  assert.equal(getPhoneNavigationDirection('/apps', '/apps/deep-water'), null)
  // /approvals must not be swallowed by the /apps prefix.
  assert.equal(getPhoneTabRootPath('/approvals'), '/settings')
  assert.equal(getPhoneNavigationScreen('/approvals')?.section, 'admin')
})

test('the provider-independent Back decision: pop a parent, replace otherwise', () => {
  // Parent behind → pop (the ledger unwinds real history).
  assert.deepEqual(
    resolvePhoneNavigationBackAction('/channels/chan_a', '/channels?filter=unread'),
    { mode: 'pop', to: '/channels' },
  )
  assert.deepEqual(
    resolvePhoneNavigationBackAction('/channels/chan_a/info', '/channels/chan_a?thread=t1'),
    { mode: 'pop', to: '/channels/chan_a' },
  )
  assert.deepEqual(
    resolvePhoneNavigationBackAction('/dashboards/dash_a', '/dashboards'),
    { mode: 'pop', to: '/dashboards' },
  )
  // Foreign or missing predecessor → cold-deep-link replace.
  assert.deepEqual(
    resolvePhoneNavigationBackAction('/channels/chan_a', '/projects'),
    { mode: 'replace', to: '/channels' },
  )
  assert.deepEqual(
    resolvePhoneNavigationBackAction('/dashboards/dash_a', '/knowledge-base'),
    { mode: 'replace', to: '/dashboards' },
  )
  assert.deepEqual(
    resolvePhoneNavigationBackAction('/channels/chan_a', null),
    { mode: 'replace', to: '/channels' },
  )
  // Roots have no Back.
  assert.equal(resolvePhoneNavigationBackAction('/channels', '/channels/chan_a'), null)
  assert.equal(resolvePhoneNavigationBackAction('/search', null), null)
  assert.equal(resolvePhoneNavigationBackAction('/knowledge-base', null), null)
})

test('depth changes animate; cross-section switches do not', () => {
  assert.equal(getPhoneNavigationDirection('/channels', '/channels/chan_a'), 'forward')
  assert.equal(getPhoneNavigationDirection('/channels/chan_a', '/channels'), 'back')
  assert.equal(getPhoneNavigationDirection('/channels', '/projects'), null)
  assert.equal(getPhoneNavigationDirection('/channels/chan_a', '/knowledge-base/spaces/s1'), null)
  // Unknown routes have no screen and never animate.
  assert.equal(getPhoneNavigationDirection('/channels', '/totally/unknown'), null)
})
