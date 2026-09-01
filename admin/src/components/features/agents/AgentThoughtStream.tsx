import { SectionLabel } from '../../primitives/SectionLabel';

export const AgentThoughtStream = () => (
  <div className="rounded-xl border border-dashed border-[color:var(--sep)] bg-[var(--overlay-weak)] p-4">
    <SectionLabel>Thought stream</SectionLabel>
    <p className="mt-3 text-sm leading-6 text-[color:var(--tx2)]">
      Reasoning trace available in a future release.
    </p>
  </div>
);
