import assert from 'node:assert/strict'
import test from 'node:test'

import { ApiClientProvider, type ApiClient } from '@nessie/client-core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import * as React from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { ShareDialog } from '../src/components/features/knowledge/finder/ShareDialog.js'
import {
  SHARED_SEARCH_SENTENCE,
  shareIntroSentence,
} from '../src/components/features/knowledge/finder/sharing-copy.js'

/**
 * The Share dialog
 * (docs/plans/2026-09-16-documents-finder-ui/menus-and-dialogs.md §4.1).
 *
 * Two of these cases are about copy, which is unusual for a suite and
 * deliberate here: "nobody has to approve it" and "shared pages are not
 * included in the recipient's search" are the two things the owner asked to be
 * told, and the second is a limitation a person would otherwise discover by
 * finding nothing. A sentence with no test is a sentence that drifts.
 */

;(globalThis as typeof globalThis & { React: typeof React }).React = React

const render = (props: Partial<Parameters<typeof ShareDialog>[0]> = {}): string => {
  const queryClient = new QueryClient()
  const unavailable = async () => { throw new Error('unexpected API call') }
  const apiClient = {
    delete: unavailable,
    get: async () => [],
    patch: unavailable,
    post: unavailable,
    put: unavailable,
  } as unknown as ApiClient
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        ApiClientProvider,
        { client: apiClient },
        createElement(ShareDialog, {
          onClose: () => undefined,
          open: true,
          pageId: '00000000-0000-4000-8000-000000000010',
          subjectKind: 'document',
          title: 'Plan',
          ...props,
        }),
      ),
    ),
  )
}

test('the dialog names what is being shared, so nobody shares the wrong thing', () => {
  // The title is the one place the two sharing surfaces differ by name: only
  // this one says "Share", and only where the viewer may actually grant.
  assert.match(render(), /Share “Plan”/)
})

test('the no-approval promise is on screen, every time', () => {
  const markup = render()
  // The owner's words were "they're going to get it without any approval
  // gate". This is that promise, said to the person making it.
  assert.match(markup, /nobody has to approve it/)
  // And the edit boundary beside it, because "can edit" sounds broader than
  // it is: an edit grantee changes content and nothing else.
  assert.match(markup, /can’t share,\s*move, publish or delete it/)
})

test('a folder says that what is added later goes too', () => {
  const markup = render({ subjectKind: 'folder' })
  assert.match(markup, /this folder and everything inside it, including what is added later/)
  // A document's sentence must not claim the folder behaviour.
  assert.doesNotMatch(render(), /including what is added later/)
  assert.equal(
    shareIntroSentence('file').includes('this file'),
    true,
    'a file is called a file',
  )
})

test('the search limit is stated, and it is stated for both levels at once', () => {
  const markup = render()
  assert.ok(SHARED_SEARCH_SENTENCE.includes('whatever their access'))
  assert.match(markup, /not included in the recipient’s search, whatever their access/)
  // Both levels are on screen when that sentence is, so it cannot read as a
  // property of the lower one.
  assert.match(markup, /Can view/)
  assert.match(markup, /Can edit/)
})

test('the level control opens on Can view', () => {
  const markup = render()
  // The radiogroup carries the state; "Can edit" is a choice a person makes,
  // never the default they fall into — a share is a grant, and the narrower
  // of two grants is the only safe thing to open on.
  const radios = [...markup.matchAll(/role="radio"[^>]*>([^<]+)</g)]
    .map((match) => match[1])
  assert.deepEqual(radios, ['Can view', 'Can edit'])
  assert.match(markup, /aria-checked="true"[^>]*role="radio"[^>]*>Can view</)
})

test('an unshared document says so plainly rather than showing an empty list', () => {
  assert.match(render(), /Only you, so far\./)
})

test('the dialog has no Save: every control writes on use', () => {
  const markup = render()
  assert.doesNotMatch(markup, /<button[^>]*>Save<\/button>/)
  // The primary is Done — an acknowledgement, not a submit. Anything else
  // would imply the grants above it are still pending.
  assert.match(markup, /Done<\/button>/)
})
