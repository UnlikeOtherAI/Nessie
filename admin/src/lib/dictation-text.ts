const WORD_EDGE = /^[\p{L}\p{N}]/u
const TRAILING_WORD_EDGE = /[\p{L}\p{N}]$/u

/** Keep words on either side of dictated text from being joined when a
 * recording replaces the caret between them. Unicode classes keep this true
 * for every language rather than a Latin-only character list. */
export const formatDictationInsertion = (before: string, transcript: string, after: string) => {
  const leading = TRAILING_WORD_EDGE.test(before) && WORD_EDGE.test(transcript) ? ' ' : ''
  const trailing = TRAILING_WORD_EDGE.test(transcript) && WORD_EDGE.test(after) ? ' ' : ''
  return `${leading}${transcript}${trailing}`
}
