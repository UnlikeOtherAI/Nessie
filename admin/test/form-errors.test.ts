import assert from 'node:assert/strict'
import test from 'node:test'

import { ApiClientError } from '@nessie/client-core'

import { toFormErrors } from '../src/facades/form-errors.js'

test('a validation failure lands on the fields it is about', () => {
  const error = new ApiClientError('Invalid request payload', 'VALIDATION_ERROR', 400, {
    fieldErrors: { name: ['Name is required'], slug: ['Slug is already taken'] },
    formErrors: [],
  })

  const result = toFormErrors(error)

  assert.deepEqual(result.fieldErrors, {
    name: 'Name is required',
    slug: 'Slug is already taken',
  })
  // The generic envelope message is suppressed once every complaint has a
  // home: repeating it above the form reads as a second, separate failure.
  assert.equal(result.formError, undefined)
})

test('a refusal with no field detail stays a form-level message', () => {
  const error = new ApiClientError('Only owners can do that.', 'FORBIDDEN', 403)

  assert.deepEqual(toFormErrors(error), {
    fieldErrors: {},
    formError: 'Only owners can do that.',
  })
})

test('only the first message per field is shown', () => {
  const error = new ApiClientError('Invalid request payload', 'VALIDATION_ERROR', 400, {
    fieldErrors: { name: ['Too short', 'Must be lowercase'] },
  })

  assert.equal(toFormErrors(error).fieldErrors['name'], 'Too short')
})

test('an empty message array does not create a blank field error', () => {
  const error = new ApiClientError('Invalid request payload', 'VALIDATION_ERROR', 400, {
    fieldErrors: { name: [] },
  })

  const result = toFormErrors(error)

  assert.deepEqual(result.fieldErrors, {})
  assert.equal(result.formError, 'Invalid request payload', 'the failure must still be visible')
})

test('a network failure is reported without pretending it came from the server', () => {
  assert.equal(toFormErrors(new TypeError('Failed to fetch')).formError, 'Failed to fetch')
  assert.equal(toFormErrors('nonsense').formError, 'Something went wrong. Try again.')
})
