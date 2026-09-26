// One spelling of every address a paired computer has, so a table row, a
// session link, an alert and a pairing that just finished all land on the same
// screens (Admin › Computers).

export const COMPUTERS_PATH = '/admin/computers'

export const COMPUTER_SESSIONS_PATH = '/admin/computers/sessions'

/** A computer's own screen, whichever list or card opened it. */
export const computerPath = (executorId: string): string =>
  `${COMPUTERS_PATH}/${encodeURIComponent(executorId)}`

/** One coding session on a computer, as its viewer. */
export const computerSessionPath = (executorId: string, sessionId: string): string =>
  `${computerPath(executorId)}/sessions/${encodeURIComponent(sessionId)}`
