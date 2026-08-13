import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CURSOR_SENTINEL,
  cursorMarkerOffset,
  locateCursorBlock,
  repairStreamingTail,
  splitMarkdownBlockSpans,
  splitMarkdownBlocks,
  withCursorMarker,
} from '../src/facades/threads/document-markdown.js'

test('blocks split on top-level blank lines only', () => {
  assert.deepEqual(splitMarkdownBlocks('# Title\n\nFirst para\n\n\nSecond para'), [
    '# Title',
    'First para',
    'Second para',
  ])
})

test('a block span is exactly the slice of the document it came from', () => {
  const markdown = '# Title\n\nFirst para\n\n\nSecond para'
  for (const span of splitMarkdownBlockSpans(markdown)) {
    assert.equal(markdown.slice(span.start, span.end), span.text)
  }
})

test('a blank line inside a backtick fence never splits a block', () => {
  const markdown = '```js\nconst a = 1\n\nconst b = 2\n```\n\nAfter'
  assert.deepEqual(splitMarkdownBlocks(markdown), [
    '```js\nconst a = 1\n\nconst b = 2\n```',
    'After',
  ])
})

test('tilde fences behave like backtick fences', () => {
  const markdown = '~~~\nline\n\nline\n~~~\n\nAfter'
  assert.deepEqual(splitMarkdownBlocks(markdown), ['~~~\nline\n\nline\n~~~', 'After'])
})

test('a long fence is closed only by an equal-or-longer fence of the same char', () => {
  const markdown = '````\n```\n\nstill code\n````\n\nAfter'
  assert.deepEqual(splitMarkdownBlocks(markdown), [
    '````\n```\n\nstill code\n````',
    'After',
  ])
})

test('a tilde fence is not closed by backticks', () => {
  const markdown = '~~~\n```\n\ninside\n~~~\n\nAfter'
  assert.deepEqual(splitMarkdownBlocks(markdown), ['~~~\n```\n\ninside\n~~~', 'After'])
})

test('a fence lookalike inside an inline code span opens nothing', () => {
  const markdown = 'Open span `foo\n``` still text\nbar` done\n\nAfter'
  assert.deepEqual(splitMarkdownBlocks(markdown), [
    'Open span `foo\n``` still text\nbar` done',
    'After',
  ])
})

test('a backtick fence whose info string contains a backtick is not a fence', () => {
  const markdown = '```a`b\n\nAfter'
  assert.deepEqual(splitMarkdownBlocks(markdown), ['```a`b', 'After'])
})

test('non-English and emoji content splits the same way', () => {
  const markdown = '# Zápis z porady 🎉\n\nPrvní odstavec — s pomlčkou.\n\n- položka'
  assert.deepEqual(splitMarkdownBlocks(markdown), [
    '# Zápis z porady 🎉',
    'První odstavec — s pomlčkou.',
    '- položka',
  ])
})

// --- locating the write cursor ---

const spansOf = (markdown: string) => splitMarkdownBlockSpans(markdown)

test('the cursor at the end of the document is the tail block, at its end', () => {
  const markdown = '# Title\n\nBody text'
  const located = locateCursorBlock(spansOf(markdown), markdown.length)

  assert.deepEqual(located, { blockIndex: 1, localOffset: 9 })
})

test('the cursor inside a middle block reports its local offset', () => {
  const markdown = 'One\n\nTwo\n\nThree'
  const located = locateCursorBlock(spansOf(markdown), 7)

  assert.deepEqual(located, { blockIndex: 1, localOffset: 2 })
})

test('a cursor in the blank lines between blocks belongs to the one that follows', () => {
  const markdown = 'One\n\nTwo'
  const located = locateCursorBlock(spansOf(markdown), 4)

  assert.deepEqual(located, { blockIndex: 1, localOffset: 0 })
})

test('an empty document has nowhere to put a cursor', () => {
  assert.equal(locateCursorBlock(spansOf(''), 0), null)
})

// --- placing the marker where it cannot change the parse ---

test('the marker goes to the end of the line the cursor is on', () => {
  assert.equal(cursorMarkerOffset('one\ntwo\nthree', 5), 7)
  assert.equal(withCursorMarker('one\ntwo\nthree', 5), `one\ntwo${CURSOR_SENTINEL}\nthree`)
})

test('a marker never lands inside a heading, a bullet or a fence marker', () => {
  // Mid-`##`, mid-bullet and mid-fence offsets all resolve to a line end.
  assert.equal(cursorMarkerOffset('## Heading', 1), 10)
  assert.equal(cursorMarkerOffset('- item one', 1), 10)
  assert.equal(withCursorMarker('## Heading', 1), `## Heading${CURSOR_SENTINEL}`)
})

test('a cursor inside fenced code walks back to the last line before the fence', () => {
  const block = 'Intro line\n```ts\nconst a = 1\n```'
  assert.equal(cursorMarkerOffset(block, 20), 10)
  assert.equal(
    withCursorMarker(block, 20),
    `Intro line${CURSOR_SENTINEL}\n\`\`\`ts\nconst a = 1\n\`\`\``,
  )
})

test('a block that is nothing but code gets no marker at all', () => {
  const block = '```ts\nconst a = 1\n```'
  assert.equal(cursorMarkerOffset(block, 8), null)
  assert.equal(withCursorMarker(block, 8), block)
})

test('a cursor past the block end still lands on the last line', () => {
  assert.equal(cursorMarkerOffset('one\ntwo', 900), 7)
})

test('the marker is invisible and zero-width by construction', () => {
  assert.equal(CURSOR_SENTINEL, '⁠')
  assert.equal(CURSOR_SENTINEL.length, 1)
})

// --- rendering the block still being written ---

test('an unclosed fence is closed for rendering with the same marker', () => {
  assert.equal(repairStreamingTail('```ts\nconst a ='), '```ts\nconst a =\n```')
  assert.equal(repairStreamingTail('~~~~\npartial'), '~~~~\npartial\n~~~~')
})

test('unbalanced emphasis is closed innermost-first', () => {
  assert.equal(repairStreamingTail('This is **bold and *ital'), 'This is **bold and *ital***')
  assert.equal(repairStreamingTail('A `code frag'), 'A `code frag`')
})

test('balanced emphasis and list bullets are left alone', () => {
  assert.equal(repairStreamingTail('* item with **bold** text'), '* item with **bold** text')
  assert.equal(repairStreamingTail('---'), '---')
  assert.equal(repairStreamingTail('```\ndone\n```'), '```\ndone\n```')
})

test('asterisks inside a closed code span are not emphasis', () => {
  assert.equal(repairStreamingTail('Use `a * b` here'), 'Use `a * b` here')
})
