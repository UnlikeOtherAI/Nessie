import assert from 'node:assert/strict'
import test from 'node:test'

import { shouldDismissNativeCreationMenu } from './native-creation-menu'

test('a creation sheet stays open until an external menu dismissal arrives', () => {
  assert.equal(shouldDismissNativeCreationMenu({
    creationOpen: true,
    dismissVersion: 0,
    previousDismissVersion: 0,
  }), false)
  assert.equal(shouldDismissNativeCreationMenu({
    creationOpen: true,
    dismissVersion: 1,
    previousDismissVersion: 0,
  }), true)
  assert.equal(shouldDismissNativeCreationMenu({
    creationOpen: false,
    dismissVersion: 1,
    previousDismissVersion: 0,
  }), false)
})
