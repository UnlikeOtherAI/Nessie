import { Link } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { ApiClientError } from '@nessie/client-core'
import { useEnrollLocalInferenceDesktopHost, useLocalInferenceHosts } from '../../../facades/local-inference/hooks'
import { LocalInferenceHostStatus } from '../../../components/features/local-inference/LocalInferenceHostStatus'
import { SectionLabel } from '../../../components/primitives/SectionLabel'
import { isDesktopApp } from '../../../lib/desktop'
import {
  prepareLocalInferenceDesktopEnrollment,
  rotateLocalInferenceDesktopMachineKey,
  startLocalInferenceDirectHost,
} from '../../../lib/local-inference-desktop'

/** Own-host status and repairs. A browser is deliberately never offered a local scan. */
export const LocalOllamaSection = () => {
  const hosts = useLocalInferenceHosts()
  const enroll = useEnrollLocalInferenceDesktopHost()
  const [actionError, setActionError] = useState<string | null>(null)
  const [startingHostId, setStartingHostId] = useState<string | null>(null)

  useEffect(() => {
    if (!startingHostId) return
    const host = hosts.data?.hosts.find((candidate) => candidate.id === startingHostId)
    if (host?.availability === 'online' && host.models.length > 0) setStartingHostId(null)
  }, [hosts.data?.hosts, startingHostId])

  const prepareDesktop = async () => {
    setActionError(null)
    try {
      let enrollment = await prepareLocalInferenceDesktopEnrollment()
      let host
      try {
        host = await enroll.mutateAsync({ displayLabel: 'Nessie Desktop', publicKey: enrollment.publicKey })
      } catch (error) {
        if (!(error instanceof ApiClientError) || error.code !== 'KEY_ROTATION_REQUIRED') throw error
        enrollment = await rotateLocalInferenceDesktopMachineKey()
        host = await enroll.mutateAsync({ displayLabel: 'Nessie Desktop', publicKey: enrollment.publicKey })
      }
      await startLocalInferenceDirectHost(host)
      setStartingHostId(host.hostId)
      await hosts.refetch()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Nessie could not prepare this computer.')
    }
  }

  return (
    <section className="grid gap-4">
      <div>
        <SectionLabel as="h2">Local Ollama</SectionLabel>
        <p className="mt-1 text-sm leading-6 text-[color:var(--tx2)]">
          Run your own agents on a model installed on your own computer. Nessie Desktop or a paired executor
          discovers Ollama there after you give that computer permission; this browser never scans your device.
        </p>
      </div>
      {startingHostId ? (
        <p className="text-sm text-[color:var(--tx2)]" role="status">
          Looking for local Ollama models on this computer. Keep Nessie Desktop and Ollama open; this connection
          will appear when a local chat model is verified.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        {isDesktopApp() ? (
          <button
            className="admin-button admin-button-secondary"
            disabled={enroll.isPending}
            onClick={() => void prepareDesktop()}
            type="button"
          >
            {enroll.isPending ? 'Preparing this computer…' : 'Prepare this computer'}
          </button>
        ) : null}
        <Link className="text-sm text-[color:var(--lnk)] hover:underline" to="/agents/executors">
          Open paired executors
        </Link>
      </div>
      {actionError ? <p className="text-sm text-[color:var(--danger-text)]" role="alert">{actionError}</p> : null}
      <LocalInferenceHostStatus
        empty={(
          <p className="text-sm text-[color:var(--tx2)]">
            No local computer is connected yet. On this computer, prepare Nessie Desktop; on another computer,
            {' '}<Link className="underline" to="/agents/executors">open its paired executor</Link>. Once it reports a
            local model, select it from an <Link className="underline" to="/agents">agent’s Model section</Link>.
          </p>
        )}
      />
    </section>
  )
}
