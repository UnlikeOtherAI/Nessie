import type { ToolRegistryTransport } from '@nessie/schemas'

/**
 * `ToolTransportPill` shows the wire transport (direct/mcp/http/stdio/pty/executor) a
 * tool uses, so admins can tell at a glance whether they're about to grant an
 * agent something local vs remote vs subprocess.
 *
 * Per §8 of provider-system-and-frontend-architecture.md.
 */
type ToolTransportPillProps = {
  transport: ToolRegistryTransport
}

const TRANSPORT_LABELS: Record<ToolRegistryTransport, string> = {
  direct: 'direct',
  executor: 'executor',
  mcp: 'mcp',
  http: 'http',
  stdio: 'stdio',
  pty: 'pty',
}

// Unconverted, reassessed against `outline` and `height="control"` (2026-09-01):
// this chip's fill is --scrim, a darkening wash; Pill's muted tone paints
// --overlay-weak, a lightening one, flipping polarity on dark themes. `outline`
// does not fit either — it carries no fill at all, and this chip's filled
// look (distinct from the bordered-only rows around it) is what keeps a
// transport chip legible against a dense list of directly-styled rows.
export const ToolTransportPill = ({ transport }: ToolTransportPillProps) => (
  <span
    className={[
      'inline-flex rounded-full border border-[color:var(--sep)]',
      'bg-[color:var(--scrim)] px-3 py-1 text-[11px] uppercase',
      'tracking-[0.18em] text-[color:var(--tx2)]',
    ].join(' ')}
  >
    {TRANSPORT_LABELS[transport]}
  </span>
)
