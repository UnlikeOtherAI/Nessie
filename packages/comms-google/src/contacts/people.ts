import { requestJson, encodeForm, type FetchLike } from '../http.js'

/**
 * Contact lookup, so "email Marek about the delivery" can find an address.
 *
 * Two sources, because they answer different questions: `people:searchContacts`
 * covers the person's own contacts, and `people:searchDirectoryPeople` covers
 * their Team directory. Colleagues inside Nessie are already resolvable
 * through `people_search`; this is for everyone else.
 */

const PEOPLE_API_BASE = 'https://people.googleapis.com/v1'

export type GoogleContact = {
  name: string
  email: string
  source: 'contacts' | 'directory'
}

type RawPerson = {
  names?: { displayName?: unknown }[]
  emailAddresses?: { value?: unknown }[]
}

const toContacts = (
  people: unknown[],
  source: GoogleContact['source'],
): GoogleContact[] =>
  people.flatMap((raw) => {
    const person = (raw as { person?: RawPerson }).person ?? (raw as RawPerson)
    const email = person?.emailAddresses?.find(
      (entry) => typeof entry?.value === 'string',
    )?.value
    if (typeof email !== 'string') return []
    const displayName = person?.names?.find(
      (entry) => typeof entry?.displayName === 'string',
    )?.displayName
    return [{
      name: typeof displayName === 'string' ? displayName : email,
      email,
      source,
    }]
  })

/**
 * Search both sources and merge, preferring a personal contact over a
 * directory hit for the same address — the person's own name for someone is
 * the one they will recognise.
 */
export const searchGoogleContacts = async (
  fetchImpl: FetchLike,
  accessToken: string,
  input: { query: string; maxResults?: number },
): Promise<GoogleContact[]> => {
  const pageSize = String(Math.min(Math.max(input.maxResults ?? 10, 1), 30))
  const readMask = 'names,emailAddresses'

  const results: GoogleContact[] = []
  // Each source is best-effort: a personal account has no directory, and a
  // failure to reach one must not lose the other's answers.
  try {
    const { body } = await requestJson(
      fetchImpl,
      'people.searchContacts',
      `${PEOPLE_API_BASE}/people:searchContacts`
        + `?${encodeForm({ query: input.query, pageSize, readMask })}`,
      { headers: { authorization: `Bearer ${accessToken}` } },
    )
    results.push(
      ...toContacts((body as { results?: unknown[] }).results ?? [], 'contacts'),
    )
  } catch {
    // fall through to the directory
  }

  try {
    const { body } = await requestJson(
      fetchImpl,
      'people.searchDirectoryPeople',
      `${PEOPLE_API_BASE}/people:searchDirectoryPeople`
        + `?${encodeForm({
          query: input.query,
          pageSize,
          readMask,
          sources: 'DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE',
        })}`,
      { headers: { authorization: `Bearer ${accessToken}` } },
    )
    results.push(
      ...toContacts((body as { people?: unknown[] }).people ?? [], 'directory'),
    )
  } catch {
    // a consumer account has no directory; personal contacts alone are fine
  }

  const seen = new Map<string, GoogleContact>()
  for (const contact of results) {
    const key = contact.email.toLowerCase()
    if (!seen.has(key)) seen.set(key, contact)
  }
  return [...seen.values()]
}
