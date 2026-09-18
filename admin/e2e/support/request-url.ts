/**
 * The URL a stubbed `fetch` was called with.
 *
 * `fetch`'s first argument is `string | URL | Request`, and both fixtures that
 * stub it reached straight for `.url` — which a `URL` does not have. It read
 * as correct and would have thrown on the one call shape neither fixture
 * happens to make today; nothing caught it because nothing typechecked the
 * fixtures at all.
 */
export const requestUrl = (input: RequestInfo | URL): string => {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.href : input.url
}
