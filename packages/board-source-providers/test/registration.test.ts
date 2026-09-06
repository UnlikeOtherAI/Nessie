import assert from 'node:assert/strict'
import test from 'node:test'

import { hasBoardSourceAdapter, listProviderMethods } from '@nessie/board-sources'

import { clearBoardSourceAdapters, registerBoardSourceAdaptersFromEnv } from '../src/index.js'

test('an OAuth-only provider with no credentials stays unregistered', () => {
  clearBoardSourceAdapters()
  // Linear is always there — it needs nothing configured. The other three do.
  assert.deepEqual(registerBoardSourceAdaptersFromEnv({}), ['linear'])
  assert.equal(hasBoardSourceAdapter('jira'), false)
  assert.equal(hasBoardSourceAdapter('github'), false)
  assert.equal(hasBoardSourceAdapter('trello'), false)
})

test('Linear on a deployment with no app offers the key and not the sign-in', () => {
  clearBoardSourceAdapters()
  registerBoardSourceAdaptersFromEnv({})
  assert.deepEqual(listProviderMethods(), [
    {
      provider: 'linear',
      methods: ['api_key'],
      apiKeyForm: {
        createUrl: 'https://linear.app/settings/account/security',
        createLabel: 'Linear → Settings → Security & access',
        fields: [
          {
            key: 'apiKey',
            label: 'Personal API key',
            kind: 'secret',
            placeholder: 'lin_api_…',
            help:
              'Create one under Personal API keys. Give it Read to mirror a team onto a ' +
              'board, or Read and Write if you also want dragging a card here to move the ' +
              'issue in Linear.',
          },
        ],
      },
    },
  ])
  clearBoardSourceAdapters()
})

test('half an OAuth credential is not a configuration', () => {
  clearBoardSourceAdapters()
  assert.equal(
    registerBoardSourceAdaptersFromEnv({ NESSIE_BOARD_JIRA_CLIENT_ID: 'id' }).includes('jira'),
    false,
  )
  clearBoardSourceAdapters()
  assert.equal(
    registerBoardSourceAdaptersFromEnv({ NESSIE_BOARD_JIRA_CLIENT_SECRET: 's' }).includes('jira'),
    false,
  )
  clearBoardSourceAdapters()
})

test('both halves add the sign-in alongside the key', () => {
  clearBoardSourceAdapters()
  registerBoardSourceAdaptersFromEnv({
    NESSIE_BOARD_LINEAR_CLIENT_ID: 'id',
    NESSIE_BOARD_LINEAR_CLIENT_SECRET: 'secret',
  })
  const linear = listProviderMethods().find((entry) => entry.provider === 'linear')
  // Both ways in, and the key stays first: it is the one that always works.
  assert.deepEqual(linear?.methods, ['api_key', 'oauth'])
  clearBoardSourceAdapters()
})

test('each provider is configured independently of the others', () => {
  clearBoardSourceAdapters()
  const registered = registerBoardSourceAdaptersFromEnv({
    NESSIE_BOARD_LINEAR_CLIENT_ID: 'id',
    NESSIE_BOARD_LINEAR_CLIENT_SECRET: 'secret',
    NESSIE_BOARD_JIRA_CLIENT_ID: 'id',
    NESSIE_BOARD_JIRA_CLIENT_SECRET: 'secret',
    NESSIE_BOARD_GITHUB_CLIENT_ID: 'id',
    NESSIE_BOARD_GITHUB_CLIENT_SECRET: 'secret',
    NESSIE_BOARD_TRELLO_API_KEY: 'key',
    NESSIE_BOARD_TRELLO_API_SECRET: 'secret',
  })
  assert.deepEqual([...registered].sort(), ['github', 'jira', 'linear', 'trello'])

  // One configured provider does not drag the others in.
  clearBoardSourceAdapters()
  assert.deepEqual(
    [
      ...registerBoardSourceAdaptersFromEnv({
        NESSIE_BOARD_TRELLO_API_KEY: 'key',
        NESSIE_BOARD_TRELLO_API_SECRET: 'secret',
      }),
    ].sort(),
    ['linear', 'trello'],
  )
  assert.equal(hasBoardSourceAdapter('jira'), false)
  clearBoardSourceAdapters()
})
