import type { ToolRegistrySource } from '@nessie/schemas'

/**
 * `ToolBadge` is the canonical pill used wherever a tool surface is presented
 * to the user. It distinguishes the source family (builtin vs custom vs
 * MCP-remote vs interactive-session) using a stable colour ramp so users can
 * scan a long mixed list without reading every word.
 *
 * Mandated by `docs/provider-system-and-frontend-architecture.md` §8 (Tool*
 * components must exist as primitives, not page-local fragments).
 */
type ToolBadgeProps = {
  label: string
  source?: ToolRegistrySource
}

const SOURCE_STYLES: Record<ToolRegistrySource, string> = {
  'builtin': [
    'bg-[color:var(--accent-soft)] text-[color:var(--accent)]',
  ].join(' '),
  'custom': 'bg-[color:var(--warning-soft)] text-[color:var(--warning-text)]',
  'mcp-remote': 'bg-[color:var(--accent-soft)] text-[color:var(--thinking)]',
  'interactive-session': 'bg-[color:var(--info-soft)] text-[color:var(--info-text)]',
}

export const ToolBadge = ({ label, source }: ToolBadgeProps) => {
  const styles = source
    ? SOURCE_STYLES[source]
    : 'bg-[color:var(--accent-soft)] text-[color:var(--accent)]'

  return (
    <span
      className={[
        'inline-flex rounded-full px-3 py-1',
        'text-xs font-semibold uppercase tracking-[0.18em]',
        styles,
      ].join(' ')}
    >
      {label}
    </span>
  )
}
