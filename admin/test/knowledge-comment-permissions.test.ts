import assert from 'node:assert/strict'
import test from 'node:test'

import { ApiClientProvider, type ApiClient } from '@nessie/client-core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import * as React from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { CommentsSection } from '../src/components/features/knowledge/comments/CommentsSection.js'
import { knowledgeKeys } from '../src/lib/query-keys.js'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

test('a reader without space write access still gets the comment composer', () => {
  const pageId = '00000000-0000-4000-8000-000000000005'
  const queryClient = new QueryClient()
  queryClient.setQueryData(knowledgeKeys.annotationsByKind(pageId, 'comment'), [])
  const unavailable = async () => { throw new Error('unexpected API call') }
  const apiClient = {
    delete: unavailable,
    get: unavailable,
    patch: unavailable,
    post: unavailable,
    put: unavailable,
  } as ApiClient

  const markup = renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        ApiClientProvider,
        { client: apiClient },
        createElement(CommentsSection, { canResolve: false, pageId }),
      ),
    ),
  )

  assert.match(markup, /placeholder="Add a comment…"/)
  assert.match(markup, />Comment<\/button>/)
})
