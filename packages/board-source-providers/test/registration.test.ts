import assert from 'node:assert/strict'
import test from 'node:test'

import { hasBoardSourceAdapter } from '@nessie/board-sources'

import { clearBoardSourceAdapters, registerBoardSourceAdaptersFromEnv } from '../src/index.js'

test('a provider with no credentials on this deployment stays unregistered', () => {
  clearBoardSourceAdapters()
  assert.deepEqual(registerBoardSourceAdaptersFromEnv({}), [])
  assert.equal(hasBoardSourceAdapter('linear'), false)
})

test('half a credential is not a configuration', () => {
  clearBoardSourceAdapters()
  assert.deepEqual(
    registerBoardSourceAdaptersFromEnv({ NESSIE_BOARD_LINEAR_CLIENT_ID: 'id' }),
    [],
  )
  clearBoardSourceAdapters()
  assert.deepEqual(
    registerBoardSourceAdaptersFromEnv({ NESSIE_BOARD_LINEAR_CLIENT_SECRET: 'secret' }),
    [],
  )
})

test('both halves register the adapter', () => {
  clearBoardSourceAdapters()
  assert.deepEqual(
    registerBoardSourceAdaptersFromEnv({
      NESSIE_BOARD_LINEAR_CLIENT_ID: 'id',
      NESSIE_BOARD_LINEAR_CLIENT_SECRET: 'secret',
    }),
    ['linear'],
  )
  assert.equal(hasBoardSourceAdapter('linear'), true)
  clearBoardSourceAdapters()
})
