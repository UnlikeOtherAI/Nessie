/**
 * Shared Tailwind class strings for the "Add MCP server" wizard steps. Kept in
 * one place so every step panel renders identical labels, inputs, and buttons.
 */

export const labelClass = [
  'text-[11px] font-semibold uppercase tracking-[0.18em]',
  'text-[color:var(--tx3)]',
].join(' ')

export const inputClass = [
  'admin-input mt-1',
  'bg-[var(--scrim)] px-3 py-2 text-sm text-[color:var(--on-accent)]',
  'focus:border-[color:var(--accent)] focus:outline-none',
].join(' ')

export const buttonPrimary = [
  'admin-button admin-button-primary',
  'disabled:cursor-not-allowed disabled:opacity-40',
].join(' ')

export const buttonGhost = [
  'admin-button border border-[color:var(--sep)]',
  'px-4 py-2 text-sm text-[color:var(--tx2)] hover:bg-[var(--overlay-weak)]',
].join(' ')
