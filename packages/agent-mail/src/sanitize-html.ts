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
 * kept), and an attribute not named below is dropped. A parser is deliberately
 * not used — the stored value is display markup, and adding a DOM dependency to
 * the worker to gain nothing over a strict allowlist is not worth the surface.
 */

const ALLOWED_TAGS = new Set([
  'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'code', 'col', 'colgroup',
  'dd', 'div', 'dl', 'dt', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i',
  'img', 'li', 'ol', 'p', 'pre', 's', 'small', 'span', 'strong', 'sub', 'sup',
  'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul',
])

/** Elements whose *content* is removed with them, not just their tags. */
const VOID_CONTENT_TAGS = ['script', 'style', 'head', 'title', 'noscript', 'template', 'svg', 'math']

const ALLOWED_ATTRS: Record<string, ReadonlySet<string>> = {
  a: new Set(['href', 'title']),
  img: new Set(['alt', 'title', 'width', 'height', 'src']),
}

const GLOBAL_ATTRS = new Set(['dir', 'lang'])

const SAFE_URL = /^(https?:|mailto:|tel:|cid:)/i

const stripDangerousElements = (html: string): string => {
  let out = html
  for (const tag of VOID_CONTENT_TAGS) {
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'), '')
    // An unclosed dangerous element would otherwise survive as a bare tag.
    out = out.replace(new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi'), '')
  }
  // Comments can hide conditional markup that some clients still evaluate.
  return out.replace(/<!--[\s\S]*?-->/g, '')
}

const parseAttributes = (raw: string): Array<{ name: string; value: string }> => {
  const attrs: Array<{ name: string; value: string }> = []
  const pattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(raw)) !== null) {
    attrs.push({
      name: (match[1] as string).toLowerCase(),
      value: match[3] ?? match[4] ?? match[5] ?? '',
    })
  }
  return attrs
}

const escapeAttr = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export type SanitizeResult = {
  html: string
  /** True when at least one remote image was withheld, so the UI can offer "load images". */
  blockedRemoteContent: boolean
}

export const sanitizeEmailHtml = (input: string | null | undefined): SanitizeResult => {
  if (!input) return { blockedRemoteContent: false, html: '' }

  let blockedRemoteContent = false
  const stripped = stripDangerousElements(input)

  const html = stripped.replace(
    /<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g,
    (_full, closing: string, rawName: string, rawAttrs: string) => {
      const tag = rawName.toLowerCase()
      if (!ALLOWED_TAGS.has(tag)) return ''
      if (closing) return `</${tag}>`

      const allowed = ALLOWED_ATTRS[tag]
      const kept: string[] = []
      for (const attr of parseAttributes(rawAttrs)) {
        // Event handlers and anything the allowlist does not name.
        if (attr.name.startsWith('on')) continue
        const permitted = allowed?.has(attr.name) || GLOBAL_ATTRS.has(attr.name)
        if (!permitted) continue

        if (attr.name === 'href') {
          if (!SAFE_URL.test(attr.value.trim())) continue
          kept.push(`href="${escapeAttr(attr.value.trim())}"`)
          // An external link opened from mail must not reach back into the
          // opener, and must not leak the mailbox URL as a referrer.
          kept.push('rel="noopener noreferrer nofollow"')
          kept.push('target="_blank"')
          continue
        }

        if (attr.name === 'src') {
          const value = attr.value.trim()
          if (!SAFE_URL.test(value)) continue
          // Remote images are withheld until the reader asks for them; `cid:`
          // parts are attachments we already stored and are safe to render.
          if (/^https?:/i.test(value)) {
            blockedRemoteContent = true
            kept.push(`data-blocked-src="${escapeAttr(value)}"`)
            continue
          }
          kept.push(`src="${escapeAttr(value)}"`)
          continue
        }

        kept.push(`${attr.name}="${escapeAttr(attr.value)}"`)
      }

      return kept.length > 0 ? `<${tag} ${kept.join(' ')}>` : `<${tag}>`
    },
  )

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
