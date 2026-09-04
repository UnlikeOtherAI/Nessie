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
  resolveKnowledgeSidebarSelectionPath,
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

test('Knowledge sidebar selections leave Dashboard routes on split layouts', () => {
  assert.equal(
    resolveKnowledgeSidebarSelectionPath('/dashboards', false, {
      id: 'my docs/one',
      type: 'space',
    }),
    '/knowledge-base/spaces/my%20docs%2Fone',
  )
  assert.equal(
    resolveKnowledgeSidebarSelectionPath('/dashboards/dash_a', false, {
      id: 'research',
      type: 'view',
    }),
    '/knowledge-base/views/research',
  )
  assert.equal(
    resolveKnowledgeSidebarSelectionPath('/knowledge-base', false, {
      id: 'space_a',
      type: 'space',
    }),
    null,
  )
  assert.equal(
    resolveKnowledgeSidebarSelectionPath('/knowledge-base', true, {
      id: 'space_a',
      type: 'space',
    }),
    '/knowledge-base/spaces/space_a',
  )
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
  assert.equal(getPhoneNavigationScreen('/unread-messages')?.depth, 1)
  assert.deepEqual(getPhoneNavigationBackTarget('/unread-messages'), {
    label: 'Back to Channels',
    pathname: '/channels',
  })
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
  assert.equal(getPhoneNavigationScreen('/audit')?.depth, 1)
  assert.equal(getPhoneNavigationScreen('/approvals')?.depth, 1)
  assert.equal(getPhoneNavigationScreen('/policy')?.depth, 1)
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
test('Apps is an Admin-section list, with a detail level beneath it', () => {
  assert.equal(getPhoneTabRootPath('/apps'), '/settings')
  assert.equal(getPhoneTabRootPath('/apps/deep-water'), '/settings')
  assert.equal(getPhoneNavigationScreen('/apps')?.section, 'admin')
  assert.equal(getPhoneNavigationScreen('/apps/deep-water')?.section, 'admin')
  assert.equal(getPhoneNavigationScreen('/apps')?.depth, 1)
  assert.equal(getPhoneNavigationScreen('/apps/deep-water')?.depth, 2)
  assert.deepEqual(getPhoneNavigationBackTarget('/apps'), {
    label: 'Back to Admin',
    pathname: '/settings',
  })
  assert.deepEqual(getPhoneNavigationBackTarget('/apps/deep-water'), {
    label: 'Apps',
    pathname: '/apps',
  })
  assert.equal(getPhoneNavigationDirection('/settings', '/apps'), 'forward')
  assert.equal(getPhoneNavigationDirection('/apps', '/apps/deep-water'), 'forward')
  assert.equal(getPhoneNavigationDirection('/apps/deep-water', '/apps'), 'back')
  assert.deepEqual(resolvePhoneNavigationBackAction('/apps/deep-water', '/apps'), {
    mode: 'pop',
    to: '/apps',
  })
  assert.deepEqual(resolvePhoneNavigationBackAction('/apps/deep-water', null), {
    mode: 'replace',
    to: '/apps',
  })
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
  // A predecessor in another section is where the push came from: pop.
  assert.deepEqual(
    resolvePhoneNavigationBackAction('/channels/chan_a', '/projects'),
    { mode: 'pop', to: '/projects' },
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

// Before the surface registry every route in ADMIN_ROUTE_PREFIXES collapsed
// onto one `admin:detail` key at depth 1, so nothing inside the Agents family
// animated, a sub-agent drill-in was invisible, and neither designer knew
// what it was covering.
test('the Agents family is a real stack: list depth1, agent depth2, designers as flows', () => {
  assert.equal(getPhoneNavigationScreen('/agents')?.depth, 1)
  assert.equal(getPhoneNavigationScreen('/agents/agent_a')?.depth, 2)
  assert.equal(getPhoneNavigationScreen('/agents/agent_a')?.section, 'admin')
  assert.equal(getPhoneNavigationDirection('/agents', '/agents/agent_a'), 'forward')
  assert.equal(getPhoneNavigationDirection('/agents/agent_a', '/agents'), 'back')
  assert.deepEqual(getPhoneNavigationBackTarget('/agents/agent_a'), {
    label: 'Back to Agents',
    pathname: '/agents',
  })
  // A sub-agent drill-in is the same screen identity: it swaps in place.
  assert.equal(
    getPhoneNavigationScreen('/agents/agent_a')?.key,
    getPhoneNavigationScreen('/agents/agent_child')?.key,
  )
  assert.equal(getPhoneNavigationDirection('/agents/agent_a', '/agents/agent_child'), null)

  // The four automation browsers stay beside the Agents list at depth 1.
  for (const pathname of ['/agents/workflows', '/agents/triggers', '/agents/tools', '/agents/executors']) {
    assert.equal(getPhoneNavigationScreen(pathname)?.depth, 1, pathname)
    assert.deepEqual(getPhoneNavigationBackTarget(pathname), {
      label: 'Back to Admin',
      pathname: '/settings',
    }, pathname)
  }

  // Both designers are Flows at depth 2 — pushed from the list they edit.
  assert.equal(getPhoneNavigationScreen('/agents/designer')?.depth, 2)
  assert.equal(getPhoneNavigationScreen('/agents/designer/agent_a')?.depth, 2)
  assert.equal(getPhoneNavigationDirection('/agents', '/agents/designer'), 'forward')
  assert.equal(getPhoneNavigationDirection('/agents/designer/agent_a', '/agents'), 'back')
  assert.deepEqual(getPhoneNavigationBackTarget('/agents/designer/agent_a'), {
    label: 'Back to Agents',
    pathname: '/agents',
  })
  assert.equal(getPhoneNavigationScreen('/agents/workflow-designer')?.depth, 2)
  assert.equal(
    getPhoneNavigationDirection('/agents/workflows', '/agents/workflow-designer/wt_a'),
    'forward',
  )
  assert.deepEqual(getPhoneNavigationBackTarget('/agents/workflow-designer/wt_a'), {
    label: 'Back to Workflows',
    pathname: '/agents/workflows',
  })
  // An agent detail and its designer are different screens at the same depth:
  // no transition, but not the same layer either.
  assert.notEqual(
    getPhoneNavigationScreen('/agents/agent_a')?.key,
    getPhoneNavigationScreen('/agents/designer/agent_a')?.key,
  )
})

test('the settings and ops nested details push instead of swapping in place', () => {
  assert.equal(getPhoneNavigationScreen('/settings/statuses')?.depth, 1)
  assert.equal(getPhoneNavigationScreen('/settings/statuses/status_a')?.depth, 2)
  assert.equal(
    getPhoneNavigationDirection('/settings/statuses', '/settings/statuses/status_a'),
    'forward',
  )
  assert.equal(
    getPhoneNavigationDirection('/settings/statuses/status_a', '/settings/statuses'),
    'back',
  )
  assert.deepEqual(getPhoneNavigationBackTarget('/settings/statuses/status_a'), {
    label: 'Back to Statuses',
    pathname: '/settings/statuses',
  })
  // Status A → B is a sibling swap inside one screen.
  assert.equal(
    getPhoneNavigationDirection('/settings/statuses/status_a', '/settings/statuses/status_b'),
    null,
  )

  assert.equal(getPhoneNavigationScreen('/ops')?.depth, 1)
  assert.equal(getPhoneNavigationScreen('/ops/usage')?.depth, 2)
  assert.equal(getPhoneNavigationDirection('/ops', '/ops/usage'), 'forward')
  assert.equal(getPhoneNavigationDirection('/ops/usage', '/ops'), 'back')
  // Usage is owner-only and listed on Admin; /ops is super-admin-only, so a
  // cold link falls back to Admin, and the ledger decides the real Back.
  assert.deepEqual(getPhoneNavigationBackTarget('/ops/usage'), {
    label: 'Back to Admin',
    pathname: '/settings',
  })
  assert.deepEqual(resolvePhoneNavigationBackAction('/ops/usage', '/ops'), { mode: 'pop', to: '/ops' })
})

// /threads and /unread-messages resolved to no screen at all: they rendered
// outside the phone stack, lost every retained screen beneath them, and their
// Back read "Back to Channels" whatever section the reader came from.
test('/threads and /unread-messages are Channels lists one step in from the root', () => {
  for (const pathname of ['/threads', '/unread-messages']) {
    const screen = getPhoneNavigationScreen(pathname)
    assert.equal(screen?.section, 'channels', pathname)
    assert.equal(screen?.depth, 1, pathname)
    assert.equal(getPhoneTabRootPath(pathname), '/channels', pathname)
    assert.equal(isPhoneTabRoot(pathname), false, pathname)
    assert.deepEqual(getPhoneNavigationBackTarget(pathname), {
      label: 'Back to Channels',
      pathname: '/channels',
    }, pathname)
    assert.equal(getPhoneNavigationDirection('/channels', pathname), 'forward', pathname)
    assert.equal(getPhoneNavigationDirection(pathname, '/channels'), 'back', pathname)
  }
})

// Reached from the bell, the account menu and push notifications — from any
// section — so Back returns to where the reader actually was, and only a cold
// deep link falls back to Admin, where both are listed.
test('/alerts and /feedback are Admin details whose parent is the origin', () => {
  for (const pathname of ['/alerts', '/feedback']) {
    const screen = getPhoneNavigationScreen(pathname)
    assert.equal(screen?.section, 'admin', pathname)
    assert.equal(screen?.depth, 1, pathname)
    assert.equal(getPhoneTabRootPath(pathname), '/settings', pathname)
    assert.deepEqual(getPhoneNavigationBackTarget(pathname), {
      label: 'Back to Admin',
      pathname: '/settings',
    }, pathname)
    assert.deepEqual(resolvePhoneNavigationBackAction(pathname, '/channels/chan_a?thread=t1'), {
      mode: 'pop',
      to: '/channels/chan_a',
    }, pathname)
    assert.deepEqual(resolvePhoneNavigationBackAction(pathname, null), {
      mode: 'replace',
      to: '/settings',
    }, pathname)
  }
})

test('compose is a Flow pushed over the Channels root, not a conversation', () => {
  const compose = getPhoneNavigationScreen('/channels/new')
  assert.equal(compose?.section, 'channels')
  assert.equal(compose?.depth, 1)
  assert.notEqual(compose?.key, getPhoneNavigationScreen('/channels/chan_a')?.key)
  assert.equal(getPhoneNavigationDirection('/channels', '/channels/new'), 'forward')
  assert.equal(getPhoneNavigationDirection('/channels/new', '/channels'), 'back')
  // Opening compose from a conversation is a same-depth swap, never a push.
  assert.equal(getPhoneNavigationDirection('/channels/chan_a', '/channels/new'), null)
  assert.deepEqual(getPhoneNavigationBackTarget('/channels/new'), {
    label: 'Back to Channels',
    pathname: '/channels',
  })
})

// A redirect is listed in the registry so the totality gate passes and the tab
// bar stays lit for the frame it exists — but it renders no stage, so it can
// never be a transition endpoint or a Back destination.
test('redirect-only routes classify no screen and never animate', () => {
  const redirects = [
    '/',
    '/work',
    '/chats',
    '/workflows',
    '/workflows/tools',
    '/settings/tools',
    '/settings/agents',
    '/integrations',
  ]
  for (const pathname of redirects) {
    assert.equal(getPhoneNavigationScreen(pathname), null, pathname)
    assert.equal(getPhoneNavigationBackTarget(pathname), null, pathname)
    assert.equal(phoneRouteHasBackDepth(pathname), false, pathname)
    assert.equal(isPhoneTabRoot(pathname), false, pathname)
    assert.equal(getPhoneNavigationDirection('/settings', pathname), null, pathname)
    assert.equal(getPhoneNavigationDirection(pathname, '/settings'), null, pathname)
  }
  // They still name the tab that owns them.
  assert.equal(getPhoneTabRootPath('/workflows'), '/settings')
  assert.equal(getPhoneTabRootPath('/chats'), '/channels')
  assert.equal(getPhoneTabRootPath('/work'), '/projects')
})

// The catch-all is gone: an unknown path is not an admin detail, and the
// classifier says so rather than inventing a screen for it.
test('an unknown path classifies as nothing at all', () => {
  assert.equal(getPhoneNavigationScreen('/totally/unknown'), null)
  assert.equal(getPhoneNavigationBackTarget('/totally/unknown'), null)
  assert.equal(getPhoneNavigationScreen('/login'), null)
  assert.equal(getPhoneTabRootPath('/totally/unknown'), '/channels')
})

test('a screen pushed from another section pops back to where it came from', () => {
  assert.deepEqual(
    resolvePhoneNavigationBackAction('/channels/c1', '/projects/p1'),
    { mode: 'pop', to: '/projects/p1' },
  )
  assert.deepEqual(
    resolvePhoneNavigationBackAction('/channels/c1', '/search'),
    { mode: 'pop', to: '/search' },
  )
  // Within a section the declared parent still decides.
  assert.deepEqual(
    resolvePhoneNavigationBackAction('/channels/c1', '/channels/c2'),
    { mode: 'replace', to: '/channels' },
  )
})
