/**
 * The GitHub search query a text search sends.
 *
 * GitHub's grammar is space-separated qualifiers, so `repo:` is what keeps the
 * search inside the repository this source attached. A person's words are
 * quoted as a phrase and their own quotes removed first: a stray `"` would
 * close the phrase and let the rest be read as qualifiers — including a second
 * `repo:` pointing somewhere this credential can reach but this project never
 * connected.
 */
export const gitHubSearchQuery = (owner: string, repo: string, text: string): string => {
  const term = text.replace(/"/g, ' ').replace(/\s+/g, ' ').trim()
  return `repo:${owner}/${repo} is:issue "${term}"`
}
