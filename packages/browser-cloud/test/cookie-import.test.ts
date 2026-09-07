import assert from 'node:assert/strict'
import test from 'node:test'

import { prepareImportedCookies, type ImportedBrowserCookie } from '../src/cookie-import.js'

const domainCookie = (overrides: Partial<ImportedBrowserCookie> = {}): ImportedBrowserCookie => ({
  domain: '.example.com',
  hostOnly: false,
  httpOnly: true,
  name: 'session',
  path: '/account',
  sameSite: 'lax',
  secure: true,
  session: true,
  value: 'not-a-real-secret',
  ...overrides,
})

test('a selected-host copy narrows a parent-domain cookie without dropping its path', () => {
  const [cookie] = prepareImportedCookies([{
    origin: 'https://login.example.com',
    cookies: [domainCookie()],
  }])

  assert.deepEqual(cookie, {
    httpOnly: true,
    name: 'session',
    path: '/account',
    sameSite: 'Lax',
    secure: true,
    url: 'https://login.example.com/account',
    value: 'not-a-real-secret',
  })
  assert.equal(Object.hasOwn(cookie, 'domain'), false)
})

test('a domain cookie that does not apply to the selected host is refused', () => {
  assert.throws(() => prepareImportedCookies([{
    origin: 'https://login.example.com',
    cookies: [domainCookie({ domain: '.other.example' })],
  }]))
})

test('a path that could escape the selected origin is refused', () => {
  assert.throws(() => prepareImportedCookies([{
    origin: 'https://login.example.com',
    cookies: [domainCookie({ path: '//other.example/' })],
  }]))
})
