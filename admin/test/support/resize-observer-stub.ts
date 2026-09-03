/**
 * jsdom implements no ResizeObserver, but D11's popover placement
 * (src/lib/popover-placement-hook.ts) builds one per open popover. A
 * no-op stub is sufficient for suites that never resize: the hook measures
 * once at open, which is exactly the state these assertions read. Suites that
 * exercise a resize install their own firing stub instead.
 */
export const stubResizeObserver = (win: Window & typeof globalThis): void => {
  if (typeof win.ResizeObserver === 'function') return
  win.ResizeObserver = class {
    disconnect(): void {}
    observe(): void {}
    unobserve(): void {}
  } as unknown as typeof ResizeObserver
}
