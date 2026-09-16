/**
 * The folders a local policy exposes, by the name that starts every workspace
 * path an agent writes.
 *
 * It sits beside {@link ExecutorPermittedPrograms} for the same reason: adding
 * a folder changes `localPolicyDigest`, so it is a revision somebody approves,
 * and approving a digest you cannot read is not a review. Three states, and
 * none of them may render alike:
 *
 * - names listed — the reviewer approves reach into exactly those folders;
 * - no field at all — the descriptor was signed before folders had names, so it
 *   describes exactly one folder whose name this revision never stated. Silence
 *   here would read as "no folders", which is the opposite of the truth;
 * - more than one folder — worth saying plainly, because a guest VM mounts one
 *   workspace, so `command.run` and `coding.launch` refuse while several are
 *   configured.
 *
 * Host paths are deliberately absent. They stay on the machine: a reviewer of
 * an organisation-scoped executor approves reach by name, not somebody's home
 * directory layout.
 */
export type ExecutorReachableFoldersProps = {
  operationKeys: readonly string[]
  workspaceFolders?: readonly string[]
}

const GUEST_OPERATION_KEYS = ['command.run', 'coding.launch', 'coding.observe']

export const ExecutorReachableFolders = ({
  operationKeys,
  workspaceFolders,
}: ExecutorReachableFoldersProps) => {
  if (!workspaceFolders) {
    return (
      <p className="mt-1 text-[color:var(--tx2)]">
        <span className="font-medium text-[color:var(--tx)]">Folders:</span>{' '}
        one, named before this revision recorded folder names.
      </p>
    )
  }
  const refusesGuestSessions = workspaceFolders.length > 1
    && GUEST_OPERATION_KEYS.some((operationKey) => operationKeys.includes(operationKey))
  return (
    <p className="mt-1 text-[color:var(--tx2)]">
      <span className="font-medium text-[color:var(--tx)]">
        Folders ({workspaceFolders.length}):
      </span>{' '}
      {workspaceFolders.join(', ')}
      {refusesGuestSessions
        ? (
          <span className="text-[color:var(--warning-text)]">
            {' '}— a guest session mounts one folder, so command and coding
            operations refuse while more than one is configured.
          </span>
        )
        : null}
    </p>
  )
}
