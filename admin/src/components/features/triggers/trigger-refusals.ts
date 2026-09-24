/**
 * A `TRIGGER_CONFIG_REFUSED` answer, placed where the person has to fix it.
 *
 * The create and update routes refuse a ticket or document trigger field by
 * field: `error.details.refusals` is every `{ path, reason }`, with `path` the
 * config key it is about (`pickup.columns[0]`, `pageIds[2]`,
 * `instructions.general`) or a top-level one (`targetChannelId`). Each editor
 * says which roots it has a field for; whatever it cannot place is kept for
 * the form's banner, so no refusal is ever dropped.
 */

/** `pickup.columns[0]` → `pickup`. */
export const refusalRoot = (path: string): string => path.split(/[.[]/)[0] ?? ''

/** The field a refusal's path names, among `roots`, or null for one the editor has no field for. */
export const refusalFieldIn = <F extends string>(roots: readonly F[], path: string): F | null => {
  const root = refusalRoot(path)
  return (roots as readonly string[]).includes(root) ? (root as F) : null
}

export type TriggerFieldErrors<F extends string = string> = Partial<Record<F, string>>

export const groupTriggerRefusals = <F extends string>(
  details: unknown,
  fieldOf: (path: string) => F | null,
): { fields: TriggerFieldErrors<F>; rest: string[] } => {
  const refusals = details && typeof details === 'object' && Array.isArray((details as { refusals?: unknown }).refusals)
    ? (details as { refusals: unknown[] }).refusals
    : []
  const fields: TriggerFieldErrors<F> = {}
  const rest: string[] = []
  for (const refusal of refusals) {
    if (!refusal || typeof refusal !== 'object') continue
    const { path, reason } = refusal as { path?: unknown; reason?: unknown }
    if (typeof path !== 'string' || typeof reason !== 'string') continue
    const field = fieldOf(path)
    if (field) fields[field] = fields[field] ? `${fields[field]} ${reason}` : reason
    else rest.push(`${path}: ${reason}`)
  }
  return { fields, rest }
}
