/**
 * The JQL a text search sends, built in one place so the quoting is one
 * decision rather than one per call site.
 *
 * JQL is a query language and the text is a person's words, so the words are
 * quoted and their quotes and backslashes escaped. Without that, a search for
 * `" OR project = "SECRET` would close the string and append a clause of its
 * own, and the credential asking would happily read a project this source was
 * never pointed at.
 */
export const jiraSearchJql = (projectKey: string, text: string): string => {
  const term = text.replace(/([\\"])/g, '\\$1')
  const project = projectKey.replace(/([\\"])/g, '\\$1')
  return `project = "${project}" AND text ~ "${term}" ORDER BY updated DESC`
}
