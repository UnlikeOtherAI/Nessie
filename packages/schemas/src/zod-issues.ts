import type { ZodError } from 'zod'

/**
 * Renders a schema rejection as one sentence its reader can act on: an API
 * client gets the field it got wrong, a model gets the same in words instead of
 * an opaque 500 it would retry blindly.
 *
 * The two renderings differ and stay that way: a REST client reading
 * `body: <complaint>` and an agent reading `definition — <complaint>` are
 * different readers, so what a rootless issue is called and what separates a
 * path from its complaint are the caller's to state.
 */
export const formatZodIssues = (
  error: ZodError,
  options: { emptyPathLabel: string; separator: string },
): string =>
  error.issues
    .map((issue) => {
      const path = issue.path.join('.') || options.emptyPathLabel
      return `${path}${options.separator}${issue.message}`
    })
    .join('; ')
