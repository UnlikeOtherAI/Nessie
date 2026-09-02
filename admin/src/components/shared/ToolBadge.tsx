import type { ToolRegistrySource } from '@nessie/schemas'

/**
 * `ToolBadge` is the canonical pill used wherever a tool surface is presented
 * to the user. It distinguishes the source family (builtin vs custom vs
 * MCP-remote vs executor vs interactive-session) using a stable colour ramp so users can
 * scan a long mixed list without reading every word.
 *
 * Mandated by `docs/provider-system-and-frontend-architecture.md` §8 (Tool*
 * components must exist as primitives, not page-local fragments).
 */
type ToolBadgeProps = {
  label: string
  source?: ToolRegistrySource
}

// Unconverted, reassessed against `outline` and `height="control"` (2026-09-01):
// neither closes the gap. Four of five sources now match a `Pill` tone exactly
// (`custom`→warning, `executor`/`interactive-session`→info, `mcp-remote`→accent
// on `--thinking`) — only `builtin`/the fallback still needs a plain `--accent`
// foreground, which no tone emits (`accent` is pinned to `--thinking`, the
// second accent-family colour this ramp also needs). Splitting the ramp across
// `Pill` for four sources and raw markup for the fifth would put two chip sizes
// in one list, so the whole ramp stays here. Shared with `ToolCategoryIcon`,
// which reads this map rather than keeping its own copy.
export const TOOL_SOURCE_TONE_CLASS: Record<ToolRegistrySource, string> = {
  'builtin': 'bg-[color:var(--accent-soft)] text-[color:var(--accent)]',
  'custom': 'bg-[color:var(--warning-soft)] text-[color:var(--warning-text)]',
  'executor': 'bg-[color:var(--info-soft)] text-[color:var(--info-text)]',
  'mcp-remote': 'bg-[color:var(--accent-soft)] text-[color:var(--thinking)]',
  'interactive-session': 'bg-[color:var(--info-soft)] text-[color:var(--info-text)]',
}

export const ToolBadge = ({ label, source }: ToolBadgeProps) => {
  const styles = source
    ? TOOL_SOURCE_TONE_CLASS[source]
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
