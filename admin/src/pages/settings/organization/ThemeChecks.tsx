import { contrastRatio, type EvaluatedTheme } from '@nessie/schemas'
import { Pill } from '../../../components/primitives/Pill'
import { SectionLabel } from '../../../components/primitives/SectionLabel'

/**
 * What this palette does to the text on it
 * (docs/plans/2026-09-05-organisation-custom-theme.md §7.5).
 *
 * The guaranteed ratios are shown as well as the failures, because "why is this
 * fine?" is as real a question as "why is this refused?", and a palette that
 * says nothing until it breaks teaches an administrator nothing about the one
 * they are building.
 *
 * Not a card: it sits beside one, and a bordered box never goes inside another.
 */

type Row = {
  detail?: string
  label: string
  ratio?: number
  tone: 'danger' | 'success' | 'warning'
}

const round1 = (value: number): number => Math.round(value * 10) / 10

export const ThemeChecks = ({ evaluated }: { evaluated: EvaluatedTheme }) => {
  const { tokens } = evaluated
  const guaranteed: Row[] = [
    { label: 'Text on background', ratio: contrastRatio(tokens.tx, tokens.main), tone: 'success' },
    {
      label: 'Secondary text on background',
      ratio: contrastRatio(tokens.tx3, tokens.main),
      tone: 'success',
    },
    { label: 'Link on background', ratio: contrastRatio(tokens.lnk, tokens.main), tone: 'success' },
    {
      label: 'Button label on accent',
      ratio: contrastRatio(tokens['on-accent'], tokens.accent),
      tone: 'success',
    },
  ]
  const measured: Row[] = evaluated.checks.map((check) => ({
    ...(check.message ? { detail: check.message } : {}),
    label: check.label,
    ...(check.ratio === undefined ? {} : { ratio: check.ratio }),
    tone: check.level === 'blocking' ? ('danger' as const) : ('warning' as const),
  }))
  // Only report the accent as passing when nothing above already said it fails.
  const accentReported = evaluated.checks.some((check) => check.id === 'accent-on-main')
  const rows = [
    ...guaranteed,
    ...(accentReported
      ? []
      : [{
        label: 'Accent on background',
        ratio: contrastRatio(tokens.accent, tokens.main),
        tone: 'success' as const,
      }]),
    ...measured,
  ]

  return (
    <section>
      <SectionLabel>Checks</SectionLabel>
      <ul className="mt-3 grid gap-2">
        {rows.map((row) => (
          <li className="flex items-start gap-3" key={`${row.label}-${row.tone}`}>
            <Pill tone={row.tone}>
              {row.ratio === undefined ? row.tone === 'danger' ? 'Blocked' : 'Check' : `${round1(row.ratio)}:1`}
            </Pill>
            <div className="min-w-0">
              <div className="text-sm text-[color:var(--tx)]">{row.label}</div>
              {row.detail ? (
                <div className="mt-0.5 text-sm text-[color:var(--tx2)]">{row.detail}</div>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
