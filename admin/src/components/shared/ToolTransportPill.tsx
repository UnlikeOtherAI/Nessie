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
