import { useCallback, useEffect, useRef, useState } from 'react'
import {
  CHAT_MESSAGE_MAX_CHARS,
  type ExecutorAvailabilityCandidate,
  type ExecutorOperationKey,
} from '@nessie/schemas'

import type { AgentRecord } from '../../../lib/api-client'
import {
  useExecutorAvailability,
  useLaunchExecutorRun,
} from '../../../facades/executors/hooks'
import { useModalA11y } from '../../shared/useModalA11y'

type ExecutorRunLauncherDialogProps = {
  agents: AgentRecord[]
  initialContent: string
  onClose: () => void
  onLaunched: () => void
  open: boolean
  projectId?: string
  threadId?: string
}

type OperationOption = {
  description: string
  label: string
  operationKeys: ExecutorOperationKey[]
  value: string
}

// Each selection binds only the exact reviewed operation bundle. The companion
// never infers a related privilege just because the user permitted a draft.
const operationOptions: OperationOption[] = [
  {
    description: 'Let the selected agent inspect the names of files in its paired workspace.',
    label: 'List workspace files',
    operationKeys: ['file.list'],
    value: 'file.list',
  },
  {
    description: 'Let the selected agent read a named file from its paired workspace.',
    label: 'Read a workspace file',
    operationKeys: ['file.read'],
    value: 'file.read',
  },
  {
    description: 'Let the selected agent create a copy-on-write draft; it cannot alter the paired root.',
    label: 'Write a sandbox draft',
    operationKeys: ['file.write'],
    value: 'file.write',
  },
  {
    description: 'Let the selected agent write a draft and produce a read-only change manifest for human review.',
    label: 'Write and review a sandbox draft',
    operationKeys: ['file.write', 'workspace.review'],
    value: 'file.write+workspace.review',
  },
  {
    description: 'Let the selected agent open and inspect one site allowed by the executor owner; it cannot click, fill forms, or read page content. Confirm the site with that human owner first: the local origin ceiling is not uploaded to Nessie.',
    label: 'Browse an approved site',
    operationKeys: ['browser.open', 'browser.observe', 'sandbox.stop'],
    value: 'browser.open+browser.observe+sandbox.stop',
  },
  {
    description: 'Start one isolated Codex task in the paired guest. Its ChatGPT login remains inside the guest; Nessie receives lifecycle state and a read-only workspace review, never terminal output.',
    label: 'Work in a managed Codex session',
    operationKeys: ['coding.launch', 'coding.observe', 'workspace.review', 'sandbox.stop'],
    value: 'coding.launch+coding.observe+workspace.review+sandbox.stop',
  },
]

const scopeLabel = (scopeKind: ExecutorAvailabilityCandidate['scopeKind']): string => {
  switch (scopeKind) {
    case 'private': return 'Private executor'
    case 'project': return 'Project executor'
    case 'organization': return 'Organization executor'
  }
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : 'Unable to check executor availability.'

/**
 * Human-only execution doorway. A person picks a bound agent and an opaque
 * ready choice; server-side binding revalidates every grant at commit time.
 */
export const ExecutorRunLauncherDialog = ({
  agents,
  initialContent,
  onClose,
  onLaunched,
  open,
  projectId,
  threadId,
}: ExecutorRunLauncherDialogProps) => {
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const {
    isPending: isCheckingAvailability,
    mutateAsync: resolveAvailability,
  } = useExecutorAvailability()
  const launch = useLaunchExecutorRun()
  const [agentId, setAgentId] = useState('')
  const [operationValue, setOperationValue] = useState('file.list')
  const [content, setContent] = useState('')
  const [candidates, setCandidates] = useState<ExecutorAvailabilityCandidate[]>([])
  const [explanation, setExplanation] = useState<string | null>(null)
  const [availabilityError, setAvailabilityError] = useState<string | null>(null)
  const [selectedHandle, setSelectedHandle] = useState('')
  const close = useCallback(() => onClose(), [onClose])
  useModalA11y(dialogRef, close)

  useEffect(() => {
    if (!open) return
    setAgentId(agents[0]?.id ?? '')
    setOperationValue('file.list')
    setContent(initialContent)
    setCandidates([])
    setExplanation(null)
    setAvailabilityError(null)
    setSelectedHandle('')
  }, [agents, initialContent, open])

  useEffect(() => {
    if (!open || !agentId) return
    let cancelled = false
    setCandidates([])
    setExplanation(null)
    setAvailabilityError(null)
    setSelectedHandle('')
    const option = operationOptions.find((entry) => entry.value === operationValue)
    if (!option) return
    void resolveAvailability({
      agentId,
      operationKeys: option.operationKeys,
      projectId,
    }).then((response) => {
      if (cancelled) return
      const eligible = response.candidates.filter((candidate) => (
        option.operationKeys.every((key) => candidate.operationKeys.includes(key))
      ))
      setCandidates(eligible)
      setExplanation(
        eligible.length === 0
          ? response.explanations[0]?.reason.replaceAll('_', ' ') ?? 'No eligible executor is online.'
          : null,
      )
      const onlyCandidate = eligible.length === 1 ? eligible[0] : undefined
      if (onlyCandidate) {
        setSelectedHandle(onlyCandidate.handle)
      }
    }).catch((error: unknown) => {
      if (!cancelled) setAvailabilityError(errorMessage(error))
    })
    return () => { cancelled = true }
  }, [agentId, open, operationValue, projectId, resolveAvailability])

  const selectedOperation = operationOptions.find((option) => option.value === operationValue)
  const canLaunch = Boolean(
    threadId && agentId && selectedHandle && content.trim() && selectedOperation,
  ) && !launch.isPending

  const submit = async () => {
    if (!canLaunch || !threadId || !selectedOperation) return
    try {
      await launch.mutateAsync({
        agentId,
        candidateHandle: selectedHandle,
        content: content.trim(),
        operationKeys: selectedOperation.operationKeys,
        threadId,
      })
      onLaunched()
      close()
    } catch {
      // The mutation retains the API error and renders it beside the action.
    }
  }

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-[var(--scrim-strong)] p-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close()
      }}
      role="presentation"
    >
      <div
        aria-describedby="executor-run-launcher-description"
        aria-labelledby="executor-run-launcher-title"
        aria-modal="true"
        className="w-full max-w-2xl rounded-xl border border-[var(--sep)] bg-[var(--panel)] shadow-2xl"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="flex items-start justify-between gap-4 border-b border-[var(--sep)] px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-[var(--tx)]" id="executor-run-launcher-title">
              Run on an executor
            </h2>
            <p className="mt-1 text-sm leading-6 text-[var(--tx2)]" id="executor-run-launcher-description">
              Choose a channel agent and a currently eligible executor capability. The executor is
              selected by scope only; its identity and other people’s access remain private.
            </p>
          </div>
          <button
            aria-label="Close executor launcher"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-[var(--tx3)] hover:bg-[var(--overlay)] hover:text-[var(--tx)]"
            onClick={close}
            type="button"
          >
            ×
          </button>
        </header>

        <div className="grid gap-4 p-5">
          <label className="grid gap-1 text-sm">
            <span className="font-semibold text-[var(--tx2)]">Agent</span>
            <select
              aria-label="Executor run agent"
              className="admin-input"
              onChange={(event) => setAgentId(event.target.value)}
              value={agentId}
            >
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>{agent.name}</option>
              ))}
            </select>
          </label>

          <label className="grid gap-1 text-sm">
            <span className="font-semibold text-[var(--tx2)]">Capability</span>
            <select
              aria-label="Executor capability"
              className="admin-input"
              onChange={(event) => setOperationValue(event.target.value)}
              value={operationValue}
            >
              {operationOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            <span className="text-xs leading-5 text-[var(--tx3)]">{selectedOperation?.description}</span>
          </label>

          <fieldset className="grid gap-2">
            <legend className="text-sm font-semibold text-[var(--tx2)]">Available executor</legend>
            {isCheckingAvailability ? <p className="text-sm text-[var(--tx3)]">Checking eligibility…</p> : null}
            {availabilityError ? <p className="text-sm text-[color:var(--danger-text)]" role="alert">{availabilityError}</p> : null}
            {explanation ? <p className="text-sm text-[var(--tx3)]">No executor ready: {explanation}.</p> : null}
              {candidates.map((candidate, index) => (
              <label
                className="flex cursor-pointer items-center gap-3 rounded-lg border border-[var(--sep)] px-3 py-2 text-sm text-[var(--tx2)] has-[:checked]:border-[var(--accent)] has-[:checked]:bg-[var(--accent-soft)]"
                key={candidate.handle}
              >
                <input
                  checked={selectedHandle === candidate.handle}
                  name="executor-choice"
                  onChange={() => setSelectedHandle(candidate.handle)}
                  type="radio"
                  value={candidate.handle}
                />
                <span>{scopeLabel(candidate.scopeKind)}{candidates.length > 1 ? ` ${index + 1}` : ''}</span>
                <span className="ml-auto text-xs text-[var(--tx3)]">Ready for 5 minutes</span>
              </label>
            ))}
          </fieldset>

          <label className="grid gap-1 text-sm">
            <span className="font-semibold text-[var(--tx2)]">Instruction</span>
            <textarea
              aria-label="Executor run instruction"
              className="admin-input min-h-28"
              maxLength={CHAT_MESSAGE_MAX_CHARS}
              onChange={(event) => setContent(event.target.value)}
              placeholder="Tell the selected agent what to inspect in the paired workspace."
              value={content}
            />
          </label>

          {launch.error ? (
            <p className="text-sm text-[color:var(--danger-text)]" role="alert">{errorMessage(launch.error)}</p>
          ) : null}

          <div className="flex justify-end gap-2">
            <button className="admin-button-secondary" onClick={close} type="button">Cancel</button>
            <button className="admin-button-primary" disabled={!canLaunch} onClick={() => void submit()} type="button">
              {launch.isPending ? 'Starting…' : 'Start executor run'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
