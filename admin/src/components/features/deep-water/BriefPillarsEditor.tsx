import { faArrowDown, faArrowUp, faXmark } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { SectionLabel } from '../../primitives/SectionLabel'
import { Input } from '../../shared/FormControls'
import { PILLAR_MAX_LENGTH, PILLARS_MAX, pillarsProblem } from './brief-edits'

/**
 * The research's pillars, in order — each becomes a chapter of the report
 * (contract §3). The planner proposes them; the person may rewrite, reorder,
 * add or remove any of them, and the whole list rides on their next reply or
 * on Start. Read-only for anyone who cannot edit the brief.
 */

const iconButton = [
  'flex h-8 w-8 flex-shrink-0 items-center justify-center rounded text-[color:var(--tx3)]',
  'hover:bg-[color:var(--overlay)] hover:text-[color:var(--tx)] disabled:opacity-40',
].join(' ')

const move = (list: string[], from: number, to: number): string[] => {
  const next = [...list]
  const [item] = next.splice(from, 1)
  if (item !== undefined) next.splice(to, 0, item)
  return next
}

export const BriefPillarsEditor = ({
  edited,
  editable,
  onChange,
  onReset,
  pillars,
}: {
  edited: boolean
  editable: boolean
  onChange: (pillars: string[]) => void
  onReset: () => void
  pillars: string[]
}) => {
  const problem = edited ? pillarsProblem(pillars) : null
  return (
    <section aria-label="Pillars" className="flex flex-col gap-2" data-testid="research-brief-pillars">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3><SectionLabel as="span" size="sm">Pillars</SectionLabel></h3>
          <p className="text-xs text-[color:var(--tx3)]">Each pillar becomes a chapter.</p>
        </div>
        {edited ? (
          <span className="flex items-center gap-2 text-xs text-[color:var(--tx2)]">
            Not sent yet
            <button className="underline" onClick={onReset} type="button">Undo</button>
          </span>
        ) : null}
      </div>

      {pillars.length === 0 && !editable ? (
        <p className="text-sm text-[color:var(--tx3)]">No pillars yet.</p>
      ) : null}

      {editable ? (
        <ol className="flex flex-col gap-1.5">
          {pillars.map((pillar, index) => (
            // Position is the identity while editing: two pillars may read the same.
            <li className="flex items-center gap-1" key={index}>
              <span className="w-5 flex-shrink-0 text-right text-xs tabular-nums text-[color:var(--tx3)]">
                {index + 1}.
              </span>
              <Input
                aria-label={`Pillar ${index + 1}`}
                maxLength={PILLAR_MAX_LENGTH}
                onChange={(event) =>
                  onChange(pillars.map((entry, at) => (at === index ? event.target.value : entry)))}
                size="compact"
                value={pillar}
              />
              <button
                aria-label={`Move pillar ${index + 1} up`}
                className={iconButton}
                disabled={index === 0}
                onClick={() => onChange(move(pillars, index, index - 1))}
                type="button"
              >
                <FontAwesomeIcon className="h-3 w-3" icon={faArrowUp} />
              </button>
              <button
                aria-label={`Move pillar ${index + 1} down`}
                className={iconButton}
                disabled={index === pillars.length - 1}
                onClick={() => onChange(move(pillars, index, index + 1))}
                type="button"
              >
                <FontAwesomeIcon className="h-3 w-3" icon={faArrowDown} />
              </button>
              <button
                aria-label={`Remove pillar ${index + 1}`}
                className={iconButton}
                onClick={() => onChange(pillars.filter((_, at) => at !== index))}
                type="button"
              >
                <FontAwesomeIcon className="h-3 w-3" icon={faXmark} />
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm text-[color:var(--tx)]">
          {pillars.map((pillar, index) => (
            <li key={index}>{pillar}</li>
          ))}
        </ol>
      )}

      {editable ? (
        <div>
          <button
            className="admin-button admin-button-secondary admin-button-compact"
            disabled={pillars.length >= PILLARS_MAX}
            onClick={() => onChange([...pillars, ''])}
            type="button"
          >
            Add pillar
          </button>
        </div>
      ) : null}
      {problem ? <p className="text-xs text-[color:var(--danger-text)]" role="alert">{problem}</p> : null}
    </section>
  )
}
