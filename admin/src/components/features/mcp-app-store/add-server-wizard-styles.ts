/**
 * Shared Tailwind class strings for the "Add MCP server" wizard steps. Kept in
 * one place so every step panel renders identical labels, inputs, and buttons.
 */

export const labelClass = [
  'text-[11px] font-semibold uppercase tracking-[0.18em]',
  'text-[color:var(--tx3)]',
].join(' ')

export const inputClass = [
  'admin-input mt-1 w-full rounded-md border border-[color:var(--sep)]',
  'bg-black/20 px-3 py-2 text-sm text-white',
  'focus:border-[color:var(--accent)] focus:outline-none',
].join(' ')

export const buttonPrimary = [
  'admin-button admin-button-primary rounded-md px-4 py-2 text-sm font-semibold',
  'disabled:cursor-not-allowed disabled:opacity-40',
].join(' ')

export const buttonGhost = [
  'admin-button rounded-md border border-[color:var(--sep)]',
  'px-4 py-2 text-sm text-[color:var(--tx2)] hover:bg-white/5',
].join(' ')
