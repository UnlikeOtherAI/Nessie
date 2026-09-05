/**
 * The page a provider redirects the person's browser back to.
 *
 * Constant by design: it posts the outcome to whatever opened it and
 * otherwise navigates back into the app. There is no caller-supplied return
 * URL anywhere in this flow, which is what stops it being an open redirect
 * with a credential in the query string.
 */
export const callbackPage = (ok: boolean, detail: string): string => `<!doctype html>
<html><head><meta charset="utf-8"><title>Connection</title></head>
<body style="font:14px system-ui;padding:2rem">
<p id="m">${ok ? 'Connected. You can close this window.' : escapeHtml(detail)}</p>
<script>
  var done = function (ok) {
    try {
      window.opener && window.opener.postMessage(
        { source: 'nessie-board-source', ok: ok },
        window.location.origin,
      )
    } catch (error) { /* opener gone: the redirect below is the fallback */ }
    if (!window.opener) window.location.replace('/settings/connections')
  }
  // Trello answers with the token in the fragment rather than a code, so it is
  // read here and submitted once. Every other provider is already finished by
  // the time this page renders.
  var hash = new URLSearchParams(window.location.hash.slice(1))
  var token = hash.get('token')
  var state = hash.get('state')
  if (token && state) {
    fetch('/api/board-sources/connections/trello/complete', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: state, token: token }),
    })
      .then(function (response) {
        document.getElementById('m').textContent = response.ok
          ? 'Connected. You can close this window.'
          : 'Trello did not accept that token.'
        // Clear the fragment so the token does not linger in history.
        history.replaceState(null, '', window.location.pathname)
        done(response.ok)
      })
      .catch(function () { done(false) })
  } else {
    done(${ok ? 'true' : 'false'})
  }
</script>
</body></html>`

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&#39;'
    }
  })
