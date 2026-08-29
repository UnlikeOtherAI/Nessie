import { useCallback, useLayoutEffect, useRef } from 'react'

// Session-scoped scroll positions keyed by a caller-supplied id. A page that
// unmounts on tab switch (the shell renders one <Outlet>) otherwise loses its
// scroll; this ledger survives the unmount so returning restores it.
const scrollTopByKey = new Map<string, number>()

export type ScrollMemory = {
  ref: (node: HTMLElement | null) => void
  onScroll: () => void
}

// Attach `ref` and `onScroll` to a scroll container to remember its position
// across mounts. `key` must be stable and unique per scroll region; a nullish
// key disables the memory (nothing saved or restored).
export const useScrollMemory = (key: string | undefined | null): ScrollMemory => {
  const nodeRef = useRef<HTMLElement | null>(null)

  const restore = useCallback((node: HTMLElement) => {
    if (!key) return
    const saved = scrollTopByKey.get(key)
    if (saved == null) return
    node.scrollTop = saved
    // On remount the list may still be hydrating from cache, so its content —
    // and therefore its scrollable height — can arrive a frame after mount.
    // Re-apply once the next frame has laid it out.
    requestAnimationFrame(() => {
      if (nodeRef.current === node) node.scrollTop = saved
    })
  }, [key])

  const ref = useCallback((node: HTMLElement | null) => {
    nodeRef.current = node
    if (node) restore(node)
  }, [restore])

  // A key change (e.g. switching which region this container represents) must
  // re-restore against the already-mounted node.
  useLayoutEffect(() => {
    if (nodeRef.current) restore(nodeRef.current)
  }, [restore])

  const onScroll = useCallback(() => {
    if (!key) return
    const node = nodeRef.current
    if (node) scrollTopByKey.set(key, node.scrollTop)
  }, [key])

  return { ref, onScroll }
}
