/**
 * What to call a person when UnlikeOtherAI has not been told their name.
 *
 * Neither UOA's public sign-up nor its invitation registration asks for one, so
 * anybody who joined by e-mail arrives with no `name` claim at all. Every
 * roster, owner cell and candidate row then read the literal "Unnamed member",
 * which is both unhelpful and wrong — their address says who they are
 * (2026-09-13 invitation e2e run, F6).
 *
 * This is **presentation only**. Nothing here is written back: UOA owns human
 * identity, and `api/src/services/identity-display.ts` deliberately refuses to
 * synthesize a name into the local mirror, because manufacturing one is what
 * made Nessie a second profile authority. A humanised address is a label drawn
 * at render time from a value UOA already gave us, and it disappears the moment
 * UOA asserts a real name.
 */

/**
 * A name that is really an address. UOA fills `name` with the e-mail for
 * accounts that never supplied one, and a raw address reads badly in a roster —
 * so it is treated as "no name asserted" rather than as a name.
 */
const isEmailShaped = (value: string): boolean => /^[^\s@]+@[^\s@]+$/.test(value)

const capitalise = (word: string): string => {
  const [first, ...rest] = [...word]
  return first === undefined ? '' : first.toLocaleUpperCase() + rest.join('')
}

/**
 * `nessie-test-a@example.com` → "Nessie Test A", `john.doe+nessie@…` → "John
 * Doe". Sub-addressing is a routing detail rather than part of anyone's name,
 * so everything from the first `+` is dropped. The rest of each word is left
 * exactly as written, so initialisms survive.
 *
 * `undefined` when there is nothing to work with — a blank value, or an address
 * whose local part is empty or made only of separators. The caller decides what
 * to say then; this never invents a placeholder.
 */
export const humaniseEmailLocalPart = (
  email: string | null | undefined,
): string | undefined => {
  const address = email?.trim()
  if (!address) return undefined
  const at = address.lastIndexOf('@')
  // `at === 0` is an address with no local part at all: nothing to humanise.
  if (at === 0) return undefined
  const localPart = (at === -1 ? address : address.slice(0, at)).split('+')[0] ?? ''
  const words = localPart.split(/[._\-\s]+/u).filter(Boolean).map(capitalise)
  return words.length > 0 ? words.join(' ') : undefined
}

/**
 * The best label for one person: the name UOA asserted, else their address
 * humanised, else `undefined` so the caller can say what an empty row means in
 * its own surface ("Unnamed member", "Invitation", "another member").
 *
 * `email` is optional because some projections carry no address at all —
 * `AgentOwner`, for instance, deliberately omits one. Those still pass through
 * here, because for them the *display name itself* is often the address.
 */
export const memberDisplayName = (
  displayName?: string | null,
  email?: string | null,
): string | undefined => {
  const asserted = displayName?.trim()
  if (asserted && !isEmailShaped(asserted)) return asserted
  return humaniseEmailLocalPart(email ?? asserted)
}
