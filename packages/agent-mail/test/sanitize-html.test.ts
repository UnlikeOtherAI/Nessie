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

// A tag whose quotes do not balance is a parser-differential attack: the
// sender hopes the sanitizer reads the bytes one way and the browser another.
// The parser reads them exactly once — the dangling quote is ordinary
// attribute syntax — so the smuggled markup is swallowed as attributes of the
// one real tag and refused by the allowlist, never re-serialized as markup.
test('an unbalanced quote cannot smuggle an event handler past the allowlist', () => {
  for (const payload of [
    `<p x='><a href="https://e.com" title="'onclick='alert(1)'z">click</a>`,
    `<div a='><img alt="'onmouseover='alert(1)'x">`,
  ]) {
    const { html } = sanitizeEmailHtml(payload)
    // The dangling markup never survives as a literal tag.
    assert.equal(/<p x='|<div a='/.test(html), false)
    // The smuggled elements and their handlers are gone entirely.
    assert.equal(html.includes('<a'), false)
    assert.equal(html.includes('<img'), false)
    assert.equal(html.includes('alert'), false)
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
  // The serializer escapes both brackets in text, so re-parsing the stored
  // markup can never turn sentence text back into a tag.
  assert.equal(sanitizeEmailHtml('<p>2 < 3 and 5 > 4</p>').html, '<p>2 &lt; 3 and 5 &gt; 4</p>')
})

// Values are emitted double-quoted with `"` entity-encoded, so nothing inside
// a value can close it early and start a new attribute; a raw `'` inside a
// double-quoted value is inert.
test('a quote inside an attribute value cannot close the attribute early', () => {
  const { html } = sanitizeEmailHtml(`<img alt='say "hi" now' src="cid:x">`)
  assert.match(html, /alt="say &quot;hi&quot; now"/)
  assert.match(html, /src="cid:x"/)
  const single = sanitizeEmailHtml(`<img alt="it's here" src="cid:x">`).html
  assert.match(single, /alt="it's here"/)
  assert.match(single, /src="cid:x"/)
})

// ── Parser-strength cases ────────────────────────────────────────────────────
// The classes a regex/tag-balancing sanitizer is historically weak against.
// Each payload is written so that a byte-pattern reading and a browser's
// tree reading diverge; the parser takes the browser's side, once.

test('mutation XSS: foreign-content nesting cannot resurrect a dropped element', () => {
  for (const payload of [
    '<svg><style><img src=x onerror=alert(1)></style></svg><p>ok</p>',
    '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)></style></mglyph></table></mtext></math><p>ok</p>',
    '<svg><a href="javascript:alert(1)"><text>click</text></a></svg><p>ok</p>',
  ]) {
    const { html } = sanitizeEmailHtml(payload)
    assert.equal(html, '<p>ok</p>')
  }
})

test('comment-embedded markup cannot smuggle an attribute or element', () => {
  // In a spec-compliant browser `<!--` inside a tag is a bogus comment ending
  // at the first `>`, which would make onerror a live attribute. The stored
  // form must contain no such attribute however it is re-parsed.
  const inTag = sanitizeEmailHtml('<img src="cid:x" <!-- --> onerror="alert(1)">').html
  // The tag is closed before the handler text (which is escaped, inert body
  // text), so no re-parse can read it as an attribute.
  assert.equal(/<img[^>]*onerror/i.test(inTag), false)
  const bogus = sanitizeEmailHtml('<!--><img src=x onerror=alert(1)>--><p>ok</p>').html
  assert.equal(bogus.includes('onerror'), false)
  assert.match(bogus, /<p>ok<\/p>/)
})

test('malformed attribute quoting cannot hide a scheme or a handler', () => {
  // No space between attributes: a pattern reader sees one value where the
  // parser sees two attributes.
  const stuck = sanitizeEmailHtml('<a href="javascript:alert(1)"title="x>y">click</a>').html
  assert.equal(stuck.includes('href'), false)
  // An unclosed tag at end of input is dropped with everything it carried.
  assert.equal(sanitizeEmailHtml('<img src="cid:x" onerror=alert(1)').html.includes('onerror'), false)
})

test('entity- and whitespace-encoded schemes are decoded before the scheme check', () => {
  assert.equal(sanitizeEmailHtml('<a href="java&#115;cript:alert(1)">x</a>').html, '<a>x</a>')
  assert.equal(sanitizeEmailHtml('<a href="jav\tascript:alert(1)">x</a>').html, '<a>x</a>')
})

test('schemeless URLs are dropped — the allowlist is scheme-prefixed or nothing', () => {
  // A relative URL resolves against the admin origin at render time, which is
  // neither a safe target nor something the sender may point a reader at.
  assert.equal(sanitizeEmailHtml('<a href="/internal/path">x</a>').html.includes('href'), false)
  assert.equal(sanitizeEmailHtml('<img src="/api/health">').html.includes('src'), false)
  assert.equal(sanitizeEmailHtml('<a href="//evil.example/x">x</a>').html.includes('href'), false)
})

test('a sender-supplied data-blocked-src is stripped, not trusted', () => {
  // Only the sanitizer may park a URL there — otherwise "load images" would
  // fetch a URL that never passed the remote-content decision.
  const result = sanitizeEmailHtml('<img data-blocked-src="https://t.example/p.gif">')
  assert.equal(result.blockedRemoteContent, false)
  assert.equal(result.html.includes('blocked-src'), false)
})

test('metadata elements are removed with their content', () => {
  const result = sanitizeEmailHtml(
    '<head><title>Sub</title></head><template><img src="https://t.example/x.png"></template><p>body</p>',
  )
  assert.equal(result.html, '<p>body</p>')
  assert.equal(result.blockedRemoteContent, false)
})
