import assert from 'node:assert/strict'
import test from 'node:test'

import { buildSnippet, htmlToText, sanitizeEmailHtml } from '../src/sanitize-html.js'

test('script elements are removed with their content', () => {
  const result = sanitizeEmailHtml('<p>hi</p><script>alert(document.cookie)</script>')
  assert.equal(result.html.includes('alert'), false)
  assert.equal(result.html.includes('<script'), false)
  assert.match(result.html, /<p>hi<\/p>/)
})

test('an unclosed script tag cannot survive as a bare tag', () => {
  const result = sanitizeEmailHtml('<p>hi</p><script src="https://evil.example/x.js">')
  assert.equal(result.html.includes('script'), false)
})

test('event handlers are stripped even on allowed elements', () => {
  const result = sanitizeEmailHtml('<a href="https://example.com" onclick="steal()">x</a>')
  assert.equal(result.html.includes('onclick'), false)
  assert.match(result.html, /href="https:\/\/example\.com"/)
})

test('javascript: and data: hrefs are dropped, https survives', () => {
  assert.equal(sanitizeEmailHtml('<a href="javascript:evil()">x</a>').html.includes('href'), false)
  assert.equal(sanitizeEmailHtml('<a href="data:text/html,evil">x</a>').html.includes('href'), false)
  assert.match(sanitizeEmailHtml('<a href="https://ok.example">x</a>').html, /href=/)
})

test('an external link carries noopener/noreferrer so the mailbox URL never leaks', () => {
  const result = sanitizeEmailHtml('<a href="https://example.com">x</a>')
  assert.match(result.html, /rel="noopener noreferrer nofollow"/)
})

test('a remote image is withheld as data-blocked-src and flagged', () => {
  const result = sanitizeEmailHtml('<img src="https://tracker.example/pixel.gif">')
  assert.equal(result.blockedRemoteContent, true)
  assert.match(result.html, /data-blocked-src="https:\/\/tracker\.example\/pixel\.gif"/)
  // The loadable attribute must be gone — matched with a boundary, since
  // `data-blocked-src="` itself ends in `src="`.
  assert.doesNotMatch(result.html, /(^|[\s"])src="https:/)
})

test('an inline cid: image is kept — those bytes are already stored', () => {
  const result = sanitizeEmailHtml('<img src="cid:logo@example">')
  assert.equal(result.blockedRemoteContent, false)
  assert.match(result.html, /src="cid:logo@example"/)
})

test('unknown elements lose their tags but keep their text', () => {
  const result = sanitizeEmailHtml('<marquee>readable</marquee>')
  assert.equal(result.html.includes('marquee'), false)
  assert.match(result.html, /readable/)
})

test('comments are removed — some clients still evaluate conditional markup', () => {
  const result = sanitizeEmailHtml('<p>a</p><!--[if IE]><script>x()</script><![endif]-->')
  assert.equal(result.html.includes('<!--'), false)
  assert.equal(result.html.includes('x()'), false)
})

test('style blocks and svg are removed with their content', () => {
  const result = sanitizeEmailHtml('<style>body{background:url(https://x)}</style><svg><use href="#a"/></svg><p>k</p>')
  assert.equal(result.html.includes('background'), false)
  assert.equal(result.html.includes('svg'), false)
  assert.match(result.html, /<p>k<\/p>/)
})

test('htmlToText produces readable plain text for the snippet', () => {
  const text = htmlToText('<p>Hello</p><p>World &amp; friends</p>')
  assert.equal(text, 'Hello\nWorld & friends')
})

test('buildSnippet collapses whitespace and truncates with an ellipsis', () => {
  assert.equal(buildSnippet('  a\n\n  b  '), 'a b')
  const long = buildSnippet('x'.repeat(300), 10)
  assert.equal(long.length, 10)
  assert.match(long, /…$/)
})
