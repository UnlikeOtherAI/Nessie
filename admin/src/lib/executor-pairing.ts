// The pairing command the Executors page hands a person to paste.
//
// It lives here, out of the page, because its `--state-dir` is not a matter of
// taste: the packaged systemd unit hard-codes the directory it will read, and
// `nessie-executor enable` refuses to supervise any other one rather than
// quietly starting a different executor. A page that prints a friendlier path
// therefore hands people a command that pairs successfully and then cannot be
// enabled — which is exactly what it did. Keeping the builder separate lets a
// test hold it against the unit file itself.

/** What `nessie-executor@.service` runs, with systemd's specifiers expanded. */
export const pairingStateDirectory = (executorId: string): string =>
  `$HOME/.local/state/nessie-executor/${executorId}`

export type PairingCommandInput = {
  apiOrigin: string
  challenge: string
  enrollmentId: string
  executorId: string
}

export const buildPairingCommand = ({
  apiOrigin,
  challenge,
  enrollmentId,
  executorId,
}: PairingCommandInput): string => [
  'nessie-executor pair',
  `--api ${apiOrigin}`,
  `--state-dir "${pairingStateDirectory(executorId)}"`,
  '--workspace "/absolute/read-only/workspace"',
  `--enrollment ${enrollmentId}`,
  `--challenge ${challenge}`,
].join(' ')
