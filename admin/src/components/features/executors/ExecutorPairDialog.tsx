import { useMemo, useState } from 'react'
import {
  executorPairingOriginLabel,
  type ExecutorCreateResponse,
} from '@nessie/schemas'
import type { AgentRecord, ProjectRecord, UserRecord } from '../../../lib/api-client'
import { getExecutorApiOrigin } from '../../../lib/api-client'
import { buildPairingCommand } from '../../../lib/executor-pairing'
import { Dialog } from '../../shared/Dialog'
import { FormActions } from '../../shared/FormActions'
import { ExecutorCreatePanel } from './ExecutorCreatePanel'
import { ExecutorDesktopCompanionPanel } from './ExecutorDesktopCompanionPanel'

type ExecutorPairDialogProps = {
  agents: AgentRecord[]
  currentUserId: string
  /** A project's "add executor" doorway pins the scope it opened from. */
  fixedProjectId?: string
  onClose: () => void
  /** Called once the person is finished with the pairing instructions. */
  onFinished: (created: ExecutorCreateResponse) => void
  open: boolean
  organizationId: string
  projects: ProjectRecord[]
  users: UserRecord[]
}

/**
 * Pairing an executor, start to finish, in one modal: the scope-and-access form,
 * then the instructions for the machine that is about to be trusted.
 *
 * Both steps live here because the invitation only exists between them — it is
 * returned by the create call, never re-fetchable, and expires. A form that
 * closed on success would leave the one copy of the pairing command behind.
 */
export const ExecutorPairDialog = ({
  agents,
  currentUserId,
  fixedProjectId,
  onClose,
  onFinished,
  open,
  organizationId,
  projects,
  users,
}: ExecutorPairDialogProps) => {
  const [created, setCreated] = useState<ExecutorCreateResponse | null>(null)

  // The state directory is not a free choice, so the command is built where a
  // test can hold it against the systemd unit itself — see
  // `lib/executor-pairing.ts`.
  // One resolution of the origin, used by the command and named on screen
  // beside it: the `--api` in a command nobody reads is not the same as being
  // told which server this machine is about to trust.
  const pairingOrigin = useMemo(
    () => created ? getExecutorApiOrigin(created.invitation.apiBaseUrl) : null,
    [created],
  )
  const pairingCommand = useMemo(() => created && pairingOrigin
    ? buildPairingCommand({
      apiOrigin: pairingOrigin,
      challenge: created.invitation.challenge,
      enrollmentId: created.invitation.enrollmentId,
      executorId: created.executor.id,
    })
    : null, [created, pairingOrigin])

  const close = () => {
    setCreated(null)
    onClose()
  }

  return (
    <Dialog
      description={created
        ? 'Run this on the machine you are pairing, or pair it from the desktop companion below.'
        : 'Scope cannot be changed after pairing. A private executor can be shared with any exact '
          + 'combination of people and agents, but only its assigned people can administer that list.'}
      onClose={close}
      open={open}
      size="lg"
      title={created ? 'Finish pairing' : 'Pair an executor'}
    >
      {created ? (
        <div className="grid gap-4">
          {pairingCommand && pairingOrigin ? (
            <section className="grid gap-2 rounded-lg border border-[color:var(--accent)] p-3">
              <p className="text-xs text-[color:var(--tx3)]">
                This pairs the machine with{' '}
                <span className="font-semibold text-[color:var(--tx)]">
                  {executorPairingOriginLabel(pairingOrigin)}
                </span>
                {' · '}
                <code className="rounded bg-[color:var(--overlay-weak)] px-1 py-0.5 text-[color:var(--tx2)]">{pairingOrigin}</code>
                . Confirm that host alongside the fingerprint the companion prints: the fingerprint
                says a key belongs to that machine, the host says which Nessie it now talks to.
              </p>
              <p className="text-xs text-[color:var(--tx3)]">Replace the workspace placeholder with one existing absolute directory. The companion stores its canonical root and machine key in owner-only state, and can only read bounded files under that root. This invitation expires at {created.invitation.expiresAt}.</p>
              <p className="text-xs text-[color:var(--tx3)]">This command is the Linux package’s: its systemd service reads that exact state directory, so pairing anywhere else leaves the service unable to start. On macOS, pair from the desktop companion below instead. On Windows the service owns its own state under <code>%ProgramData%\Nessie Executor</code> and pairs itself.</p>
              <p className="text-xs text-[color:var(--tx3)]">Supported platforms: macOS 15+ on Apple Silicon, Ubuntu Linux x86_64, Windows 11/10 x86_64 (Windows and Linux support arrive with their releases).</p>
              <code className="overflow-x-auto rounded bg-[color:var(--overlay-weak)] p-2 text-xs text-[color:var(--tx)]">{pairingCommand}</code>
            </section>
          ) : null}

          <ExecutorDesktopCompanionPanel created={created} />

          <FormActions>
            <button
              className="admin-button admin-button-primary"
              onClick={() => {
                const finished = created
                setCreated(null)
                onFinished(finished)
              }}
              type="button"
            >
              Open this executor
            </button>
          </FormActions>
        </div>
      ) : (
        <ExecutorCreatePanel
          agents={agents}
          currentUserId={currentUserId}
          fixedProjectId={fixedProjectId}
          onCancel={close}
          onCreated={setCreated}
          organizationId={organizationId}
          projects={projects}
          users={users}
        />
      )}
    </Dialog>
  )
}
