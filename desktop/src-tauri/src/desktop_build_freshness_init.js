(function () {
  if (window.__nessieBuildFreshnessInstalled) return
  if (window.location.protocol !== 'http:' && window.location.protocol !== 'https:') return

  const BUILD_CHECK_INTERVAL_MS = 5 * 60 * 1000
  const RELOAD_MARKER = 'nessie.buildFreshnessReloaded'
  const ASSET_SELECTOR = 'script[src], link[rel="stylesheet"][href]'

  const absolutePath = (url, baseUrl) => {
    try {
      const parsed = new URL(url, baseUrl)
      return parsed.origin === window.location.origin ? `${parsed.pathname}${parsed.search}` : null
    } catch {
      return null
    }
  }

  const assetSignatureFromDocument = (documentRoot, baseUrl) => {
    const assets = Array.from(documentRoot.querySelectorAll(ASSET_SELECTOR))
      .map((element) =>
        element.tagName === 'SCRIPT'
          ? absolutePath(element.src, baseUrl)
          : absolutePath(element.href, baseUrl),
      )
      .filter(Boolean)

    return Array.from(new Set(assets)).sort().join('|')
  }

  const install = () => {
    if (window.__nessieBuildFreshnessInstalled) return
    const currentSignature = assetSignatureFromDocument(document, window.location.href)
    if (!currentSignature) return
    window.__nessieBuildFreshnessInstalled = true

    let checking = false

    const checkForFreshBuild = async () => {
      if (checking) return
      checking = true
      try {
        const response = await fetch('/', {
          cache: 'no-store',
          headers: { Accept: 'text/html' },
        })
        if (!response.ok) return

        const html = await response.text()
        const parsed = new DOMParser().parseFromString(html, 'text/html')
        const latestSignature = assetSignatureFromDocument(parsed, window.location.origin)
        if (!latestSignature || latestSignature === currentSignature) {
          sessionStorage.removeItem(RELOAD_MARKER)
          return
        }
        if (sessionStorage.getItem(RELOAD_MARKER) === latestSignature) return

        sessionStorage.setItem(RELOAD_MARKER, latestSignature)
        window.location.reload()
      } catch {
        // A transient offline state should not disrupt the current desktop app.
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
    window.setInterval(checkWhenVisible, BUILD_CHECK_INTERVAL_MS)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install, { once: true })
  } else {
    install()
  }
})()
