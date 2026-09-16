/**
 * The programs a local policy permits `command.run` to start.
 *
 * It exists as one component because it has to say the same sentence in both
 * places a person decides about a policy — the proposal list and the prepared
 * descriptor-review card — and because the two states it distinguishes are
 * easy to render alike by accident:
 *
 * - a list names the programs, and the reviewer approves those;
 * - no list at all means the descriptor never named one, so the executor runs
 *   nothing through `command.run`. That is not "no restriction", and the
 *   sentence has to rule that reading out rather than leaving a blank line.
 *
 * An empty list cannot arrive: the descriptor contract carries the field only
 * when it names a program.
 */
export type ExecutorPermittedProgramsProps = {
  commandAllowlist?: readonly string[]
  operationKeys: readonly string[]
}

export const ExecutorPermittedPrograms = ({
  commandAllowlist,
  operationKeys,
}: ExecutorPermittedProgramsProps) => {
  const permitsCommandRun = operationKeys.includes('command.run')
  // Nothing to say: this proposal offers no command execution and named no
  // program, so there is no approval decision the list would inform.
  if (!commandAllowlist && !permitsCommandRun) return null
  return commandAllowlist
    ? (
      <p className="mt-1 text-[color:var(--tx2)]">
        <span className="font-medium text-[color:var(--tx)]">
          Permitted programs ({commandAllowlist.length}):
        </span>{' '}
        {commandAllowlist.join(', ')}
        {permitsCommandRun ? null : ' (this proposal does not enable command.run)'}
      </p>
    )
    : (
      <p className="mt-1 text-[color:var(--warning-text)]">
        <span className="font-medium">Permitted programs: none named.</span>{' '}
        This proposal enables command.run but names no program, so the executor
        can run nothing until its local policy names one.
      </p>
    )
}
