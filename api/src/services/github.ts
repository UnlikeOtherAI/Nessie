// Minimal GitHub REST client for the Feedback section: create an issue in a
// repo. Uses the native fetch (Node 18+), mirroring the outbound-HTTP pattern in
// external-auth.ts. No SDK dependency — one endpoint is all we need.

export type CreateGithubIssueInput = {
  token: string
  owner: string
  repo: string
  title: string
  body: string
}

export type GithubIssue = {
  number: number
  htmlUrl: string
}

export const createGithubIssue = async (input: CreateGithubIssueInput): Promise<GithubIssue> => {
  const { token, owner, repo, title, body } = input

  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': 'nessie-feedback',
      'x-github-api-version': '2022-11-28',
    },
    body: JSON.stringify({ title, body }),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`GitHub issue creation failed (${response.status}): ${text}`)
  }

  const payload = (await response.json()) as { number?: number; html_url?: string }
  // Defensive: only trust a numeric id and an https URL (the URL is later
  // rendered as an <a href>). GitHub always returns https://github.com/… here.
  if (
    typeof payload.number !== 'number'
    || typeof payload.html_url !== 'string'
    || !payload.html_url.startsWith('https://')
  ) {
    throw new Error('GitHub issue creation returned an unexpected response')
  }
  return { number: payload.number, htmlUrl: payload.html_url }
}
