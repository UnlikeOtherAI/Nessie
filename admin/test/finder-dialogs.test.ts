import assert from 'node:assert/strict'
import test from 'node:test'

import { ApiClientProvider, type ApiClient } from '@nessie/client-core'
import { KnowledgeSpaceResponseSchema } from '@nessie/schemas'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import * as React from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { AccessReadoutDialog } from '../src/components/features/knowledge/finder/AccessReadoutDialog.js'
import {
  deleteConfirmCopy,
  pageLink,
  spaceAccessSummary,
} from '../src/components/features/knowledge/finder/finder-menu-context.js'
import { sharingSurfaceFor } from '../src/components/features/knowledge/finder/finder-menu.js'
import {
  agentReadout,
  projectReadout,
  sharedToMeReadout,
  spaceReadout,
} from '../src/components/features/knowledge/finder/sharing-copy.js'
import type { KnowledgePageRecord } from '../src/facades/knowledge/hooks.js'

/**
 * The dialogs a Finder menu opens
 * (docs/plans/2026-09-16-documents-finder-ui/menus-and-dialogs.md §3, §4, §8).
 *
 * The load-bearing case is the first group. `spaceAccessSummary` is what turns
 * a space into an access mode, and `sharingSurfaceFor` turns that mode into
 * either a surface that grants or one that reports. Together they are the
 * whole of "his own document can be handed to a person; a project's documents
 * can only be read out", and a mistake in either direction is a privacy
 * defect rather than a cosmetic one — which is why the pair is asserted
 * end-to-end here and not only in halves.
 */

;(globalThis as typeof globalThis & { React: typeof React }).React = React

const ME = '00000000-0000-4000-8000-0000000000aa'

const space = (overrides: Record<string, unknown> = {}) => KnowledgeSpaceResponseSchema.parse({
  canManageAccess: false,
  canWrite: true,
  createdAt: '2026-09-16T12:00:00.000Z',
  createdBy: ME,
  deletedAt: null,
  description: null,
  id: '00000000-0000-4000-8000-000000000004',
  memberAgentIds: [],
  memberUserIds: [],
  metadata: null,
  name: 'Marketing',
  organizationId: '00000000-0000-4000-8000-000000000001',
  ownerAgentId: null,
  policyChainTrace: ['decision:ALLOWED'],
  projectId: '00000000-0000-4000-8000-000000000002',
  sensitivityTier: 'normal',
  sourceRef: 'kb://first-party/spaces/space',
  updatedAt: '2026-09-16T12:00:00.000Z',
  visibility: 'private',
  visibilityReason: 'private visibility',
  writeRestricted: false,
  ...overrides,
})

// ── The branch: grant, or read-out ─────────────────────────────────────────

test('the viewer’s own My Documents is the one container sharing can grant from', () => {
  const mine = space({ metadata: { personal: true }, name: 'My Documents', userId: ME })
  const access = spaceAccessSummary(mine, true)
  assert.equal(access.mode, 'personal')
  assert.equal(sharingSurfaceFor(access.mode, true), 'grant')
})

test('a project’s Documents folder reads out; it never offers a grant', () => {
  const project = space({ metadata: { projectDocuments: true }, name: 'Apollo' })
  const access = spaceAccessSummary(project, false)
  assert.equal(access.mode, 'project')
  // The owner's instruction: for project stuff the dialog shows who is in
  // there and says access follows the project's permissions. Offering a
  // picker here would be offering an edit the server refuses with
  // SHARE_NOT_PERSONAL.
  assert.equal(sharingSurfaceFor(access.mode, true), 'readout')
  assert.equal(sharingSurfaceFor(access.mode, false), 'readout')
})

test('an ad-hoc shared folder and an agent home both read out', () => {
  assert.equal(spaceAccessSummary(space(), false).mode, 'space')
  const agent = space({
    name: 'Sales Assistant — Documents',
    ownerAgentId: '00000000-0000-4000-8000-0000000000bb',
  })
  const access = spaceAccessSummary(agent, false)
  assert.equal(access.mode, 'agent')
  assert.equal(access.mode === 'agent' ? access.agentName : '', 'Sales Assistant')
  assert.equal(sharingSurfaceFor(access.mode, true), 'readout')
})

test('somebody else’s personal space is a read-out, not a grant', () => {
  // An organisation owner reaching another person's My Documents: the mode is
  // personal, but minting a new audience for a private document is the
  // owner's act alone (`SHARE_NOT_PERSONAL` on POST for anyone else).
  const theirs = space({
    metadata: { personal: true },
    userId: '00000000-0000-4000-8000-0000000000cc',
  })
  assert.equal(spaceAccessSummary(theirs, false).mode, 'space')
  assert.equal(sharingSurfaceFor('personal', false), 'readout')
})

// ── The read-out's words ───────────────────────────────────────────────────

const renderReadout = (
  access: Parameters<typeof AccessReadoutDialog>[0]['access'],
): string => {
  const queryClient = new QueryClient()
  const apiClient = { get: async () => [] } as unknown as ApiClient
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        ApiClientProvider,
        { client: apiClient },
        createElement(AccessReadoutDialog, {
          access,
          onClose: () => undefined,
          open: true,
        }),
      ),
    ),
  )
}

test('the project read-out says access follows the project, in the design’s words', () => {
  const readout = projectReadout('Apollo')
  assert.equal(readout.headline, 'Everyone in the project Apollo can see this.')
  assert.match(readout.body, /Access follows the project’s membership\./)
  assert.match(readout.body, /there is no separate sharing for a project’s documents/)
})

test('the project read-out renders those words and no way to grant', () => {
  const markup = renderReadout({
    memberCount: 3,
    mode: 'project',
    projectId: '00000000-0000-4000-8000-000000000002',
    projectName: 'Apollo',
  })
  assert.match(markup, /Who can see this/)
  assert.match(markup, /Everyone in the project Apollo can see this\./)
  assert.match(markup, /there is no separate sharing for a project’s documents/)
  // Nothing in it writes: no picker, no level control, no Share button.
  assert.doesNotMatch(markup, /Add a person…/)
  assert.doesNotMatch(markup, /role="radiogroup"/)
  assert.doesNotMatch(markup, /Can edit/)
  assert.doesNotMatch(markup, /nobody has to approve it/)
  // The doorway is the project's own members surface, where the answer is.
  assert.match(markup, /In the project/)
})

test('a shared folder’s sentence follows its visibility, and names the restriction', () => {
  assert.match(
    spaceReadout({ spaceName: 'Marketing', visibility: 'organization', writeRestricted: false })
      .headline,
    /Everyone in the organisation can see this\./,
  )
  assert.match(
    spaceReadout({ spaceName: 'Marketing', visibility: 'private', writeRestricted: true }).headline,
    /Only people added to the folder Marketing can see this\./,
  )
  assert.match(
    spaceReadout({ spaceName: 'Marketing', visibility: 'team', writeRestricted: true }).body,
    /Editing is restricted to the people listed\./,
  )
})

test('a shared-with-me row says what the level actually means at both levels', () => {
  const view = sharedToMeReadout('Ondrej', 'view')
  assert.equal(view.headline, 'Ondrej shared this with you.')
  assert.match(view.body, /only Ondrej can change who has access/)
  const edit = sharedToMeReadout('Ondrej', 'edit')
  assert.match(edit.headline, /and you can edit it\./)
  // The four things an edit grant is not, named rather than implied.
  assert.match(edit.body, /only Ondrej can publish it, move it, delete it or change who has access/)
})

test('an agent home’s audience is the agent’s own', () => {
  assert.equal(
    agentReadout('Sales Assistant', 2).headline,
    'People who can see the agent Sales Assistant can see its documents.',
  )
  assert.match(agentReadout('Sales Assistant', 1).body, /1 person was also added directly\./)
})

// ── Delete (§8) ────────────────────────────────────────────────────────────

const page = (overrides: Partial<KnowledgePageRecord> = {}): KnowledgePageRecord => ({
  createdAt: '2026-09-16T12:00:00.000Z',
  id: 'p1',
  kind: 'document',
  labels: [],
  latestVersion: null,
  metadata: null,
  parentPageId: null,
  policyChainTrace: [],
  position: 0,
  publishedVersion: null,
  publishedVersionId: null,
  sourceRef: 'kb://p1',
  spaceId: 's1',
  status: 'published',
  summary: null,
  title: 'Plan',
  updatedAt: '2026-09-16T12:00:00.000Z',
  visibilityReason: 'ok',
  ...overrides,
})

test('delete says what happens to the bytes, and never says Trash', () => {
  const folder = deleteConfirmCopy([page({ kind: 'folder', title: '2026' })])
  assert.equal(folder.title, 'Delete “2026”?')
  assert.match(folder.body, /Everything inside it will be deleted too\./)
  assert.match(folder.body, /removed from storage straight away/)
  assert.equal(folder.confirmLabel, 'Delete')
  // There is no Trash to restore from, so no dialog may imply one.
  for (const copy of [folder, deleteConfirmCopy([page(), page({ id: 'p2' })])]) {
    assert.doesNotMatch(`${copy.title} ${copy.body} ${copy.confirmLabel}`, /trash/i)
  }
})

test('deleting something shared warns that those people lose it', () => {
  const copy = deleteConfirmCopy([page({ shareCount: 2 })])
  assert.match(copy.body, /It is shared with 2 people, who will lose access\./)
  assert.doesNotMatch(deleteConfirmCopy([page()]).body, /shared with/)
})

test('a multi-selection confirms with its count', () => {
  const copy = deleteConfirmCopy([page(), page({ id: 'p2' }), page({ id: 'p3' })])
  assert.equal(copy.title, 'Delete 3 items?')
  assert.equal(copy.confirmLabel, 'Delete 3 items')
})

// ── Copy link (§9) ─────────────────────────────────────────────────────────

test('a folder’s link opens the browser at it; an item’s opens the item', () => {
  assert.match(pageLink('s1', 'p1', true), /\/knowledge-base\/spaces\/s1\?folder=p1$/)
  assert.match(pageLink('s1', 'p1', false), /\/knowledge-base\/spaces\/s1\?pageId=p1$/)
})
