// Framework-free phone Back registry. Kept React-independent so structural
// tests can exercise the ownership contract (numeric priority, single active
// owner, explicit active selection) without a component tree, and so a later
// route-history provider or native gesture bridge can consume the same store
// without depending on React internals.

export type LocalBackRegistration = {
  // Explicit active flag. Callers pass the current state expression; the
  // registry never infers activity from registration order, so mount order
  // between retained columns can never flip Back ownership.
  active: boolean
  id: string
  label: string
  onBack: () => void
  // Numeric precedence — the deepest in-page stack registers the highest
  // number (knowledge: folder 11, document 12, history 13, editor 14). Ties
  // never happen between live owners: only one column/detail per browser is
  // visible on a phone, and hidden owners must pass active: false.
  priority?: number
  // Whether the edge swipe may drive this owner closed. Default true; an
  // owner that must not be dismissed by a gesture (an editor mid-flush, a
  // streaming document) registers false. Read by resolveBack.
  swipeable?: boolean
}

export type LocalBackSnapshot = {
  // The highest-priority active registration, or null when the shell's own
  // route Back / menu doorway owns the leading control.
  active: LocalBackRegistration | null
  // Every active registration's id, in registration order — diagnostic surface
  // for tests and for the later shared navigation provider.
  activeIds: string[]
}

type Listener = () => void

const byPriority = (registration: LocalBackRegistration): number =>
  registration.priority ?? 0

const sameSnapshot = (left: LocalBackSnapshot, right: LocalBackSnapshot): boolean =>
  left.active?.id === right.active?.id
  && left.active?.label === right.active?.label
  && left.activeIds.length === right.activeIds.length
  && left.activeIds.every((id, index) => id === right.activeIds[index])

export const createLocalBackRegistry = () => {
  const registrations = new Map<string, LocalBackRegistration>()
  const listeners = new Set<Listener>()
  let snapshot: LocalBackSnapshot = { active: null, activeIds: [] }

  const publish = () => {
    const activeRegistrations = [...registrations.values()].filter(
      (registration) => registration.active,
    )
    const active =
      [...activeRegistrations].sort(
        (left, right) => byPriority(right) - byPriority(left),
      )[0] ?? null
    const next: LocalBackSnapshot = {
      active,
      activeIds: activeRegistrations.map((registration) => registration.id),
    }
    // A structurally identical snapshot reuses the previous object so
    // useSyncExternalStore subscribers never re-render for a no-op publish.
    snapshot = sameSnapshot(snapshot, next) ? snapshot : next
    for (const listener of listeners) listener()
  }

  // Re-registering an id updates its action/label/priority in place. Order
  // never decides precedence (priority does), so updates deliberately keep the
  // entry's insertion position: activeIds stays registration-ordered.
  const register = (registration: LocalBackRegistration): (() => void) => {
    registrations.set(registration.id, registration)
    publish()
    return () => {
      registrations.delete(registration.id)
      publish()
    }
  }

  const subscribe = (listener: Listener): (() => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  return {
    getSnapshot: () => snapshot,
    register,
    subscribe,
  }
}

export type LocalBackRegistry = ReturnType<typeof createLocalBackRegistry>
