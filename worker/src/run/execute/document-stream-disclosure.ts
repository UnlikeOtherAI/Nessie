type DocumentStreamDisclosureInput = {
  /**
   * Whether the run's reply is restricted right now. Evaluated per fragment:
   * a privileged source can enter between model iterations. The production
   * predicate is monotone because the source sink only grows and the
   * destination stays fixed, so a closed broadcast can never reopen.
   */
  isRestricted: () => boolean
  /** Persist the run's current basis before restricted durable data is readable. */
  persistRestrictionBasis: () => Promise<void>
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
  let restrictionPersisted = false
  let restrictionBarrier: Promise<void> = Promise.resolve()
  let durableFeedBarrier: Promise<void> = Promise.resolve()

  const beforeRestrictedReadable = async (): Promise<void> => {
    if (!input.isRestricted() || restrictionPersisted) {
      await restrictionBarrier
      return
    }
    restrictionPersisted = true
    restrictionBarrier = input.persistRestrictionBasis()
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
