import type { ReactNode } from 'react'

/**
 * The admin's one chip. Always renders a `<span>`, which is what every chip it
 * replaced shipped. Keep it that way: a chip that needs to be a block outside a
 * flex/grid row is a layout box wrapping a chip, not a new Pill.
 */
export type PillTone = 'accent' | 'danger' | 'info' | 'muted' | 'outline' | 'success' | 'warning'

export type PillSize = 'md' | 'sm'

/**
 * `auto` sizes to its content, which is what a chip beside a heading wants.
 * `control` pins 24px so a column of chips in a list lines up with the rows
 * beside it — `DeepWaterRunHistory` hand-rolled its own chip for exactly this
 * and said so, and every status column in a `DataTable` needs it too.
 */
export type PillHeight = 'auto' | 'control'

/**
 * Two shapes, because the admin ships two and only two: the `capsule` status
 * pill that sits beside a heading, and the 4px `chip` that sits inline in a
 * dense row. Anything else is a third look-alike and belongs in neither.
 */
export type PillRadius = 'capsule' | 'chip'

type PillProps = {
  children: ReactNode
  className?: string
  height?: PillHeight
  radius?: PillRadius
  size?: PillSize
  tone?: PillTone
  uppercase?: boolean
}

/**
 * This map is the map of the removed `StatusPill` verbatim — the primitive
 * `Pill` generalises, imported by twenty files before this consolidation. Nothing here is a new colour decision,
 * so those twenty call sites are pixel-identical.
 *
 * `accent` therefore stays on `--thinking`, the accent-family *foreground* each
 * theme tunes to sit on `--accent-soft`; `--accent` is the fill token, and on
 * the dark themes (`--accent: #047857`, `#0e7490`, `#64748b`) it is too close to
 * its own 16%-alpha wash to read. Fourteen accent chips shipped
 * on `--thinking` (every `StatusPill tone="accent"`, plus the hand-written
 * `--accent-soft`/`--thinking` pairs in `DeepWaterRunHistory`, `signal-format`,
 * `MessageUiCards`, `MemberAgentRow`, and `app-trust`). Four shipped on
 * `--accent` instead and stay unconverted, because one tone cannot emit both:
 * `ToolBadge` (whose `mcp-remote` chip is the second accent colour in its own
 * ramp), `AgentDraftBadge`, and `SecuritySettingsPage`'s "This device".
 *
 * `muted` collapses the neutral fills onto `--overlay-weak`/`--tx3` for the same
 * reason: that is the pair `StatusPill` shipped, so the `--overlay`/`--tx2`
 * chips (`signal-format`, `MessageUiCards`, `KanbanCard`, `IntegrationsPage`)
 * join it rather than it joining them. A `--scrim` fill does not: it darkens
 * where `--overlay-weak` lightens, so `ToolTransportPill` stays unconverted.
 *
 * `outline` (2026-09-01) is the border-only chip this map used to name as an
 * unconvertible holdout: eight sites — seven across `billing/*` and one in
 * `ExecutorDetailPanels` — each carried a comment reading "Unconverted:
 * border-only chip; Pill bordered+muted adds an `--overlay-weak` fill". It is
 * the same `--sep`/`--tx2` pair all eight hand-wrote, so they are now
 * pixel-identical through this component. `info` completes the state family
 * (`--info-*` is declared by every theme) so a neutral-but-not-quiet chip does
 * not have to borrow `accent`.
 */
const toneClasses: Record<PillTone, string> = {
  accent: 'bg-[color:var(--accent-soft)] text-[color:var(--thinking)]',
  danger: 'bg-[color:var(--danger-soft)] text-[color:var(--danger-text)]',
  info: 'bg-[color:var(--info-soft)] text-[color:var(--info-text)]',
  muted: 'bg-[color:var(--overlay-weak)] text-[color:var(--tx3)]',
  outline: 'border border-[color:var(--sep)] text-[color:var(--tx2)]',
  success: 'bg-[color:var(--success-soft)] text-[color:var(--success-text)]',
  warning: 'bg-[color:var(--warning-soft)] text-[color:var(--warning-text)]',
}

const heightClasses: Record<PillHeight, string> = {
  auto: '',
  control: 'h-6',
}

const sizeClasses: Record<PillSize, string> = {
  md: 'px-2.5 py-1 text-[11px]',
  sm: 'px-2 py-0.5 text-[10px]',
}

const radiusClasses: Record<PillRadius, string> = {
  capsule: 'rounded-full',
  chip: 'rounded',
}

/**
 * Casing is one decision, not three: uppercase implies the wide tracking that
 * keeps a shouted label readable and the heavier weight that lets it survive
 * being small, so the component sets all three together. That is the majority
 * rule rather than an invention — every `StatusPill` chip shipped
 * `font-semibold uppercase tracking-[0.16em]`, and so did `ToolBadge`, the
 * kanban chips and the member-row chips. The uppercase labels that shipped at
 * regular weight (`ToolPermissionPill`, `MemberUserRow`, `StatusSection`,
 * `ApprovalsPage`, `AuditLogPage`, `PolicyPage`, `ProjectBacklogTab`,
 * `OpsHealthPage`, `SettingsMembersPage`, `WorkspaceMembersSection`,
 * `BudgetManager`) gain it.
 *
 * A sentence-case pill carries a real word or a person's name and gets none of
 * the three: tracking would push it past the width it has to fit in, and the
 * weight belongs to the caller (pass `font-semibold` through `className` where
 * the original chip was bold). No call site may set a weight alongside
 * `uppercase` — that would be a second, contradicting rule.
 */
const casingClasses: Record<'sentence' | 'uppercase', string> = {
  sentence: '',
  uppercase: 'uppercase font-semibold tracking-[0.16em]',
}

export const Pill = ({
  children,
  className,
  height = 'auto',
  radius = 'capsule',
  size = 'md',
  tone = 'muted',
  uppercase = true,
}: PillProps) => (
  <span
    className={[
      'inline-flex items-center',
      radiusClasses[radius],
      sizeClasses[size],
      heightClasses[height],
      toneClasses[tone],
      casingClasses[uppercase ? 'uppercase' : 'sentence'],
      className ?? '',
    ]
      .filter(Boolean)
      .join(' ')}
  >
    {children}
  </span>
)
