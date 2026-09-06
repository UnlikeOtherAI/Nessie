import type { ToolCallEntry } from '@nessie/schemas';
import { toolCallOutcomeTone } from '../../shared/agent-presentation';
import { Card } from '../../shared/Card';
import { EmptyState } from '../../shared/EmptyState';
import { Pill } from '../../primitives/Pill';
import { SectionLabel } from '../../primitives/SectionLabel';

type ToolExecutionLogProps = {
  entries: ToolCallEntry[];
};

const compactPreview = (value: string, maxLength = 160): string => {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength - 1)}…`;
};

export const ToolExecutionLog = ({ entries }: ToolExecutionLogProps) => (
  <section className="grid gap-3">
    <SectionLabel>Tool execution log</SectionLabel>
    {entries.length === 0 ? (
      <EmptyState>No tool calls recorded for this agent yet.</EmptyState>
    ) : (
      entries.map((entry) => (
        <Card key={`${entry.runId}:${entry.toolName}:${entry.startedAt}`}>
          <div className="flex items-center justify-between gap-3">
            <div className="font-mono text-sm text-[var(--thinking)]">{entry.toolName}</div>
            <Pill tone={toolCallOutcomeTone(entry.success)}>
              {entry.success === undefined ? 'running' : entry.success ? 'success' : 'failed'}
            </Pill>
          </div>
          <div className="mt-2 text-xs uppercase tracking-[0.16em] text-[color:var(--tx3)]">
            {entry.durationMs ? `${entry.durationMs} ms` : 'active'}
          </div>
          <div className="mt-3 text-sm leading-6 text-[color:var(--tx2)]">
            {compactPreview(entry.outputPreview ?? entry.inputSummary)}
          </div>
        </Card>
      ))
    )}
  </section>
);
