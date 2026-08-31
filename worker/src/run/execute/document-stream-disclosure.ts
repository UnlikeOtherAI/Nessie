import type { BasisScope } from './disclosure-basis.js'

type DocumentStreamDisclosureInput = {
  /**
   * Whether the run's reply is restricted right now. Evaluated per fragment:
   * a privileged source can enter between model iterations. The production
   * predicate is monotone because the source sink only grows and the
   * destination stays fixed, so a closed broadcast can never reopen.
   */
  isRestricted: () => boolean
  /** The exact, monotone basis the run has accumulated so far. */
  getRestrictionBasis: () => readonly BasisScope[]
  /** Persist one captured basis before restricted durable data is readable. */
  persistRestrictionBasis: (basis: readonly BasisScope[]) => Promise<void>
}

export type DocumentStreamDisclosureGate = {
  appendDurable: (append: () => void) => void
  beforeRestrictedReadable: () => Promise<void>
  isRestricted: () => boolean
  settleDurableFeed: () => Promise<void>
}

/**
 * Couples the unfilterable live gate to the durable basis-write barrier.
 *
 * Durable document bytes are intentionally retained: the save compares its
 * independent parse with the recorder's complete text, and entitled reconnects
 * need the complete bootstrap. A restricted append waits for RunBasisScope so
 * the REST reader can never observe privileged bytes during the gap before the
 * final reply stamps the run.
 */
export const createDocumentStreamDisclosureGate = (
  input: DocumentStreamDisclosureInput,
): DocumentStreamDisclosureGate => {
  const persistedScopes = new Set<string>()
  const scheduledScopes = new Set<string>()
  let restrictionBarrier: Promise<void> = Promise.resolve()
  let durableFeedBarrier: Promise<void> = Promise.resolve()
  const scopeKey = (scope: BasisScope): string => `${scope.scopeType}:${scope.scopeId}`

  const beforeRestrictedReadable = async (): Promise<void> => {
    if (!input.isRestricted()) {
      await restrictionBarrier
      return
    }

    const basis = input.getRestrictionBasis()
    const missing = basis.filter((scope) => {
      const key = scopeKey(scope)
      return !persistedScopes.has(key) && !scheduledScopes.has(key)
    })
    if (missing.length > 0) {
      const missingKeys = missing.map(scopeKey)
      for (const key of missingKeys) scheduledScopes.add(key)
      restrictionBarrier = restrictionBarrier
        // A failed stamp withheld its fragment. Let a later fragment retry.
        .catch(() => undefined)
        .then(async () => {
          await input.persistRestrictionBasis(basis)
          for (const scope of basis) persistedScopes.add(scopeKey(scope))
        })
        .finally(() => {
          for (const key of missingKeys) scheduledScopes.delete(key)
        })
    }
    await restrictionBarrier
  }

  return {
    appendDurable: (append) => {
      if (!input.isRestricted()) {
        append()
        return
      }
      durableFeedBarrier = durableFeedBarrier
        .then(async () => {
          await beforeRestrictedReadable()
          append()
        })
        .catch((error: unknown) => {
          // Fail closed: omit a restricted durable fragment whose basis could
          // not be stamped. The in-memory scanner still lets the save proceed.
          console.warn('[worker] document stream basis persistence failed', error)
        })
    },
    beforeRestrictedReadable,
    isRestricted: input.isRestricted,
    settleDurableFeed: async () => {
      await durableFeedBarrier
    },
  }
}
