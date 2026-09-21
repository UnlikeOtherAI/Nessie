import type { NormalisedAttachment } from './items.js'

/**
 * Provider files referenced *inside* Markdown — a screenshot pasted into an
 * issue description or a comment — rather than listed as attachments.
 *
 * One scanner for every adapter, because the rule is the same everywhere: only
 * a URL on one of the adapter's own asset hosts is a file this sync may fetch
 * (the fetch envelope would refuse any other host anyway), and everything else
 * — a link to a PR, a Figma frame — is prose, not an attachment.
 */

// `![alt](url "title")` and `[text](url)`. The URL group stops at whitespace or
// the closing paren, which is how CommonMark ends an unbracketed destination.
const MARKDOWN_LINK = /!?\[[^\]]*\]\(\s*<?([^\s)>]+)>?(?:\s+"[^"]*")?\s*\)/g

/**
 * What counts as a provider file: a host list, or an adapter's own path-aware
 * predicate for providers whose upload host also serves ordinary pages
 * (`github.com/user-attachments/…`, Trello's attachment downloads).
 */
export type AssetUrlMatcher = readonly string[] | ((url: string) => boolean)

/** Every distinct asset URL a Markdown text references, in order. */
export const inlineAssetUrls = (
  markdown: string | null | undefined,
  assetHosts: AssetUrlMatcher,
): string[] => {
  if (!markdown) return []
  if (typeof assetHosts !== 'function' && assetHosts.length === 0) return []
  const seen = new Set<string>()
  for (const match of markdown.matchAll(MARKDOWN_LINK)) {
    const raw = match[1]
    if (!raw) continue
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      continue
    }
    if (url.protocol !== 'https:') continue
    const isAsset = typeof assetHosts === 'function' ? assetHosts(raw) : assetHosts.includes(url.hostname)
    if (!isAsset) continue
    seen.add(raw)
  }
  return [...seen]
}

/** The same scan, shaped as the attachments the apply step upserts. */
export const inlineAssetsIn = (
  markdown: string | null | undefined,
  assetHosts: AssetUrlMatcher,
  at: { issueExternalId: string; commentExternalId?: string; createdAt: string },
): NormalisedAttachment[] =>
  inlineAssetUrls(markdown, assetHosts).map((url) => ({
    issueExternalId: at.issueExternalId,
    ...(at.commentExternalId ? { commentExternalId: at.commentExternalId } : {}),
    url,
    title: lastPathSegment(url),
    kind: 'file' as const,
    inline: true,
    createdAt: at.createdAt,
  }))

const lastPathSegment = (url: string): string | null => {
  try {
    const segment = new URL(url).pathname.split('/').filter(Boolean).pop()
    return segment ? decodeURIComponent(segment) : null
  } catch {
    return null
  }
}
