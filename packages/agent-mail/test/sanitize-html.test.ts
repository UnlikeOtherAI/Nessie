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

// A tag whose quotes do not balance used to match no tag pattern at all and was
// copied to the output verbatim. Combined with `'` surviving escapeAttr, the
// dangling quote opened an attribute in the browser that swallowed the markup
// after it, so a sender could land a working `onclick` on the rendered element.
test('an unbalanced quote cannot smuggle an event handler past the allowlist', () => {
  for (const payload of [
    `<p x='><a href="https://e.com" title="'onclick='alert(1)'z">click</a>`,
    `<div a='><img alt="'onmouseover='alert(1)'x">`,
  ]) {
    const { html } = sanitizeEmailHtml(payload)
    // The dangling tag is escaped rather than emitted as markup, so its stray
    // quote is inert text and cannot open an attribute.
    assert.equal(/<p x='|<div a='/.test(html), false)
    assert.match(html, /&lt;(p|div)/)
    // No surviving attribute value carries a raw quote of either kind, so no
    // value can be closed early to start a new attribute after it.
    for (const [, value] of html.matchAll(/="([^"]*)"/g)) {
      assert.equal(value.includes("'"), false, `raw quote survived in ${value}`)
    }
    // Nothing in the output parses as an event-handler attribute.
    assert.equal(/[\s"']on[a-z]+\s*=/i.test(html), false)
  }
})

test('a bare angle bracket in body text is escaped, never passed through', () => {
  assert.equal(sanitizeEmailHtml('<p>2 < 3 and 5 > 4</p>').html, '<p>2 &lt; 3 and 5 > 4</p>')
})

test('a single quote in an ordinary attribute value is entity-encoded', () => {
  const { html } = sanitizeEmailHtml(`<img alt="it's here" src="cid:x">`)
  assert.match(html, /alt="it&#39;s here"/)
  assert.equal(html.includes("it's"), false)
})
