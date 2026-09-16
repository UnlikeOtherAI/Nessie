/**
 * Inbound HTML is sanitized once, at ingest, and only the sanitized form is
 * stored. Sanitizing at render instead would mean every future reader — the
 * mailbox pane, a notification preview, an export — had to remember to do it.
 *
 * Two separate problems are solved here:
 *
 *  1. **Script and navigation.** Anything that can execute or exfiltrate is
 *     removed outright: script/style/iframe/object/form and every `on*`
 *     handler, plus `javascript:`/`data:`/`vbscript:` URLs on the attributes
 *     that survive.
 *  2. **Remote content.** A remote image in an email is a tracking pixel by
 *     default — loading it tells the sender the mail was opened, by whom, and
 *     when. Remote `src` values are moved to `data-blocked-src` so the viewer
 *     can choose to load them per message; nothing external is fetched until a
 *     person asks.
 *
 * This is an allowlist: an element not named below loses its tags (its text is
 * kept), and an attribute not named below is dropped.
 *
 * The allowlist is enforced by a real HTML parser (`sanitize-html`, backed by
 * htmlparser2), not by regular expressions. A regex sanitizer decides what a
 * tag is by pattern-matching the raw text; the browser decides by parsing —
 * and every gap between the two readings (mutation XSS, entity-encoded
 * schemes, quotes that do not balance, foreign-content `<svg>`/`<math>`
 * parsing modes) is a gap the sender controls. The parser reads the markup
 * the way the browser will, so there is no second reading to exploit, and the
 * rendered output is its re-serialization rather than fragments of the
 * attacker's original bytes. It runs server-side in Node at ingest, which is
 * why this is `sanitize-html` and not a DOM-dependent sanitizer like
 * DOMPurify.
 */
import sanitizeHtml from 'sanitize-html'

const ALLOWED_TAGS = [
  'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'code', 'col', 'colgroup',
  'dd', 'div', 'dl', 'dt', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i',
  'img', 'li', 'ol', 'p', 'pre', 's', 'small', 'span', 'strong', 'sub', 'sup',
  'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul',
]

/**
 * Elements whose *content* is removed with them, not just their tags.
 * `script`/`style`/`textarea`/`option`/`xmp` are sanitize-html's default
 * non-text set and must stay; the rest extend the same treatment to the
 * metadata and foreign-content elements the old allowlist already gutted.
 */
const NON_TEXT_TAGS = [
  'script', 'style', 'textarea', 'option', 'xmp',
  'head', 'title', 'noscript', 'template', 'svg', 'math',
]

/**
 * URL schemes allowed on `href`/`src`. Everything else — `javascript:`,
 * `data:`, `vbscript:` — is dropped by the scheme check, and protocol-relative
 * URLs are refused too (`allowProtocolRelative: false` below) so the list is
 * the whole policy rather than the policy plus the page's own scheme.
 */
const ALLOWED_SCHEMES = ['http', 'https', 'mailto', 'tel', 'cid']

const SAFE_URL = new RegExp(`^(?:${ALLOWED_SCHEMES.join('|')}):`, 'i')

const stripDangerousElements = (html: string): string => {
  let out = html
  for (const tag of NON_TEXT_TAGS) {
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'), '')
    // An unclosed dangerous element would otherwise survive as a bare tag.
    out = out.replace(new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi'), '')
  }
  // Comments can hide conditional markup that some clients still evaluate.
  return out.replace(/<!--[\s\S]*?-->/g, '')
}

export type SanitizeResult = {
  html: string
  /** True when at least one remote image was withheld, so the UI can offer "load images". */
  blockedRemoteContent: boolean
}

export const sanitizeEmailHtml = (input: string | null | undefined): SanitizeResult => {
  if (!input) return { blockedRemoteContent: false, html: '' }

  let blockedRemoteContent = false

  const html = sanitizeHtml(input, {
    allowedTags: ALLOWED_TAGS,
    nonTextTags: NON_TEXT_TAGS,
    allowedAttributes: {
      a: ['href', 'title', 'rel', 'target'],
      // `data-blocked-src` is listed so the value WE park there (in the img
      // transform below) survives the attribute filter; a sender-supplied
      // one never reaches the filter because the transform deletes it first.
      img: ['alt', 'title', 'width', 'height', 'src', 'data-blocked-src'],
      '*': ['dir', 'lang'],
    },
    allowedSchemes: ALLOWED_SCHEMES,
    allowProtocolRelative: false,
    transformTags: {
      a: (tagName, attribs) => {
        const next = { ...attribs }
        // rel/target are ours to set, never the sender's.
        delete next.rel
        delete next.target
        const href = attribs.href?.trim()
        // The scheme allowlist is decided here, not delegated to the generic
        // scheme filter, because that filter waves through schemeless
        // (relative) URLs and the policy is scheme-prefixed or nothing.
        if (href && !SAFE_URL.test(href)) {
          delete next.href
        } else if (href) {
          next.href = href
          // An external link opened from mail must not reach back into the
          // opener, and must not leak the mailbox URL as a referrer.
          next.rel = 'noopener noreferrer nofollow'
          next.target = '_blank'
        }
        return { tagName, attribs: next }
      },
      img: (tagName, attribs) => {
        const next = { ...attribs }
        // A sender-supplied data-blocked-src would load the moment the reader
        // pressed "load images" without ever passing the scheme check.
        delete next['data-blocked-src']
        const src = attribs.src?.trim()
        if (src && !SAFE_URL.test(src)) {
          delete next.src
        } else if (src && /^https?:/i.test(src)) {
          // Remote images are withheld until the reader asks for them; `cid:`
          // parts are attachments we already stored and are safe to render.
          delete next.src
          next['data-blocked-src'] = src
          blockedRemoteContent = true
        }
        return { tagName, attribs: next }
      },
    },
  })

  return { blockedRemoteContent, html }
}

/** Plain-text fallback used for the snippet when a message carries only HTML. */
export const htmlToText = (html: string | null | undefined): string => {
  if (!html) return ''
  return stripDangerousElements(html)
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|tr|li|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export const buildSnippet = (text: string, limit = 240): string => {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1)}…`
}
