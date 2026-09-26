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
} from '../src/navigation/phone-navigation'

test('URL state never changes the semantic route: search/hash normalize away', () => {
  assert.equal(isPhoneTabRoot('/channels?filter=unread#list'), true)
  assert.equal(isPhoneTabRoot('/search?query=nessie'), true)
  assert.deepEqual(getPhoneNavigationBackTarget('/channels/chan_a?thread=t1'), {
    label: 'Back to Channels',
    pathname: '/channels',
  })
  assert.equal(phoneRouteHasBackDepth('/projects/proj_a?tab=board'), true)
})

test('tab roots are exactly the depth-0 roots; Search and Knowledge have no contextual list', () => {
  assert.deepEqual(
    ['/channels', '/projects', '/knowledge-base', '/admin', '/settings', '/search'].map(isPhoneTabRoot),
    [true, true, true, true, true, true],
  )
  // A dashboard is a project's, not a tab root.
  assert.equal(isPhoneTabRoot('/projects/p1/dashboards'), false)
  assert.equal(phoneTabRootHasContextualList('/channels'), true)
  assert.equal(phoneTabRootHasContextualList('/projects'), true)
  // Knowledge lost its secondary sidebar with the redesign, so on a phone its
  // root screen is the outlet — the Documents Finder's own root column —
  // exactly as /search and /dashboards already work.
  assert.equal(phoneTabRootHasContextualList('/knowledge-base'), false)
  // Admin's sidebar and the Your settings list are each their root's page.
  assert.equal(phoneTabRootHasContextualList('/admin'), true)
  assert.equal(phoneTabRootHasContextualList('/settings'), true)
  assert.equal(phoneTabRootHasContextualList('/search'), false)
  assert.equal(phoneTabRootHasContextualList('/projects/p1/dashboards'), false)
})

test('Knowledge routes: root depth0, spaces, views and the virtual folders depth1', () => {
  assert.equal(getPhoneNavigationScreen('/knowledge-base')?.depth, 0)
  assert.equal(getPhoneNavigationScreen('/knowledge-base/latest')?.depth, 1)
  assert.equal(getPhoneNavigationScreen('/knowledge-base/shared-with-me')?.depth, 1)
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

test('Knowledge sidebar destinations are always route-backed', () => {
  assert.equal(
    resolveKnowledgeSidebarSelectionPath({ id: 'my docs/one', type: 'space' }),
    '/knowledge-base/spaces/my%20docs%2Fone',
  )
  assert.equal(
    resolveKnowledgeSidebarSelectionPath({ id: 'research', type: 'view' }),
    '/knowledge-base/views/research',
  )
})

test('Dashboards are Projects-section pages: the list is a project tab, a dashboard depth2', () => {
  // They were Knowledge pages — /dashboards at depth 1 under /knowledge-base,
  // a dashboard at depth 2 under that. A dashboard lives in a project now, so
  // the whole chain is the project's.
  const list = getPhoneNavigationScreen('/projects/p1/dashboards')
  assert.equal(list?.section, 'projects')
  assert.equal(list?.depth, 1)

  const detail = getPhoneNavigationScreen('/projects/p1/dashboards/dash_a')
  assert.equal(detail?.section, 'projects')
  assert.equal(detail?.depth, 2)
  // On a cold link, Back names the project's own Dashboards list.
  assert.deepEqual(getPhoneNavigationBackTarget('/projects/p1/dashboards/dash_a'), {
    label: 'Back to Dashboards',
    pathname: '/projects/p1/dashboards',
  })

  // The tab that owns every dashboard route is Projects.
  assert.equal(getPhoneTabRootPath('/projects/p1/dashboards'), '/projects')
  assert.equal(getPhoneTabRootPath('/projects/p1/dashboards/dash_a'), '/projects')
  assert.equal(
    getPhoneNavigationDirection('/projects/p1/dashboards', '/projects/p1/dashboards/dash_a'),
    'forward',
  )
  assert.equal(
    getPhoneNavigationDirection('/projects/p1/dashboards/dash_a', '/projects/p1/dashboards'),
    'back',
  )
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

test('board management is a project stack: board → directory → settings', () => {
  const board = '/projects/proj_a/board'
  const directory = '/projects/proj_a/boards'
  const settings = '/projects/proj_a/boards/board_a/settings?tab=watchers'

  assert.equal(getPhoneNavigationScreen(directory)?.section, 'projects')
  assert.equal(getPhoneNavigationScreen(directory)?.depth, 2)
  assert.deepEqual(getPhoneNavigationBackTarget(directory), {
    label: 'Back to board',
    pathname: board,
  })
  assert.equal(getPhoneNavigationScreen(settings)?.section, 'projects')
  assert.equal(getPhoneNavigationScreen(settings)?.depth, 3)
  assert.deepEqual(getPhoneNavigationBackTarget(settings), {
    label: 'Back to boards',
    pathname: directory,
  })
  assert.equal(getPhoneNavigationDirection(board, directory), 'forward')
  assert.equal(getPhoneNavigationDirection(directory, settings), 'forward')
  assert.equal(getPhoneNavigationDirection(settings, directory), 'back')
  assert.deepEqual(resolvePhoneNavigationBackAction(settings, directory), {
    mode: 'pop',
    to: directory,
  })
  assert.deepEqual(resolvePhoneNavigationBackAction(settings, null), {
    mode: 'replace',
    to: directory,
  })
})

test('admin: /admin depth0 and every admin page depth1 under it', () => {
  assert.equal(getPhoneNavigationScreen('/admin')?.depth, 0)
  assert.equal(isPhoneTabRoot('/admin'), true)
  for (const pathname of [
    '/admin/agents', '/admin/apps', '/admin/computers', '/admin/automations',
    '/admin/people', '/admin/teams', '/admin/organisation', '/admin/models', '/admin/connections',
    '/admin/keys', '/admin/usage', '/admin/billing', '/admin/security',
    '/admin/advanced/tools', '/admin/advanced/access-rules', '/admin/advanced/health',
    '/admin/advanced/push', '/admin/advanced/debug',
  ]) {
    assert.equal(getPhoneNavigationScreen(pathname)?.depth, 1, pathname)
    assert.equal(getPhoneNavigationScreen(pathname)?.section, 'admin', pathname)
    assert.equal(getPhoneTabRootPath(pathname), '/admin', pathname)
    assert.deepEqual(getPhoneNavigationBackTarget(pathname), {
      label: 'Back to Admin',
      pathname: '/admin',
    }, pathname)
  }
  // Admin details share one screen identity, so A → B never animates.
  assert.equal(
    getPhoneNavigationScreen('/admin/people')?.key,
    getPhoneNavigationScreen('/admin/billing')?.key,
  )
  assert.equal(getPhoneNavigationDirection('/admin/people', '/admin/billing'), null)
  assert.equal(getPhoneNavigationDirection('/admin', '/admin/people'), 'forward')
})

// Your settings keeps the Admin section id — the ids are the native shells'
// tabs — under a root of its own, so its Back and its cold start stay inside
// it, and its pages are reached from wherever the avatar menu was opened.
test('your settings: /settings depth0, its pages depth1 back to the reader\'s origin', () => {
  assert.equal(getPhoneNavigationScreen('/settings')?.depth, 0)
  assert.equal(isPhoneTabRoot('/settings'), true)
  for (const pathname of [
    '/settings/profile', '/settings/notifications', '/settings/appearance', '/settings/status',
    '/settings/accounts', '/settings/computers', '/settings/keys', '/settings/usage',
    '/settings/security',
  ]) {
    assert.equal(getPhoneNavigationScreen(pathname)?.depth, 1, pathname)
    assert.equal(getPhoneNavigationScreen(pathname)?.section, 'admin', pathname)
    assert.equal(getPhoneTabRootPath(pathname), '/settings', pathname)
    assert.deepEqual(getPhoneNavigationBackTarget(pathname), {
      label: 'Back to Your settings',
      pathname: '/settings',
    }, pathname)
    assert.deepEqual(resolvePhoneNavigationBackAction(pathname, '/projects/p1'), {
      mode: 'pop',
      to: '/projects/p1',
    }, pathname)
    assert.deepEqual(resolvePhoneNavigationBackAction(pathname, null), {
      mode: 'replace',
      to: '/settings',
    }, pathname)
  }
  // Your settings pages are one screen swapped in place, and a different
  // screen from the Admin pages beside them.
  assert.equal(getPhoneNavigationDirection('/settings/profile', '/settings/security'), null)
  assert.notEqual(
    getPhoneNavigationScreen('/settings/profile')?.key,
    getPhoneNavigationScreen('/admin/people')?.key,
  )
  assert.equal(getPhoneNavigationDirection('/settings', '/settings/profile'), 'forward')
})

// Apps shipped as a route and a sidebar entry but was left out of
// ADMIN_ROUTE_PREFIXES, so every admin-section question about it fell through
// to the Channels default: the phone tab bar lit Channels while you stood on
// Apps, and Back offered "Back to Channels".
test('Apps is an Admin-section list, with a detail level beneath it', () => {
  assert.equal(getPhoneTabRootPath('/admin/apps'), '/admin')
  assert.equal(getPhoneTabRootPath('/admin/apps/deep-water'), '/admin')
  assert.equal(getPhoneNavigationScreen('/admin/apps')?.section, 'admin')
  assert.equal(getPhoneNavigationScreen('/admin/apps/deep-water')?.section, 'admin')
  assert.equal(getPhoneNavigationScreen('/admin/apps')?.depth, 1)
  assert.equal(getPhoneNavigationScreen('/admin/apps/deep-water')?.depth, 2)
  assert.deepEqual(getPhoneNavigationBackTarget('/admin/apps'), {
    label: 'Back to Admin',
    pathname: '/admin',
  })
  assert.deepEqual(getPhoneNavigationBackTarget('/admin/apps/deep-water'), {
    label: 'Apps',
    pathname: '/admin/apps',
  })
  assert.equal(getPhoneNavigationDirection('/admin', '/admin/apps'), 'forward')
  assert.equal(getPhoneNavigationDirection('/admin/apps', '/admin/apps/deep-water'), 'forward')
  assert.equal(getPhoneNavigationDirection('/admin/apps/deep-water', '/admin/apps'), 'back')
  assert.deepEqual(resolvePhoneNavigationBackAction('/admin/apps/deep-water', '/admin/apps'), {
    mode: 'pop',
    to: '/admin/apps',
  })
  assert.deepEqual(resolvePhoneNavigationBackAction('/admin/apps/deep-water', null), {
    mode: 'replace',
    to: '/admin/apps',
  })
  // An admin page whose path starts with the apps prefix letters must not be
  // swallowed by it: every Admin page is named, not caught by a prefix.
  assert.equal(getPhoneTabRootPath('/admin/automations'), '/admin')
  assert.equal(getPhoneNavigationScreen('/admin/automations')?.section, 'admin')
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
    resolvePhoneNavigationBackAction('/projects/p1/dashboards/dash_a', '/projects/p1/dashboards'),
    { mode: 'pop', to: '/projects/p1/dashboards' },
  )
  // A predecessor in another section is where the push came from: pop.
  assert.deepEqual(
    resolvePhoneNavigationBackAction('/channels/chan_a', '/projects'),
    { mode: 'pop', to: '/projects' },
  )
  // A dashboard is `parent: 'origin'`: opened from the project's Overview, Back
  // pops to the Overview rather than replacing to the Dashboards list.
  assert.deepEqual(
    resolvePhoneNavigationBackAction('/projects/p1/dashboards/dash_a', '/projects/p1'),
    { mode: 'pop', to: '/projects/p1' },
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
// animated, a sub-agent drill-in was invisible, and New agent did not know
// what it was covering.
test('the Agents family is a real stack: list depth1, agent depth2, New agent a flow', () => {
  assert.equal(getPhoneNavigationScreen('/admin/agents')?.depth, 1)
  assert.equal(getPhoneNavigationScreen('/admin/agents/agent_a')?.depth, 2)
  assert.equal(getPhoneNavigationScreen('/admin/agents/agent_a')?.section, 'admin')
  assert.equal(getPhoneNavigationDirection('/admin/agents', '/admin/agents/agent_a'), 'forward')
  assert.equal(getPhoneNavigationDirection('/admin/agents/agent_a', '/admin/agents'), 'back')
  assert.deepEqual(getPhoneNavigationBackTarget('/admin/agents/agent_a'), {
    label: 'Back to Agents',
    pathname: '/admin/agents',
  })
  // A sub-agent drill-in is the same screen identity: it swaps in place.
  assert.equal(
    getPhoneNavigationScreen('/admin/agents/agent_a')?.key,
    getPhoneNavigationScreen('/admin/agents/agent_child')?.key,
  )
  assert.equal(getPhoneNavigationDirection('/admin/agents/agent_a', '/admin/agents/agent_child'), null)
  // The mailbox is one step further, back to its agent.
  assert.equal(getPhoneNavigationScreen('/admin/agents/agent_a/mailbox')?.depth, 3)
  assert.deepEqual(getPhoneNavigationBackTarget('/admin/agents/agent_a/mailbox'), {
    label: 'Back to agent',
    pathname: '/admin/agents/agent_a',
  })

  // New agent is a Flow at depth 2 — pushed from the list it adds to — and
  // `new` is never read as an agent id. The old designer addresses are gone.
  assert.equal(getPhoneNavigationScreen('/admin/agents/new')?.depth, 2)
  assert.equal(getPhoneNavigationDirection('/admin/agents', '/admin/agents/new'), 'forward')
  assert.equal(getPhoneNavigationDirection('/admin/agents/new', '/admin/agents'), 'back')
  assert.deepEqual(getPhoneNavigationBackTarget('/admin/agents/new'), {
    label: 'Back to Agents',
    pathname: '/admin/agents',
  })
  // An agent's page and New agent are different screens at the same depth:
  // no transition, but not the same layer either.
  assert.notEqual(
    getPhoneNavigationScreen('/admin/agents/agent_a')?.key,
    getPhoneNavigationScreen('/admin/agents/new')?.key,
  )
  assert.equal(getPhoneNavigationScreen('/admin/agents/designer/agent_a')?.depth, undefined)
})

test('computers and automations push their records one step in', () => {
  assert.equal(getPhoneNavigationScreen('/admin/computers/c1')?.depth, 2)
  assert.deepEqual(getPhoneNavigationBackTarget('/admin/computers/c1'), {
    label: 'Back to Computers',
    pathname: '/admin/computers',
  })
  // `sessions` is the list of sessions across machines, never a machine id.
  assert.notEqual(
    getPhoneNavigationScreen('/admin/computers/sessions')?.key,
    getPhoneNavigationScreen('/admin/computers/c1')?.key,
  )
  assert.equal(getPhoneNavigationScreen('/admin/computers/c1/sessions/s1')?.depth, 3)
  assert.deepEqual(getPhoneNavigationBackTarget('/admin/computers/c1/sessions/s1'), {
    label: 'Sessions',
    pathname: '/admin/computers/sessions',
  })

  for (const pathname of [
    '/admin/automations/triggers/t1',
    '/admin/automations/batch-jobs/b1',
    '/admin/automations/batch-jobs/new',
    '/admin/automations/workflows/designer',
    '/admin/automations/workflows/designer/wt_a',
  ]) {
    assert.equal(getPhoneNavigationScreen(pathname)?.depth, 2, pathname)
    assert.deepEqual(getPhoneNavigationBackTarget(pathname), {
      label: 'Back to Automations',
      pathname: '/admin/automations',
    }, pathname)
    assert.equal(getPhoneNavigationDirection('/admin/automations', pathname), 'forward', pathname)
  }
  // `new` is the creation flow, not a batch job: two different screens.
  assert.notEqual(
    getPhoneNavigationScreen('/admin/automations/batch-jobs/new')?.key,
    getPhoneNavigationScreen('/admin/automations/batch-jobs/b1')?.key,
  )
})

test('the settings and security nested details push instead of swapping in place', () => {
  assert.equal(getPhoneNavigationScreen('/settings/status')?.depth, 1)
  assert.equal(getPhoneNavigationScreen('/settings/status/status_a')?.depth, 2)
  assert.equal(
    getPhoneNavigationDirection('/settings/status', '/settings/status/status_a'),
    'forward',
  )
  assert.equal(
    getPhoneNavigationDirection('/settings/status/status_a', '/settings/status'),
    'back',
  )
  assert.deepEqual(getPhoneNavigationBackTarget('/settings/status/status_a'), {
    label: 'Back to Status',
    pathname: '/settings/status',
  })
  // Status A → B is a sibling swap inside one screen.
  assert.equal(
    getPhoneNavigationDirection('/settings/status/status_a', '/settings/status/status_b'),
    null,
  )

  // A program signed in as you is Security's record; as somebody, Admin
  // Security's; a connected account is Connected accounts'.
  assert.deepEqual(getPhoneNavigationBackTarget('/settings/security/programs/p1'), {
    label: 'Back to Security',
    pathname: '/settings/security',
  })
  assert.deepEqual(getPhoneNavigationBackTarget('/admin/security/programs/p1'), {
    label: 'Back to Security',
    pathname: '/admin/security',
  })
  assert.deepEqual(getPhoneNavigationBackTarget('/settings/accounts/c1'), {
    label: 'Back to Connected accounts',
    pathname: '/settings/accounts',
  })
  assert.deepEqual(getPhoneNavigationBackTarget('/admin/teams/team_a'), {
    label: 'Back to Teams',
    pathname: '/admin/teams',
  })
  assert.deepEqual(getPhoneNavigationBackTarget('/admin/advanced/tools/tool_a'), {
    label: 'Back to Tool registry',
    pathname: '/admin/advanced/tools',
  })
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
    assert.equal(getPhoneTabRootPath(pathname), '/admin', pathname)
    assert.deepEqual(getPhoneNavigationBackTarget(pathname), {
      label: 'Back to Admin',
      pathname: '/admin',
    }, pathname)
    assert.deepEqual(resolvePhoneNavigationBackAction(pathname, '/channels/chan_a?thread=t1'), {
      mode: 'pop',
      to: '/channels/chan_a',
    }, pathname)
    assert.deepEqual(resolvePhoneNavigationBackAction(pathname, null), {
      mode: 'replace',
      to: '/admin',
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
// never be a transition endpoint or a Back destination. The landing route is
// the only one: retired addresses are deleted rather than forwarded, so they
// classify as nothing at all.
test('redirect-only routes classify no screen and never animate', () => {
  assert.equal(getPhoneNavigationScreen('/'), null)
  assert.equal(getPhoneNavigationBackTarget('/'), null)
  assert.equal(phoneRouteHasBackDepth('/'), false)
  assert.equal(isPhoneTabRoot('/'), false)
  assert.equal(getPhoneNavigationDirection('/admin', '/'), null)
  assert.equal(getPhoneNavigationDirection('/', '/admin'), null)
  // It still names the tab that owns it.
  assert.equal(getPhoneTabRootPath('/'), '/channels')
  for (const retired of ['/work', '/chats', '/workflows', '/settings/tools', '/agents', '/tokens']) {
    assert.equal(getPhoneNavigationScreen(retired), null, retired)
    assert.equal(isPhoneTabRoot(retired), false, retired)
  }
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
