const BUILD_CHECK_INTERVAL_MS = 5 * 60 * 1000
const RELOAD_MARKER = 'nessie.buildFreshnessReloaded'

const assetSelector = 'script[src], link[rel="stylesheet"][href]'

type FreshnessWindow = Window & {
  __nessieBuildFreshnessInstalled?: boolean
}

const absolutePath = (url: string, baseUrl: string): string | null => {
  try {
    const parsed = new URL(url, baseUrl)
    return parsed.origin === window.location.origin ? `${parsed.pathname}${parsed.search}` : null
  } catch {
    return null
  }
}

const assetSignatureFromDocument = (documentRoot: Document, baseUrl: string): string => {
  const assets = Array.from(documentRoot.querySelectorAll<HTMLScriptElement | HTMLLinkElement>(
    assetSelector,
  ))
    .map((element) =>
      element instanceof HTMLScriptElement
        ? absolutePath(element.src, baseUrl)
        : absolutePath(element.href, baseUrl),
    )
    .filter((asset): asset is string => Boolean(asset))

  return [...new Set(assets)].sort().join('|')
}

const fetchLatestAssetSignature = async (): Promise<string | null> => {
  const response = await fetch('/', {
    cache: 'no-store',
    headers: { Accept: 'text/html' },
  })

  if (!response.ok) return null

  const html = await response.text()
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  return assetSignatureFromDocument(parsed, window.location.origin)
}

export const installBuildFreshnessCheck = () => {
  if (!import.meta.env.PROD || typeof window === 'undefined' || typeof document === 'undefined') {
    return
  }

  const freshnessWindow = window as FreshnessWindow
  if (freshnessWindow.__nessieBuildFreshnessInstalled) return

  const currentSignature = assetSignatureFromDocument(document, window.location.href)
  if (!currentSignature) return
  freshnessWindow.__nessieBuildFreshnessInstalled = true

  let checking = false

  const checkForFreshBuild = async () => {
    if (checking) return
    checking = true

    try {
      const latestSignature = await fetchLatestAssetSignature()
      if (!latestSignature || latestSignature === currentSignature) {
        sessionStorage.removeItem(RELOAD_MARKER)
        return
      }

      if (sessionStorage.getItem(RELOAD_MARKER) === latestSignature) return

      sessionStorage.setItem(RELOAD_MARKER, latestSignature)
      window.location.reload()
    } catch {
      // Network failures should never interrupt the current app session.
    } finally {
      checking = false
    }
  }

  const checkWhenVisible = () => {
    if (document.visibilityState === 'visible') void checkForFreshBuild()
  }

  window.addEventListener('focus', checkWhenVisible)
  window.addEventListener('pageshow', checkWhenVisible)
  document.addEventListener('visibilitychange', checkWhenVisible)
  // Installed once for the tab's whole lifetime (guarded above), so the
  // interval is meant to outlive any component — there is nothing to unmount
  // it against.
  window.setInterval(checkWhenVisible, BUILD_CHECK_INTERVAL_MS)
}
